/**
 * useRealtimeVoice — always-on conversational voice layer over OpenAI Realtime (WebRTC).
 *
 * Architecture (see project memory "voice architecture pivot"):
 *   - Voice is a RELAY. It converses, shares the agent's brain, and delegates
 *     execution via delegate_task → the real agent pipeline (sendMessage).
 *   - Always-on observer: voice runs simultaneously with the agent. Agent
 *     status changes are pushed into the voice conversation as context items
 *     so voice can report progress when asked.
 *   - The OpenAI key never enters the renderer — main mints an ephemeral
 *     token; this hook connects with only that token.
 *
 * Session lifecycle:
 *   connect() → mint token → RTCPeerConnection + oai-events data channel →
 *   SDP exchange with api.openai.com → live.
 *   Auto-reconnect with capped backoff on unexpected drops; the user-visible
 *   state machine always reaches a terminal state (never spins forever).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useProjectsStore } from "../stores/projects";
import { createWakeWordListener } from "../lib/wakeWordListener";
import { loadSettings } from "../lib/tauri-commands";

export type VoiceState =
  | "off" // feature disabled / no key
  | "standby" // session OPEN, mic detached — instant wake (warm standby)
  | "armed" // standby + local wake-word listener running — say the name
  | "idle" // connected, listening, not speaking
  | "connecting" // minting token + WebRTC setup
  | "listening" // user is speaking (VAD detected speech)
  | "thinking" // model generating (user turn ended)
  | "speaking" // model audio playing
  | "error"; // terminal failure — user must retry

export interface AgentStatusSnapshot {
  running: boolean;
  lastLine: string | null;
}

interface RealtimeEvent {
  // Per-response instructions are valid on response.create (accent
  // re-anchor after tool calls, Sep 2026): replaces session instructions
  // for that response only, so callers MUST pass the full minted blob —
  // accent block leading — never a bare fragment.
  instructions?: string;
  type: string;
  [key: string]: unknown;
}

/** A function call the model issued that hasn't been answered yet — kept
 *  across reconnects so it can be replayed into the fresh session (the
 *  server drops the channel right after function-call responses; without
 *  replay the call and its result vanish and the model never answers).
 *  `output` is set the moment the tool result is computed — even if the
 *  channel is already closed — because the send queue is cleared by
 *  teardown() but this map survives it. */
interface PendingCall {
  callId: string;
  name: string;
  argsJson: string;
  output?: string;
}

const PANE_MIC_KEY = "pane.micDeviceId";
// The renderer never invents accent text — the mint returns the accent as a
// structured field, and this hook only decides whether to re-send the
// confirmed blob at turn boundaries.

/** Reconnect backoff: 1s, 2s, 4s, 8s, 15s, 15s… capped. */
function backoffDelay(attempt: number): number {
  return Math.min(1000 * 2 ** attempt, 15000);
}

/** Device selection for voice capture.
 *
 *  Root cause of the "model ignores me" bug (Aug 2026): getUserMedia({audio:true})
 *  took the OS-default input, which was a Bluetooth SPEAKER whose mic endpoint
 *  delivers digital silence. This helper makes selection deliberate:
 *    1. the user's pinned device (localStorage), if it still exists;
 *    2. else the built-in mic (MacBook Microphone), which always works;
 *    3. else the first input that is not a speaker.
 *  Speakers are skipped — their "mic" endpoints are usually phantom.
 */
/** Classify a getUserMedia failure as a permission problem. Pure — module
 *  scope so every site (connect, wake) shares one definition. */
function isMicPermissionFailure(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    /Requested device not found/i.test(msg) ||
    /not ?allowed/i.test(msg) ||
    /permission denied/i.test(msg)
  );
}

async function acquireMic(pinnedId: string | null): Promise<MediaStream> {
  const devices = await navigator.mediaDevices.enumerateDevices();
  const inputs = devices.filter((d) => d.kind === "audioinput");
  const looksLikeSpeaker = (label: string): boolean =>
    /speaker|default\s*-/i.test(label);
  const looksBuiltIn = (label: string): boolean =>
    /macbook|built-?in|internal/i.test(label);

  const pinned =
    pinnedId ??
    (() => {
      try {
        return localStorage.getItem(PANE_MIC_KEY);
      } catch {
        return null;
      }
    })();

  const byId = (id: string | null): MediaDeviceInfo | undefined =>
    inputs.find((d) => d.deviceId === id);

  let chosen: MediaDeviceInfo | undefined;
  if (pinned && byId(pinned)) {
    chosen = byId(pinned); // explicit user choice always wins
  } else {
    chosen =
      inputs.find((d) => looksBuiltIn(d.label)) ??
      inputs.find((d) => !looksLikeSpeaker(d.label));
  }

  // Browser-side processing (interruption fix, Sep 2026): Chromium enables
  // echoCancellation/noiseSuppression/autoGainControl by default for
  // getUserMedia audio, but defaults are not contracts. Pin them so the
  // mic track that reaches the PeerConnection always has AEC (kills the
  // agent-hearing-itself loop on speakers) and NS (pre-scrubs keyboard/
  // fan transients) even if a future Chromium/Electron flag flips.
  const constraints: MediaStreamConstraints = chosen
    ? {
        audio: {
          deviceId: { exact: chosen.deviceId },
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      }
    : {
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      };
  vlog(
    "acquireMic — inputs:",
    inputs.map((d) => d.label || "(unnamed)").join(" | ") || "(none)",
    "→ choosing:",
    chosen?.label ?? "(default)",
  );
  const stream = await navigator.mediaDevices.getUserMedia(constraints);
  // Permission granted now; labels become real. Re-enumeration is cheap and
  // lets the picker show names after the first-ever capture.
  return stream;
}

/** Voice lifecycle log — main mirrors [voice] console lines to
 *  ~/.pane/voice-debug.log so production failures are diagnosable. */
function vlog(...parts: unknown[]): void {
  console.log("[voice]", ...parts);
}

export function useRealtimeVoice(opts: {
  /** Delegate work to a thread. Resolve the thread name (or null = active),
   *  deliver the instruction, and RETURN the projectId it landed in — the
   *  voice session tracks that thread for the completion report. */
  onDelegate: (
    instruction: string,
    phase: "think" | "build",
    thread?: string,
  ) => string | null;
}) {
  const { onDelegate } = opts;

  // ── The session is GLOBAL, not per-thread ─────────────────────────────
  // One session for all of Pane. The active thread is read from the store
  // imperatively — voice follows the user's attention instead of being born
  // inside one thread's component tree. (Aug 2026 lift: previously each
  // Conversation mounted its own session, so switching threads killed the
  // mic, orphaned the orb, and pinned delegation to the birth thread.)
  const projectRef = useRef<{ projectId: string; projectRoot: string | null }>({
    projectId: "",
    projectRoot: null,
  });
  useEffect(() => {
    const read = (s: ReturnType<typeof useProjectsStore.getState>) => {
      const id = s.activeProjectId;
      const p = id ? s.projects.get(id) : undefined;
      projectRef.current = {
        projectId: id ?? "",
        projectRoot: p?.root ?? null,
      };
    };
    read(useProjectsStore.getState());
    return useProjectsStore.subscribe((s, prev) => {
      if (s.activeProjectId !== prev.activeProjectId) read(s);
    });
  }, []);
  // Mirror project name for the companion journal — resolved at write time
  // so entries always name the thread that was actually active.
  const projectNameRef = useRef<string>("");
  // Active thread — subscribed (not just read) so the thread-change status
  // push effect fires on switch. One session, moving attention.
  const activeProjectId = useProjectsStore((s) => s.activeProjectId);

  /** Thread the last delegation landed in — the completion report watches
   *  THIS thread, not whatever is on screen (the user may switch away). */
  const delegatedProjectRef = useRef<string | null>(null);

  /** Journal this exchange into the companion memory (voice's episodic
   *  memory of conversations). Fire-and-forget: memory failures never
   *  touch the live session. Debounced per role so interleaved transcript
   *  events for one utterance journal once. */
  const journalTimerRef = useRef<Record<"user" | "assistant", number | null>>({
    user: null,
    assistant: null,
  });
  const pendingJournalRef = useRef<Record<"user" | "assistant", string | null>>(
    { user: null, assistant: null },
  );
  const exchangeCountRef = useRef(0);
  const writeJournalRef = useRef(
    (role: "user" | "assistant", text: string): void => {
      const t = text.trim();
      if (t.length < 2) return;
      exchangeCountRef.current += 1;
      pendingJournalRef.current[role] = null;
      // Resolve thread identity at write time: the session is global, so the
      // thread that was active when the exchange happened is the right label.
      const store = useProjectsStore.getState();
      const pid = projectRef.current.projectId;
      const proj = pid ? store.projects.get(pid) : undefined;
      void window.electronAPI
        .invoke("voice_journal_exchange", {
          role,
          text: t,
          projectId: pid,
          projectName: proj?.name ?? projectNameRef.current ?? pid,
        })
        .catch(() => undefined); // diagnostics only — never surface
    },
  );
  const journalRef = useRef(
    (role: "user" | "assistant", text: string): void => {
      const t = text.trim();
      if (t.length < 2) return;
      const timers = journalTimerRef.current;
      if (timers[role] !== null) window.clearTimeout(timers[role]!);
      pendingJournalRef.current[role] = t; // latest text for this utterance
      const delay = role === "user" ? 1200 : 0; // wait for transcription finality
      timers[role] = window.setTimeout(() => {
        timers[role] = null;
        const pending = pendingJournalRef.current[role];
        if (pending !== null) writeJournalRef.current(role, pending);
      }, delay);
    },
  );

  const [state, setState] = useState<VoiceState>("off");
  const [error, setError] = useState<string | null>(null);
  const [transcript, setTranscript] = useState<string>(""); // last user utterance (live)
  const [lastSpoken, setLastSpoken] = useState<string>(""); // last model utterance
  const [available, setAvailable] = useState<boolean | null>(null); // null = unchecked
  const [micStream, setMicStream] = useState<MediaStream | null>(null); // for the orb analyser
  const [micDevices, setMicDevices] = useState<
    Array<{ deviceId: string; label: string }>
  >([]);
  const [activeMicId, setActiveMicId] = useState<string | null>(null); // deviceId of the live input
  const audioPulseRef = useRef(0); // mutable counter, bumped per model audio delta — no re-renders

  // ── Refs (stable across renders; session state lives here) ────────────
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const dcRef = useRef<RTCDataChannel | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const audioElRef = useRef<HTMLAudioElement | null>(null);
  const enabledRef = useRef(false); // user intent: session should be live
  // ── Warm standby (Sep 2026) ────────────────────────────────────────────
  // The full boot chain (token mint → context orchestration → mic acquire →
  // ICE/DTLS → data channel) takes seconds and runs on EVERY toggle. Warm
  // standby keeps the realtime session OPEN with the mic detached: toggle
  // off parks the session via sender.replaceTrack(null) (no renegotiation —
  // the same WebRTC primitive production mute buttons use), toggle on wakes
  // it with getUserMedia + replaceTrack(track). No mint, no ICE, no SDP —
  // wake is a mic-acquire, sub-second even on Bluetooth.
  // micAttachedRef: is the mic track currently on the sender? The visual
  //   truth is sender.track, but every read site is in a transition and the
  //   ref makes intent explicit and cheap to check in guards.
  // wakingRef: a wake is in flight (mic acquire can take >1s on Bluetooth)
  //   — blocks a second toggle from double-acquiring or racing detach.
  // placeholderTrackRef: a silent track sent while detached, ONLY for the
  //   reconnect-during-standby path — a realtime session needs an audio
  //   m-line to negotiate at all, so a session minted with no mic gets a
  //   placeholder instead of a failed negotiation. Never sent while a real
  //   mic is attached; replaced (not stacked) on wake.
  const micAttachedRef = useRef(false);
  const wakingRef = useRef(false);
  // Parked intent (warm standby): session open, mic detached. Distinct from
  // enabledRef (mic live). Reconnect guards check BOTH — a parked session
  // that drops must silently rebuild itself into standby, not wake the mic.
  const standbyRef = useRef(false);
  // ── Wake-word mode (armed standby) ────────────────────────────────────
  // While parked, a local keyword spotter listens for the configured
  // phrase ("maya" by default). armedRef mirrors the listener's liveness;
  // reparkTimerRef auto-re-parks N seconds after the last conversation
  // activity — the hands-free loop: say the name → talk → silence → armed
  // again. wakeWordRef holds the phrase from settings.
  const armedRef = useRef(false);
  const reparkTimerRef = useRef<number | null>(null);
  const wakeListenerRef = useRef<import("../lib/wakeWordListener").WakeWordListener | null>(null);
  const wakeWordRef = useRef<string>("maya");
  // Wake-word enabled (settings). Parking arms the listener ONLY when this
  // is true — armed mode is opt-in, never default.
  const wakeEnabledRef = useRef(false);
  // Late-bound handle so handleEvent can schedule a re-park without a
  // circular dependency (scheduleRePark needs wake; wake precedes it).
  const reparkFnRef = useRef<(() => void) | null>(null);
  // Render-time handle to scheduleRePark for call sites that precede its
  // definition (manual orb wake) — see scheduleRePark tail comment.
  const scheduleReParkRef = useRef<(() => void) | null>(null);
  // Same for toggle(): arm-on-park references armWakeWord, defined later.
  const armFnRef = useRef<(() => void) | null>(null);
  const placeholderTrackRef = useRef<MediaStreamTrack | null>(null);
  // The audio sender itself, captured at addTrack time. After
  // replaceTrack(null) the sender's track is null, so it cannot be found by
  // track-kind predicates — hold the handle instead of rediscovering it.
  const senderRef = useRef<RTCRtpSender | null>(null);
  // Full minted session instructions + detected accent, retained for
  // turn-boundary accent reassertion (see speech_stopped handler).
  const sessionInstructionsRef = useRef("");
  const accentRef = useRef<"" | "british">("");
  // ── connect() single-flight machinery (two-voices fix, Aug 2026) ──────
  // connectSeqRef: monotonic id per connect() invocation.
  // connectingIdRef: id of the connect currently holding the in-flight
  //   slot (null = free). Owner-token semantics — a stale connect's
  //   finally only releases the slot if it still owns it, so a superseded
  //   connect can never clobber a newer one's claim (a plain boolean
  //   reintroduced exactly that race).
  // pendingConnectRef: a connect() arrived while another was mid-flight;
  //   the owner's finally hands off to it (latest-intent-wins) instead of
  //   dropping it — the fix must never cause "voice silently never comes
  //   up after a rapid switch".
  const connectSeqRef = useRef(0);
  const connectingIdRef = useRef<number | null>(null);
  const pendingConnectRef = useRef(false);
  // Session epoch — bumped by every teardown(). connect() captures it at
  // entry and re-checks after each await; a superseded connect aborts
  // instead of orphaning a live peer connection. Root cause of the
  // two-voices bug (Aug 2026): the entry guard only held while pcRef was
  // null through the ~1–2s mint + mic-acquire window; a second reconnect
  // in that window ALSO passed → two live sessions, both speaking.
  const sessionEpochRef = useRef(0);
  const reconnectAttemptRef = useRef(0);
  const reconnectTimerRef = useRef<number | null>(null);
  const delegateRef = useRef(onDelegate);
  const lastStatusPushRef = useRef<string | null>(null);
  // Previous running state for completion detection. A context item alone
  // never makes the model speak — without response.create on the
  // running→idle transition, voice stayed silent after delegation until the
  // user spoke again ("no report-back" complaint).
  const agentWasRunningRef = useRef(false);
  const eventCountRef = useRef(0);
  const deltaCountRef = useRef(0); // audio deltas are high-rate — counted, not logged
  // Events fired while the data channel is still handshaking. The channel
  // opens ~400ms AFTER pc.connectionState becomes "connected" (DTLS/SCTP
  // completes after ICE) — sends in that window used to be silent no-ops,
  // dropping the session's initial context item every single time.
  const pendingSendsRef = useRef<RealtimeEvent[]>([]);
  // ── Unresolved function calls (reconnect replay, Aug 2026) ───────────
  // The server closes the channel ~130ms after a response.done containing
  // a function_call (observed 2×: 16:13:22, 18:28:52 on Aug 29). The
  // reconnect opens a FRESH session with no history — without replay, the
  // call and its result vanish and the model never answers. Entries are
  // added when a function_call arrives, resolved (deleted) when a
  // response.done follows their delivered output. Survives teardown()
  // deliberately — that's the point.
  const pendingCallsRef = useRef<Map<string, PendingCall>>(new Map());
  const statsTimerRef = useRef<number | null>(null);
  // Mic capture diagnostics: meters the EXACT stream we send to OpenAI so
  // "silent capture" (dead Bluetooth input, zero input volume) is provable
  // locally instead of masquerading as "model not responding".
  const meterTimerRef = useRef<number | null>(null);
  const meterCtxRef = useRef<AudioContext | null>(null);
  const sawSignalRef = useRef(false); // any sample above noise floor, ever
  // Model-audio analysis: a real analyser tapped into the remote (model)
  // audio track — same technique as the mic side. The room glow reads real
  // amplitude instead of guessing from delta-event rates (the old math
  // normalized for ~83 events/frame; the API delivers ~0.5, so model speech
  // always computed ≈0 and the glow never moved).
  const modelAnalyserRef = useRef<AnalyserNode | null>(null);
  const modelAudioCtxRef = useRef<AudioContext | null>(null);

  delegateRef.current = onDelegate;

  /** Global agent status — reads ANY thread from the store, imperatively.
   *  With no argument it reports the thread the last delegation landed in
   *  (falling back to the active thread), because THAT is the run whose
   *  completion the user expects voice to report. */
  const getAgentStatus = useCallback(
    (
      projectIdArg?: string,
    ): {
      running: boolean;
      lastLine: string | null;
      projectId: string | null;
    } => {
      const pid =
        projectIdArg ??
        delegatedProjectRef.current ??
        projectRef.current.projectId;
      const proj = useProjectsStore.getState().projects.get(pid);
      const conv = proj?.conversation;
      const running = Boolean(
        conv?.isProcessing || conv?.statusMessage === "thinking...",
      );
      // Last assistant text is meaningful in BOTH states: while running it's
      // the current activity; when idle it's the final summary of the last
      // run — exactly what voice needs to report completion aloud.
      let lastLine: string | null = null;
      if (conv?.messages) {
        const msgs = conv.messages;
        for (let i = msgs.length - 1; i >= 0; i--) {
          const m = msgs[i];
          if (!m || m.type !== "assistant") continue;
          const blocks = m.content;
          if (Array.isArray(blocks)) {
            for (let j = blocks.length - 1; j >= 0; j--) {
              const b = blocks[j] as
                { type: string; text?: string } | undefined;
              if (b?.type === "text" && b.text && b.text.trim()) {
                lastLine = b.text.trim().slice(0, 200);
                break;
              }
            }
          }
          if (lastLine) break;
        }
      }
      return { running, lastLine, projectId: pid || null };
    },
    [],
  );
  const statusRef = useRef(getAgentStatus);
  statusRef.current = getAgentStatus;

  /** Send a client event over the data channel. Sends issued while the
   *  channel is still handshaking are QUEUED and flushed when it opens —
   *  the old version silently dropped them, losing the session's initial
   *  context item every time (the channel opens ~400ms after the peer
   *  connection reports "connected"). */
  const send = useCallback((event: RealtimeEvent): void => {
    const dc = dcRef.current;
    // Stash the computed tool result on its pending call BEFORE attempting
    // delivery: if the channel is down (the post-function-call close), the
    // queue is cleared by teardown() but pendingCallsRef survives — replay
    // then carries the REAL output into the fresh session, not a placeholder.
    const item = event.item as
      | { type?: string; call_id?: string; output?: unknown }
      | undefined;
    if (event.type === "conversation.item.create" && item?.type === "function_call_output" && item.call_id) {
      const pending = pendingCallsRef.current.get(item.call_id);
      if (pending) {
        pending.output = String(item.output ?? "");
      }
    }
    if (dc && dc.readyState === "open") {
      try {
        dc.send(JSON.stringify(event));
      } catch (err) {
        // dc.send THROWS on oversized SCTP messages — this exact throw was
        // the "look_at_screen never works" bug: the screenshot item pushed
        // the message over the limit, send() blew up, and the
        // function_call_output after it NEVER went out. The model said
        // "let me look…" and hung forever. Now: log loud, recover by
        // queueing the output for the reconnect replay (real output, not
        // fabricated), and surface a parseable note to the model.
        vlog("SEND THREW (oversized or closed):", event.type, String(err));
        const failing = event.item as { type?: string; call_id?: string } | undefined;
        if (event.type === "conversation.item.create" && failing?.type === "function_call_output" && failing.call_id) {
          // The output itself is small (JSON string) — queueing is safe.
          pendingSendsRef.current.push(event);
          vlog("function_call_output queued for replay after send failure:", failing.call_id);
        } else {
          vlog("item create send failed (likely image payload) — dropped:", event.type);
        }
      }
    } else if (enabledRef.current) {
      pendingSendsRef.current.push(event);
      vlog("send queued (channel not open):", event.type);
    } else {
      vlog("send dropped (channel closed, voice off):", event.type);
    }
  }, []);

  /** Capture diagnostics: meter the exact stream we send. Shared by the
   *  initial connect and the standby wake — bytesSent rising proves
   *  transport, NOT that the payload contains a voice. A dead Bluetooth
   *  input or zero input volume still sends bytes — encoded silence. This
   *  meter proves which one we have. Re-entrant: stops any prior meter
   *  before starting (detach also stops it; this covers odd callers). */
  const startMicMeter = useCallback(
    (mic: MediaStream): void => {
      const micTrack = mic.getTracks()[0];
      if (!micTrack) return;
      if (meterTimerRef.current !== null) {
        clearInterval(meterTimerRef.current);
        meterTimerRef.current = null;
      }
      if (meterCtxRef.current) {
        void meterCtxRef.current.close().catch(() => undefined);
        meterCtxRef.current = null;
      }
      try {
        const Ctx =
          window.AudioContext ??
          (window as unknown as { webkitAudioContext?: typeof AudioContext })
            .webkitAudioContext;
        if (!Ctx) return;
        const mctx = new Ctx();
        meterCtxRef.current = mctx;
        const src = mctx.createMediaStreamSource(mic);
        const analyser = mctx.createAnalyser();
        analyser.fftSize = 2048;
        src.connect(analyser); // analyser only — never to destination
        const buf = new Float32Array(analyser.fftSize);
        sawSignalRef.current = false;
        let silentMs = 0;
        let warned = false;
        meterTimerRef.current = window.setInterval(() => {
          analyser.getFloatTimeDomainData(buf);
          let peak = 0;
          let sumSq = 0;
          for (let i = 0; i < buf.length; i++) {
            const s = buf[i] ?? 0;
            const a = Math.abs(s);
            if (a > peak) peak = a;
            sumSq += s * s;
          }
          const rms = Math.sqrt(sumSq / buf.length);
          if (peak > 0.02) sawSignalRef.current = true;
          if (peak <= 0.02) silentMs += 500;
          else silentMs = 0;
          vlog(
            "mic meter — peak:",
            peak.toFixed(4),
            "rms:",
            rms.toFixed(4),
            "sawSignal:",
            sawSignalRef.current ? "yes" : "no",
          );
          // Dead-capture warning (once): 12s of digital silence while live
          // is a capture failure, not "model ignoring you".
          if (!warned && silentMs >= 12000 && !sawSignalRef.current) {
            warned = true;
            vlog(
              "⚠ MIC SILENT 12s+ — captured stream is digital silence. Check input device/volume. label:",
              micTrack.label,
            );
            setError(
              `Mic is capturing silence (${micTrack.label}). Check your input device — System Settings → Sound → Input.`,
            );
          }
        }, 500);
      } catch (meterErr) {
        vlog(
          "mic meter unavailable (non-fatal):",
          meterErr instanceof Error ? meterErr.message : String(meterErr),
        );
      }
    },
    [],
  );

  /** Detach the mic from the live session WITHOUT closing it (warm
   *  standby). The session stays negotiated — sender.replaceTrack(null)
   *  reuses the existing audio m-line, no SDP exchange. The mic tracks are
   *  STOPPED (capture ends, OS indicator off); nothing audio-sensitive
   *  survives this call. Idempotent: parking an already-parked session is
   *  a no-op. */
  const detachMic = useCallback((): void => {
    const sender = senderRef.current;
    standbyRef.current = true;
    // Stop the meter first — it reads the stream we're about to stop, and
    // a running meter against dead tracks is the "12s silence" false alarm.
    if (meterTimerRef.current !== null) {
      clearInterval(meterTimerRef.current);
      meterTimerRef.current = null;
    }
    if (meterCtxRef.current) {
      void meterCtxRef.current.close().catch(() => undefined);
      meterCtxRef.current = null;
    }
    if (micStreamRef.current) {
      for (const t of micStreamRef.current.getTracks()) t.stop();
      micStreamRef.current = null;
      setMicStream(null);
    }
    // replaceTrack(null) on the audio sender: fires no negotiationneeded
    // (transceiver direction stays sendrecv), so the remote session is
    // undisturbed. This is the standard WebRTC "hard mute" primitive.
    if (sender && sender.track) {
      sender
        .replaceTrack(null)
        .catch((err) => vlog("detach replaceTrack failed:", String(err)));
    }
    micAttachedRef.current = false;
    // Mute output too — parked means parked. The model must not speak
    // into an empty room mid-standby (a pending response could still be
    // streaming), and the remote audio track stays attached.
    if (audioElRef.current) audioElRef.current.muted = true;
    // Clear any audio the model had queued — nothing the user said should
    // transcribe into a parked session.
    if (dcRef.current?.readyState === "open") {
      send({ type: "input_audio_buffer.clear" });
      send({ type: "response.cancel" });
    }
  }, [send]);


  /** Tear down the current session completely (tracks, channel, timers). */
  const teardown = useCallback((): void => {
    // Invalidate any in-flight connect(): its captured epoch is now stale,
    // so it will abort at the next checkpoint instead of adopting or
    // clobbering a session nobody wants (two-voices bug, Aug 2026).
    sessionEpochRef.current += 1;
    // Do NOT clear connectingIdRef here: the in-flight connect still owns
    // it and must release it in its own finally (owner-id semantics —
    // teardown clearing it would let a third connect claim it while the
    // stale one is still unwinding).
    if (reconnectTimerRef.current !== null) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    if (statsTimerRef.current !== null) {
      clearInterval(statsTimerRef.current);
      statsTimerRef.current = null;
    }
    // Wake-word bookkeeping: teardown kills armed intent too — a torn-down
    // session can't be woken by name. The listener is stopped HERE, not by
    // callers: the settings-changed re-mint tears down with no preceding
    // disarm, and an orphaned listener keeps feeding the spotter — doubled
    // audio that defeats detection (two interleaved 100ms chunk streams
    // never match the keyword's token path; proven kws-interleave-test).
    if (wakeListenerRef.current) {
      wakeListenerRef.current.stop();
      wakeListenerRef.current = null;
    }
    armedRef.current = false;
    if (reparkTimerRef.current !== null) {
      window.clearTimeout(reparkTimerRef.current);
      reparkTimerRef.current = null;
    }
    // Warm-standby bookkeeping: a torn-down session has no sender, no park
    // intent, no placeholder. (toggle-off no longer tears down — this runs
    // on real end-of-life: unmount, fatal, re-mint.)
    senderRef.current = null;
    standbyRef.current = false;
    micAttachedRef.current = false;
    wakingRef.current = false;
    if (placeholderTrackRef.current) {
      placeholderTrackRef.current.stop();
      placeholderTrackRef.current = null;
    }
    if (meterTimerRef.current !== null) {
      clearInterval(meterTimerRef.current);
      meterTimerRef.current = null;
    }
    if (meterCtxRef.current) {
      void meterCtxRef.current.close().catch(() => undefined);
      meterCtxRef.current = null;
    }
    pendingSendsRef.current = [];
    const dc = dcRef.current;
    if (dc) {
      dc.onmessage = null;
      dc.onclose = null;
      dc.close();
      dcRef.current = null;
    }
    const pc = pcRef.current;
    if (pc) {
      pc.ontrack = null;
      pc.onconnectionstatechange = null;
      pc.close();
      pcRef.current = null;
    }
    if (micStreamRef.current) {
      for (const track of micStreamRef.current.getTracks()) track.stop();
      micStreamRef.current = null;
      setMicStream(null);
    }
    if (audioElRef.current) {
      audioElRef.current.srcObject = null;
    }
    // Model-audio analyser — same lifecycle as the audio element.
    if (modelAudioCtxRef.current) {
      void modelAudioCtxRef.current.close().catch(() => undefined);
      modelAudioCtxRef.current = null;
    }
    modelAnalyserRef.current = null;
  }, []);

  /** Distill the companion memory at intentional session end. Fire-and-forget:
   *  a summary failure must never block turning voice off. Trivial sessions
   *  (< 3 exchanges) skip the LLM call inside. */
  const distillAtCloseRef = useRef((): void => {
    // Flush pending journal debounce first — the last utterance must land.
    for (const role of ["user", "assistant"] as const) {
      const id = journalTimerRef.current[role];
      const pending = pendingJournalRef.current[role];
      if (id !== null) window.clearTimeout(id);
      journalTimerRef.current[role] = null;
      if (pending !== null) writeJournalRef.current(role, pending);
    }
    if (exchangeCountRef.current === 0) return;
    const count = exchangeCountRef.current;
    exchangeCountRef.current = 0;
    // Outcome is logged, never swallowed: a distill failure froze
    // memory.md for 10 days silently (Aug 23 → Sep 2, 2026). The IPC
    // promise resolves with the relay's result — surface it through the
    // same voice_debug_log channel the rest of the session uses.
    void window.electronAPI
      .invoke("voice_distill_memory", { sessionExchanges: count })
      .then((res: unknown) => {
        const r = (res ?? {}) as { ok?: boolean; skipped?: boolean; reason?: string; words?: number; error?: string };
        if (r.skipped) {
          vlog("distill skipped:", r.reason ?? "unknown");
          return;
        }
        if (r.ok === false || r.error) {
          console.error("[voice] companion memory distill failed:", r.error ?? "unknown error");
          return;
        }
        vlog("distill ok —", r.words ?? "?", "words");
      })
      .catch((err: unknown) => {
        console.error("[voice] companion memory distill IPC failed:", err);
      });
  });

  /** Push agent status into the voice conversation as a context item.
   *  Enriched with live workspace state from the projects store — the voice
   *  model passively knows thread count/activity without calling tools. */
  const pushAgentStatus = useCallback(
    (force = false): void => {
      const snap = statusRef.current();
      // Workspace line: threads + which are running + what's open. Read
      // imperatively — voice must never trigger re-renders.
      let workspaceLine = "";
      try {
        const store = useProjectsStore.getState();
        const projects = Array.from(store.projects.values());
        const active = projects.filter((p) => p.conversation?.isProcessing);
        const activeNames = active
          .slice(0, 3)
          .map((p) => p.name)
          .join(", ");
        const current = store.projects.get(projectRef.current.projectId);
        const activeFile = current?.activeFilePath
          ? current.activeFilePath.split("/").pop() || null
          : null;
        workspaceLine =
          `workspace: ${projects.length} threads` +
          (active.length > 0
            ? `, agents running: ${activeNames}`
            : ", no agents running") +
          (activeFile ? `, open file: ${activeFile}` : "");
      } catch {
        /* store read failed — agent line only */
      }
      const agentLine = snap.running
        ? `agent is working: ${snap.lastLine ?? "processing"}`
        : "agent is idle";
      const watchedName = (() => {
        const store = useProjectsStore.getState();
        const pid = delegatedProjectRef.current ?? projectRef.current.projectId;
        const p = pid ? store.projects.get(pid) : undefined;
        return p?.name ?? null;
      })();
      const line = `${workspaceLine}${watchedName ? ` (watching: ${watchedName})` : ""} | ${agentLine}`;
      if (!force && line === lastStatusPushRef.current) return; // dedupe
      lastStatusPushRef.current = line;

      // Completion detection: when the agent transitions running→idle, the
      // delegated work just finished. Push the status AND wake the model to
      // report it — a context item by itself is inert (no response.create,
      // no speech). This is the report-back loop the delegation flow was
      // missing.
      const completionEvent = agentWasRunningRef.current && !snap.running;
      agentWasRunningRef.current = snap.running;
      if (completionEvent) {
        // Name the thread that finished — with any-thread delegation the
        // user may have switched to a different thread mid-run.
        const store = useProjectsStore.getState();
        const pid = delegatedProjectRef.current ?? projectRef.current.projectId;
        const finishedName =
          (pid ? store.projects.get(pid)?.name : null) ?? "the agent";
        send({
          type: "conversation.item.create",
          item: {
            type: "message",
            role: "system",
            content: [
              {
                type: "input_text",
                text:
                  `[workspace] ${line}\n` +
                  (snap.lastLine
                    ? `${finishedName}'s final output: ${snap.lastLine}\n`
                    : "") +
                  `The delegated agent in thread "${finishedName}" just finished its run. ` +
                  "Report the outcome to the user now: " +
                  "1-3 sentences summarizing what was done, then stop. If this status line is not enough " +
                  "to answer well, call get_agent_status first. Do not ask what to do next — state the result.",
              },
            ],
          },
        });
        sendToolResponse();
        return;
      }
      send({
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "system",
          content: [{ type: "input_text", text: `[workspace] ${line}` }],
        },
      });
    },
    [send],
  );

  /** Send response.create with the minted session instructions re-anchored
   *  (accent fix, Sep 17 2026): the documented 2.x failure mode is accent
   *  reversion specifically AFTER tool usage — the tool result displaces
   *  accent adherence in attention. Per-response instructions replace the
   *  session blob for that response, so this re-sends the FULL minted blob
   *  (accent block leading). Used ONLY for post-tool-call responses; plain
   *  conversational turns keep the session-level instructions untouched. */
  const sendToolResponse = useCallback(
    (): void => {
      if (sessionInstructionsRef.current) {
        send({
          type: "response.create",
          instructions: sessionInstructionsRef.current,
        });
      } else {
        send({ type: "response.create" });
      }
    },
    [send],
  );


  /** Handle a function call from the model; send the output back.
   *  Every branch owns its own response delivery — either sync (build
   *  output, send, response.create, return) or async via voice_tool_call. */
  const handleFunctionCall = useCallback(
    (callId: string, name: string, argsJson: string): void => {
      if (name === "delegate_task") {
        let output: string;
        try {
          const args = JSON.parse(argsJson || "{}") as {
            instruction?: string;
            phase?: "think" | "build";
            thread?: string;
          };
          const instruction = (args.instruction || "").trim();
          if (!instruction) {
            output = JSON.stringify({
              ok: false,
              error: "instruction required",
            });
          } else {
            // Any-thread delegation: resolve the named thread (null = active).
            // onDelegate switches Pane to it and delivers the instruction;
            // the returned id is the thread whose completion we report.
            const landed = delegateRef.current(
              instruction,
              args.phase === "think" ? "think" : "build",
              args.thread,
            );
            delegatedProjectRef.current = landed;
            // Seed completion detection NOW: if the agent finishes before the
            // next status poll sees running=true, the running→idle transition
            // would be missed and voice stays silent after a quick task.
            agentWasRunningRef.current = true;
            lastStatusPushRef.current = null; // force the next push
            output = JSON.stringify(
              landed
                ? {
                    ok: true,
                    thread: landed,
                    note: "Agent started in that thread — Pane switched to it. Completion will be reported.",
                  }
                : {
                    ok: false,
                    error:
                      "no thread found by that name — say the thread name exactly as workspace_state lists it, or omit it to use the open thread",
                  },
            );
          }
        } catch (err) {
          output = JSON.stringify({ ok: false, error: String(err) });
        }
        send({
          type: "conversation.item.create",
          item: { type: "function_call_output", call_id: callId, output },
        });
        sendToolResponse();
        return;
      } else if (name === "get_agent_status") {
        const snap = statusRef.current();
        const output = JSON.stringify({
          running: snap.running,
          current: snap.lastLine,
        });
        send({
          type: "conversation.item.create",
          item: { type: "function_call_output", call_id: callId, output },
        });
        sendToolResponse();
        return;
      } else if (name === "workspace_state") {
        // Snapshot of threads/activity — executed in main, same flow as
        // run_knowledge_tool. Args (thread-name search) pass through: the
        // model may call with { name: "travelwise" } to search ALL threads
        // beyond the default top-12 recency cap.
        const { invoke } = window.electronAPI;
        void (async () => {
          let result: string;
          let wsArgs: { name?: string } = {};
          try {
            wsArgs = JSON.parse(argsJson || "{}") as { name?: string };
          } catch {
            /* default: unfiltered snapshot */
          }
          try {
            const res = (await invoke("voice_tool_call", {
              projectId: projectRef.current.projectId,
              projectRoot: projectRef.current.projectRoot,
              tool: "workspace_state",
              args: typeof wsArgs?.name === "string" ? { name: wsArgs.name } : {},
            })) as { success?: boolean; output?: string; error?: string };
            // buildWorkspaceSnapshot returns the object directly (success is
            // implicit when no error field is present).
            if (res && !res.error) {
              result = JSON.stringify(res).slice(0, 12000); // bound context
            } else {
              result = `error: ${res?.error ?? "workspace snapshot failed"}`;
            }
          } catch (err) {
            result = `error: ${String(err)}`;
          }
          send({
            type: "conversation.item.create",
            item: {
              type: "function_call_output",
              call_id: callId,
              output: result,
            },
          });
          sendToolResponse();
        })();
        return;
      } else if (name === "view_image") {
        // view_image's voice twin: load an image FILE the user named (path
        // from speech) and push it as input_image, then answer. Image goes
        // in BEFORE the function output so one response sees both.
        const { invoke } = window.electronAPI;
        void (async () => {
          let parsed: { path?: string; detail?: "low" | "high" } = {};
          try {
            parsed = JSON.parse(argsJson || "{}") as {
              path?: string;
              detail?: "low" | "high";
            };
          } catch {
            /* model sent malformed args — output will say path required */
          }
          vlog("view_image called — path:", parsed.path ?? "(none)", "detail:", parsed.detail ?? "low");
          let output: string;
          let imageUri: string | null = null;
          const imageDetail: "low" | "high" = parsed.detail === "high" ? "high" : "low";
          if (!parsed.path) {
            output = JSON.stringify({
              ok: false,
              error: "path is required — ask the user which image/file to look at.",
            });
          } else {
            try {
              const res = (await invoke("voice_view_image", {
                path: parsed.path,
                detail: imageDetail,
              })) as {
                ok?: boolean;
                image?: string;
                width?: number;
                height?: number;
                error?: string;
              };
              if (res?.ok && res.image) {
                imageUri = res.image;
                vlog("view_image OK — img chars:", res.image.length, `${res.width}x${res.height}`);
                output = JSON.stringify({
                  ok: true,
                  note: `Image loaded (${res.width}x${res.height}px). It is attached to the conversation — look at it, then respond.`,
                });
              } else {
                vlog("view_image FAILED:", res?.error ?? "image load failed");
                output = JSON.stringify({
                  ok: false,
                  error: res?.error ?? "image load failed",
                });
              }
            } catch (err) {
              output = JSON.stringify({ ok: false, error: String(err) });
            }
          }
          if (imageUri) {
            send({
              type: "conversation.item.create",
              item: {
                type: "message",
                role: "user",
                content: [
                  {
                    type: "input_text",
                    text: `[image file: ${parsed.path}]`,
                  },
                  {
                    type: "input_image",
                    image_url: imageUri,
                    detail: imageDetail,
                  },
                ],
              },
            });
          }
          send({
            type: "conversation.item.create",
            item: { type: "function_call_output", call_id: callId, output },
          });
          sendToolResponse();
        })();
        return;
      } else if (name === "look_at_screen") {
        // Sight: capture the Pane window in main, push it into the
        // conversation as input_image, then answer with the function output.
        vlog("look_at_screen called — raw args:", argsJson ?? "(empty)");
        const { invoke } = window.electronAPI;
        void (async () => {
          let parsed: { detail?: "low" | "high" } = {};
          try {
            parsed = JSON.parse(argsJson || "{}") as {
              detail?: "low" | "high";
            };
          } catch {
            /* default detail */
          }
          let output: string;
          let imageUri: string | null = null;
          try {
            const res = (await invoke("voice_capture_screen", {
              detail: parsed.detail === "high" ? "high" : "low",
            })) as {
              ok?: boolean;
              image?: string;
              width?: number;
              error?: string;
            };
            if (res?.ok && res.image) {
              imageUri = res.image;
              vlog("look_at_screen OK — img chars:", res.image.length, "w:", res.width);
              output = JSON.stringify({
                ok: true,
                note: `Screenshot captured (${res.width ?? "?"}px wide). It is attached to the conversation — look at it, then respond.`,
              });
            } else {
              vlog("look_at_screen FAILED:", res?.error ?? "capture failed");
              output = JSON.stringify({
                ok: false,
                error: res?.error ?? "capture failed",
              });
            }
          } catch (err) {
            output = JSON.stringify({ ok: false, error: String(err) });
          }
          // Image goes in BEFORE the function output so one response sees both.
          if (imageUri) {
            send({
              type: "conversation.item.create",
              item: {
                type: "message",
                role: "user",
                content: [
                  {
                    type: "input_text",
                    text: "[screen capture — the Pane window as the user sees it now]",
                  },
                  {
                    type: "input_image",
                    image_url: imageUri,
                    detail: parsed.detail === "high" ? "high" : "low",
                  },
                ],
              },
            });
          }
          send({
            type: "conversation.item.create",
            item: { type: "function_call_output", call_id: callId, output },
          });
          sendToolResponse();
        })();
        return;
      } else if (
        name === "run_knowledge_tool" ||
        name === "mcp_call" ||
        name === "recall_conversation"
      ) {
        // Executed async below — this branch just defines the flow.
        const { invoke } = window.electronAPI;
        void (async () => {
          let result: string;
          try {
            const parsed = JSON.parse(argsJson || "{}") as {
              tool?: string;
              args?: object;
              query?: string;
              days_back?: number;
            };
            // run_knowledge_tool carries the real tool name in { tool, args };
            // mcp_call and recall_conversation are the tools themselves.
            const invokeTool =
              name === "run_knowledge_tool" ? parsed.tool : name;
            const invokeArgs =
              name === "mcp_call"
                ? { tool: parsed.tool, args: parsed.args }
                : name === "recall_conversation"
                  ? parsed
                  : parsed.args;
            const res = (await invoke("voice_tool_call", {
              projectId: projectRef.current.projectId,
              projectRoot: projectRef.current.projectRoot,
              tool: invokeTool,
              args: invokeArgs,
            })) as { success?: boolean; output?: string; error?: string };
            if (res && res.success) {
              result = (res.output ?? "").slice(0, 12000); // bound context injection
            } else {
              result = `error: ${res?.error ?? "tool failed"}`;
            }
          } catch (err) {
            result = `error: ${String(err)}`;
          }
          send({
            type: "conversation.item.create",
            item: {
              type: "function_call_output",
              call_id: callId,
              output: result,
            },
          });
          sendToolResponse();
        })();
        return;
      } else {
        // Default route to main (contract drift fix, Sep 2026): every tool
        // that is not handled renderer-local goes to voice_tool_call, where
        // VOICE_TOOL_WHITELIST is the single authority. Previously this was
        // a hardcoded list here — it drifted from VOICE_TOOLS (main) and
        // silently swallowed list_mcp_tools with "unknown function",
        // breaking ALL external-tool discovery from voice. Main returns a
        // precise per-tool error for anything it does not allow.
        const { invoke } = window.electronAPI;
        void (async () => {
          let result: string;
          try {
            const res = (await invoke("voice_tool_call", {
              projectId: projectRef.current.projectId,
              projectRoot: projectRef.current.projectRoot,
              tool: name,
              args: (() => {
                try {
                  return JSON.parse(argsJson || "{}") as object;
                } catch {
                  return {};
                }
              })(),
            })) as { success?: boolean; output?: string; error?: string };
            if (res && !res.error) {
              // Two result shapes cross this boundary: { success, output }
              // (string outputs) and bare objects (workspace_state,
              // agent_threads) — both are success; error presence decides.
              result =
                typeof res.output === "string"
                  ? res.output.slice(0, 12000)
                  : JSON.stringify(res).slice(0, 12000);
            } else {
              result = `error: ${res?.error ?? "tool failed"}`;
            }
          } catch (err) {
            result = `error: ${String(err)}`;
          }
          send({
            type: "conversation.item.create",
            item: {
              type: "function_call_output",
              call_id: callId,
              output: result,
            },
          });
          sendToolResponse();
        })();
        return;
      }
    },
    [send, sendToolResponse],
  );


  /** Route an incoming server event. */
  const handleEvent = useCallback(
    (event: RealtimeEvent): void => {
      // Per-event trace — with timestamps this reconstructs exactly what the
      // session did (VAD fired? response streamed? errors?). Audio deltas are
      // high-rate; counted instead of logged.
      eventCountRef.current += 1;
      if (!event.type.endsWith(".delta")) {
        vlog("event #" + eventCountRef.current + ":", event.type);
      } else {
        deltaCountRef.current += 1;
        if (deltaCountRef.current % 25 === 1) {
          vlog(
            "…audio deltas:",
            deltaCountRef.current,
            "last type:",
            event.type,
          );
        }
      }
      switch (event.type) {
        // Server ground truth (accent fix, Sep 2026): the session.created /
        // session.updated echoes carry what the server ACTUALLY configured —
        // voice, model, instructions length. Mint logs what we requested;
        // this logs what was confirmed. A mismatch (stale build, dropped
        // session.update, silent re-mint) is now visible in one grep.
        case "session.created":
        case "session.updated": {
          // gpt-realtime-2.1 nests voice under session.audio.output.voice
          // (legacy sessions carried it top-level) — read both so the echo
          // always shows the server's actual voice, never "?".
          const s = (event as {
            session?: {
              voice?: string;
              model?: string;
              instructions?: string;
              audio?: { output?: { voice?: string } };
            };
          }).session ?? {};
          const confirmedVoice =
            s.voice ?? s.audio?.output?.voice ?? "?";
          vlog(
            `${event.type} — server confirmed: voice=${confirmedVoice} model=${s.model ?? "?"} instructionsLen=${s.instructions?.length ?? "?"}`,
          );
          break;
        }
        case "input_audio_buffer.speech_started":
          setState("listening");
          // User spoke — hold off the re-park timer (it reschedules on the
          // next response.done).
          if (reparkTimerRef.current !== null) {
            window.clearTimeout(reparkTimerRef.current);
            reparkTimerRef.current = null;
          }
          break;
        case "input_audio_buffer.speech_stopped":
          setState("thinking");
          // Accent reassertion (accent fix, Aug 2026): gpt-realtime drifts
          // back to the preset's default accent across turns — documented on
          // the OpenAI dev forum (accent holds first exchange, then reverts).
          // Whisper transcription often lands with American spellings
          // ("color", "mom"), which tugs delivery American at exactly the
          // turn where the model starts speaking. session.update REPLACES
          // instructions wholesale, so we re-send the complete minted blob
          // — accent block now leading, so it sits last in attention.
          if (accentRef.current && sessionInstructionsRef.current) {
            vlog(
              `accent reassert: session.update sent (accent=${accentRef.current}, instructionsLen=${sessionInstructionsRef.current.length})`,
            );
            send({
              type: "session.update",
              session: { instructions: sessionInstructionsRef.current },
            });
          }
          break;
        case "conversation.item.input_audio_transcription.completed": {
          const transcriptText =
            (event as { transcript?: string }).transcript ?? "";
          if (transcriptText) {
            setTranscript(transcriptText);
            journalRef.current("user", transcriptText);
          }
          break;
        }
        case "response.output_item.done": {
          const item = (
            event as {
              item?: {
                type?: string;
                call_id?: string;
                name?: string;
                arguments?: string;
                transcript?: string;
              };
            }
          ).item;
          if (item?.type === "function_call" && item.call_id) {
            // Journal BEFORE executing: if the channel drops mid-execution
            // (the ~130ms-after-response.done close), the call must already
            // be in pendingCallsRef for reconnect replay to pick it up.
            // Cap: resolved entries are deleted on the server's echo, but a
            // session that never echoes would grow unbounded — drop oldest.
            pendingCallsRef.current.set(item.call_id, {
              callId: item.call_id,
              name: item.name ?? "",
              argsJson: item.arguments ?? "{}",
            });
            while (pendingCallsRef.current.size > 10) {
              const oldest = pendingCallsRef.current.keys().next().value;
              if (oldest === undefined) break;
              pendingCallsRef.current.delete(oldest);
            }
            handleFunctionCall(
              item.call_id,
              item.name ?? "",
              item.arguments ?? "{}",
            );
          } else if (item?.type === "message" && item.transcript) {
            setLastSpoken(item.transcript);
          }
          break;
        }
        case "conversation.item.done": {
          // Server echo confirming our function_call_output landed. Only
          // outputs we sent get echoed this way — resolve the pending call
          // so reconnect replay doesn't re-deliver a completed call.
          const item = (event as { item?: { type?: string; call_id?: string } })
            .item;
          if (item?.type === "function_call_output" && item.call_id) {
            pendingCallsRef.current.delete(item.call_id);
          }
          break;
        }
        case "response.output_audio_transcript.done": {
          const t = (event as { transcript?: string }).transcript;
          if (t) {
            setLastSpoken(t);
            journalRef.current("assistant", t);
          }
          break;
        }
        case "response.audio_transcript.done": {
          const t = (event as { transcript?: string }).transcript;
          if (t) {
            setLastSpoken(t);
            journalRef.current("assistant", t);
          }
          break;
        }
        case "response.done":
          setState((s) => (s === "speaking" || s === "thinking" ? "idle" : s));
          // Hands-free loop: once the model finishes and the user doesn't
          // speak again, re-park + re-arm. Armed mode is opt-in from
          // settings; scheduleRePark is a no-op when never armed.
          reparkFnRef.current?.();
          break;
        case "response.output_audio.delta":
          setState("speaking");
          audioPulseRef.current += 1;
          break;
        case "response.audio.delta":
          // Legacy event name — same meaning, some models still emit it.
          setState("speaking");
          audioPulseRef.current += 1;
          break;
        case "error": {
          const detail = (event as { error?: { message?: string } | string })
            .error;
          const msg =
            typeof detail === "string"
              ? detail
              : (detail?.message ?? "realtime error");
          console.error("[voice] realtime error event:", msg);
          setError(msg);
          break;
        }
        default:
          break;
      }
    },
    [handleFunctionCall],
  );

  const micDeviceIdRef = useRef<string | null>(null);
  /** One auto-repair attempt per app run — prevents repair/retry loops if
   *  the failure is a genuinely unplugged device rather than TCC staleness. */
  const micRepairDoneRef = useRef(false);

  /** True when the error is macOS hiding input devices because Pane's TCC
   *  mic grant is missing/invalidated. Symptom (seen twice by Aug 2026):
   *  enumerateDevices returns zero inputs and getUserMedia throws
   *  "Requested device not found" with no permission dialog. Repair:
   *  main resets our own TCC record; the next getUserMedia re-prompts. */
  // (isMicPermissionFailure hoisted to module scope — shared by connect and
  // the standby wake path.)

  /** Reset Pane's own TCC mic record (main-side tccutil) so macOS shows a
   *  fresh permission prompt. Returns true when the retry is worth doing. */
  const repairMicPermission = useCallback(async (): Promise<boolean> => {
    try {
      const res = (await window.electronAPI.invoke("voice_repair_mic")) as {
        ok: boolean;
        error?: string;
      };
      vlog(
        "mic permission repair:",
        res?.ok ? "TCC record reset — retrying" : `failed: ${res?.error}`,
      );
      return !!res?.ok;
    } catch (err) {
      vlog(
        "mic permission repair unavailable:",
        err instanceof Error ? err.message : String(err),
      );
      return false;
    }
  }, []);

  /** Enumerate audio inputs. Labels are empty until getUserMedia permission
   *  is granted once — we re-enumerate after first capture so the picker
   *  shows real names. */
  const refreshMicDevices = useCallback(async (): Promise<void> => {
    try {
      const list = await navigator.mediaDevices.enumerateDevices();
      const inputs = list
        .filter((d) => d.kind === "audioinput")
        .map((d) => ({
          deviceId: d.deviceId,
          label: d.label || "(unnamed input)",
        }));
      setMicDevices(inputs);
      vlog(
        "input devices:",
        inputs.map((d) => d.label).join(" | ") || "(none)",
      );
    } catch (err) {
      vlog(
        "enumerateDevices failed:",
        err instanceof Error ? err.message : String(err),
      );
    }
  }, []);

  /** Wake from standby: re-acquire the mic and attach it to the open
   *  session. This is the entire boot we skip — no mint, no ICE, no SDP;
   *  getUserMedia latency is all that remains (fast on built-in mics,
   *  ~1s on Bluetooth). */
  const wake = useCallback(async (): Promise<void> => {
    const pc = pcRef.current;
    const sender = senderRef.current;
    if (!pc || !sender || micAttachedRef.current || wakingRef.current) return;
    wakingRef.current = true;
    standbyRef.current = false;
    try {
      const mic = await acquireMic(micDeviceIdRef.current);
      const track = mic.getTracks()[0];
      if (!track) throw new Error("microphone granted no audio track");
      // Session died while we awaited getUserMedia (standby reconnect can
      // tear down) — release the mic and let the reconnect own the state.
      if (!pcRef.current || pcRef.current !== pc) {
        for (const t of mic.getTracks()) t.stop();
        return;
      }
      micStreamRef.current = mic;
      setMicStream(mic);
      setActiveMicId(track.getSettings().deviceId ?? null);
      await sender.replaceTrack(track);
      // A placeholder from a standby reconnect may still be set — stop it
      // once the real track has taken its place on the sender.
      if (placeholderTrackRef.current) {
        placeholderTrackRef.current.stop();
        placeholderTrackRef.current = null;
      }
      micAttachedRef.current = true;
      // Un-park output alongside input — detachMic muted the audio element.
      if (audioElRef.current) audioElRef.current.muted = false;
      void refreshMicDevices();
      startMicMeter(mic);
      setState("idle");
    } catch (err) {
      // Permission lost while parked, device unplugged — surface it, stay
      // parked so the session is still there once the user fixes the mic.
      vlog("wake failed:", err instanceof Error ? err.message : String(err));
      standbyRef.current = true;
      setState("error");
      setError(
        isMicPermissionFailure(err)
          ? "Microphone permission is blocked. Open System Settings → Privacy & Security → Microphone, allow Pane, then click the bot again."
          : err instanceof Error
            ? err.message
            : String(err),
      );
    } finally {
      wakingRef.current = false;
    }
  }, [acquireMic, refreshMicDevices, startMicMeter]);

  /** Establish the session (token + WebRTC + data channel). */
  const connect = useCallback(async (): Promise<void> => {
    // Dual guard (two-voices bug, Aug 2026): pcRef covers the steady state,
    // but pcRef stays null through the ~1–2s token mint + mic acquire — a
    // second connect() landing in that window passed the same null check
    // and both completions went live: two sessions, two audio elements,
    // both speaking (log: session.created #2226 then #2229 on one
    // continuous counter). Now: connectingRef blocks re-entry for the
    // whole span; a caller that arrives mid-flight queues itself and is
    // handed off when the in-flight connect finishes; sessionEpoch lets a
    // superseded connect abort cleanly instead of orphaning its PC.
    if (pcRef.current) return;
    if (connectingIdRef.current !== null) {
      pendingConnectRef.current = true; // hand off to us in their finally
      return;
    }
    // Never resurrect a session the user switched off: handoffs and queued
    // requests can outlive the toggle (switch voice, then click off before
    // the handoff fires). The enabled effect sets enabledRef BEFORE its
    // initial connect(), so every legitimate entry passes this check.
    // EXCEPTION: a parked (standby) session rebuilding itself after a drop
    // passes deliberately — it stays parked, mic detached, no capture.
    if (!enabledRef.current && !standbyRef.current) return;
    const myId = ++connectSeqRef.current;
    connectingIdRef.current = myId;
    pendingConnectRef.current = false;
    const epoch = sessionEpochRef.current;
    setState("connecting");
    setError(null);

    try {
      const snap = statusRef.current();
      const statusLine = snap.running
        ? `working: ${snap.lastLine ?? "processing"}`
        : "idle";
      const mint = (await window.electronAPI.invoke("voice_mint_token", {
        projectId: projectRef.current.projectId,
        projectRoot: projectRef.current.projectRoot,
        agentStatus: statusLine,
      })) as {
        ok: boolean;
        token?: string;
        instructions?: string;
        accent?: "british" | "none";
        error?: string;
      };
      if (!mint?.ok || !mint.token) {
        const reason = mint?.error ?? "token mint failed";
        console.error("[voice] session could not start:", reason);
        if (connectingIdRef.current === myId) connectingIdRef.current = null; // owner release — no session was created
        setState("error");
        setAvailable(false);
        setError(reason);
        enabledRef.current = false;
        // A mint failure while parked is a credential/config problem, not a
        // network drop — looping reconnect into standby would hammer the
        // mint endpoint forever. Park is over; the next wake boots fresh.
        standbyRef.current = false;
        return;
      }
      // Retain the full session instructions — turn-boundary accent
      // reassertion must re-send the COMPLETE blob (session.update replaces
      // instructions wholesale; sending only the accent block would wipe
      // the persona on the first turn).
      // Structured accent from the mint (Sep 2026 boundary fix): the relay
      // returns the composed blob AND the accent as an explicit field. The
      // old detectAccent() inferred accent by matching "You are British" at
      // position 0 of the blob — but the mint returned the UN-composed
      // shared blob, so the matcher never fired and accentRef stayed "",
      // silently disabling turn-boundary accent reassertion since birth.
      sessionInstructionsRef.current = mint.instructions ?? "";
      accentRef.current = mint.accent === "british" ? "british" : "";
      setAvailable(true);

      // Stale-connect checkpoint (two-voices bug): teardown() ran while we
      // awaited the mint — a voice switch or toggle-off crossed us. Abort
      // rather than adopt a session nobody wants.
      if (epoch !== sessionEpochRef.current) {
        vlog("connect aborted — stale epoch after mint (session superseded)");
        if (connectingIdRef.current === myId) connectingIdRef.current = null; // owner release — superseded
        return;
      }

      // Standby-mint path (session died parked, rebuilding into standby):
      // skip mic acquisition entirely — no capture while parked — and
      // attach a silent placeholder so the SDP has an audio m-line to
      // negotiate. Realtime sessions require one; a mic-less offer fails.
      const mintingIntoStandby = standbyRef.current;
      let micTrack: MediaStreamTrack;
      if (mintingIntoStandby) {
        // Silent AudioContext source → MediaStreamDestination yields a
        // real audio track with no capture device: no OS input indicator,
        // no mic permission involved. Digital silence for the whole
        // parked span; the model receives nothing (buffer stays cleared).
        const actx = new AudioContext();
        const silentNode = actx.createBufferSource();
        silentNode.buffer = actx.createBuffer(
          1,
          actx.sampleRate * 10,
          actx.sampleRate,
        ); // all zeros
        const silentDest = actx.createMediaStreamDestination();
        silentNode.connect(silentDest);
        silentNode.start();
        const placeholder = silentDest.stream.getAudioTracks()[0];
        if (!placeholder) throw new Error("silent placeholder yielded no track");
        micTrack = placeholder;
        placeholderTrackRef.current = placeholder;
        // The AudioContext must outlive the track. It closes when the
        // placeholder is stopped in teardown/wake — tracked via onended.
        placeholder.onended = () => void actx.close().catch(() => undefined);
        vlog("minting into standby — silent placeholder track attached");
      } else {
        // ── WebRTC setup (verified flow from OpenAI realtime-webrtc docs) ──
        const mic = await acquireMic(micDeviceIdRef.current);
        micStreamRef.current = mic;
        setMicStream(mic);
        const realTrack = mic.getTracks()[0];
        if (!realTrack) throw new Error("microphone granted no audio track");
        micTrack = realTrack;
      }
      // Same staleness check after the second await. (No await occurred on
      // the standby path, but the check is free and guards the else-branch
      // future edits could reorder.)
      if (epoch !== sessionEpochRef.current) {
        vlog(
          "connect aborted — stale epoch after mic acquire (session superseded)",
        );
        if (!mintingIntoStandby && micStreamRef.current) {
          for (const t of micStreamRef.current.getTracks()) t.stop(); // don't leak the mic
          micStreamRef.current = null;
        }
        if (micTrack) micTrack.stop();
        if (connectingIdRef.current === myId) connectingIdRef.current = null; // owner release — superseded
        return;
      }
      if (!mintingIntoStandby) {
        vlog(
          "mic acquired — label:",
          micTrack.label || "(no label)",
          "enabled:",
          micTrack.enabled,
        );
        setActiveMicId(micTrack.getSettings().deviceId ?? null);
        // Labels are empty pre-permission; re-enumerate now that we have it.
        void refreshMicDevices();

        // ── Capture diagnostics: meter the exact stream we send ────────
        // (see startMicMeter — shared with the standby wake path)
        startMicMeter(micStreamRef.current!);
      }

      const pc = new RTCPeerConnection();
      pcRef.current = pc;

      const audioEl = document.createElement("audio");
      audioEl.autoplay = true;
      audioElRef.current = audioEl;
      pc.ontrack = (e: RTCTrackEvent) => {
        audioEl.srcObject = e.streams[0] ?? null;
        vlog("remote track arrived — audio element updated");
        // ── Model-audio analysis for the room glow ─────────────────────
        // Tap the SAME stream the speakers play, with a real analyser —
        // identical technique to the mic side. voiceLight.model was
        // previously derived from delta-event rate with math normalized
        // for ~83 events/frame while the API delivers ~0.5, so model
        // speech always computed ≈0 and the glow stayed flat. This is the
        // real signal.
        try {
          const Ctx =
            window.AudioContext ??
            (window as unknown as { webkitAudioContext?: typeof AudioContext })
              .webkitAudioContext;
          if (Ctx) {
            const ctx = new Ctx();
            // May start suspended when created outside a user gesture —
            // the toggle click happened, but this analyser is built inside
            // the WebRTC handshake. Resume() is idempotent and safe.
            if (ctx.state === "suspended")
              void ctx.resume().catch(() => undefined);
            modelAudioCtxRef.current = ctx;
            const src = ctx.createMediaStreamSource(
              e.streams[0] ?? (audioEl.srcObject as MediaStream),
            );
            const analyser = ctx.createAnalyser();
            analyser.fftSize = 256;
            src.connect(analyser); // analyser only — never to destination
            modelAnalyserRef.current = analyser;
            vlog("model-audio analyser attached");
          }
        } catch (err) {
          vlog(
            "model analyser setup failed (non-fatal):",
            err instanceof Error ? err.message : String(err),
          );
        }
      };

      const sender = pc.addTrack(micTrack);
      // Hold the sender for the standby lifecycle: after replaceTrack(null)
      // its track is null and it can't be found by kind-predicates again.
      senderRef.current = sender;
      if (mintingIntoStandby) {
        // Placeholder occupies the m-line; mic is NOT attached. The parked
        // session is negotiated but inert until wake() swaps a real track.
        micAttachedRef.current = false;
        if (audioElRef.current) audioElRef.current.muted = true;
      } else {
        micAttachedRef.current = true;
        // A placeholder from a standby-mode reconnect is superseded by this
        // real track — stop it once the real one is on the sender.
        if (placeholderTrackRef.current) {
          placeholderTrackRef.current.stop();
          placeholderTrackRef.current = null;
        }
      }

      const dc = pc.createDataChannel("oai-events");
      dcRef.current = dc;
      dc.onopen = () => {
        vlog(
          "data channel OPEN — flushing",
          pendingSendsRef.current.length,
          "queued sends",
        );
        for (const ev of pendingSendsRef.current) dc.send(JSON.stringify(ev));
        pendingSendsRef.current = [];
        // Reconnect replay (Aug 2026): the server closes the channel right
        // after function-call responses, and the fresh session has no
        // history. Re-create each unresolved call + its output so the model
        // can continue instead of silently never answering.
        if (pendingCallsRef.current.size > 0) {
          vlog(
            "replaying unresolved function calls:",
            pendingCallsRef.current.size,
          );
          for (const call of pendingCallsRef.current.values()) {
            // Real output if the tool completed before the drop; an honest
            // note only when execution itself was lost (never fabricated
            // data). The call item is re-created first so the output's
            // call_id pairs correctly in the fresh session.
            dc.send(
              JSON.stringify({
                type: "conversation.item.create",
                item: {
                  type: "function_call",
                  call_id: call.callId,
                  name: call.name,
                  arguments: call.argsJson,
                },
              }),
            );
            dc.send(
              JSON.stringify({
                type: "conversation.item.create",
                item: {
                  type: "function_call_output",
                  call_id: call.callId,
                  output:
                    call.output ??
                    JSON.stringify({
                      ok: false,
                      error:
                        "connection dropped before the tool ran — ask again or rephrase",
                    }),
                },
              }),
            );
          }
          pendingCallsRef.current.clear();
          // History is restored — let the model pick up where it left off.
          dc.send(JSON.stringify({ type: "response.create" }));
        }
        // Proof of outbound audio: if bytesSent rises while you speak,
        // mic audio reaches OpenAI and any silence is server/model-side.
        statsTimerRef.current = window.setInterval(() => {
          const p = pcRef.current;
          if (!p) return;
          void p
            .getStats()
            .then((report) => {
              for (const entry of report.values()) {
                const t = entry as {
                  type?: string;
                  kind?: string;
                  bytesSent?: number;
                  bytesReceived?: number;
                };
                if (
                  t.type === "outbound-rtp" &&
                  t.kind === "audio" &&
                  typeof t.bytesSent === "number"
                ) {
                  vlog("stats outbound-rtp audio bytesSent:", t.bytesSent);
                }
              }
            })
            .catch(() => undefined);
        }, 5000) as unknown as number;
      };
      dc.onmessage = (e: MessageEvent<string>) => {
        try {
          handleEvent(JSON.parse(e.data) as RealtimeEvent);
        } catch (err) {
          console.error("[voice] failed to parse realtime event:", err);
        }
      };
      dc.onclose = () => {
        vlog(
          "data channel closed",
          enabledRef.current
            ? "(unexpected — will reconnect)"
            : standbyRef.current
              ? "(unexpected while parked — will reconnect into standby)"
              : "(expected — user off)",
        );
        // Unexpected drop while enabled OR parked → reconnect with backoff.
        // Parked reconnects mint straight back into standby (placeholder
        // track, no capture) so wake stays instant.
        if ((enabledRef.current || standbyRef.current) && pcRef.current)
          scheduleReconnect();
      };

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      vlog("SDP offer created, posting to /v1/realtime/calls…");
      const sdpRes = await fetch("https://api.openai.com/v1/realtime/calls", {
        method: "POST",
        body: offer.sdp,
        headers: {
          Authorization: `Bearer ${mint.token}`,
          "Content-Type": "application/sdp",
        },
      });
      if (!sdpRes.ok) {
        const body = await sdpRes.text().catch(() => "");
        vlog("SDP exchange FAILED", sdpRes.status, body.slice(0, 300));
        throw new Error(
          `SDP exchange failed ${sdpRes.status}: ${body.slice(0, 300)}`,
        );
      }
      await pc.setRemoteDescription({
        type: "answer",
        sdp: await sdpRes.text(),
      });
      vlog("SDP answer applied — waiting for ICE/connection");

      pc.oniceconnectionstatechange = () => {
        vlog("ICE state:", pc.iceConnectionState);
      };
      pc.onconnectionstatechange = () => {
        const st = pc.connectionState;
        vlog("PC state:", st);
        if (st === "connected") {
          reconnectAttemptRef.current = 0;
          // A standby-mode reconnect completing must land in standby, not
          // idle — the mic is not attached. The user is not listening.
          setState(standbyRef.current ? "standby" : "idle");
          pushAgentStatus(true);
          // A mint landing in standby must re-arm (settings-changed re-mint
          // disarmed on teardown): armed mode is opt-in, the armed ear is
          // the point of parking. armFnRef is the late-bound handle.
          if (standbyRef.current && wakeEnabledRef.current) armFnRef.current?.();
        } else if (
          (st === "failed" || st === "disconnected" || st === "closed") &&
          (enabledRef.current || standbyRef.current)
        ) {
          vlog(
            "connection lost — scheduling reconnect, attempt",
            reconnectAttemptRef.current + 1,
          );
          scheduleReconnect();
        }
      };
    } catch (err) {
      if (connectingIdRef.current === myId) connectingIdRef.current = null; // owner release before retry/teardown
      vlog("connect failed:", err instanceof Error ? err.message : String(err));
      console.error("[voice] connect failed:", err);
      // Mic-permission failures (stale TCC record after reinstall) are
      // recoverable without user intervention: reset our own TCC record and
      // retry once — macOS then shows the permission prompt afresh. Any
      // other error follows the normal path to the error state.
      if (isMicPermissionFailure(err) && !micRepairDoneRef.current) {
        micRepairDoneRef.current = true; // one auto-repair per app run
        vlog("mic permission failure detected — attempting self-repair");
        const repaired = await repairMicPermission();
        if (repaired) {
          // Give tccutil a beat to settle before re-requesting.
          await new Promise((r) => setTimeout(r, 800));
          // Release the guard BEFORE the recursive retry so the inner
          // connect() isn't rejected by our own in-flight flag; the retry
          // then re-establishes it fresh.
          if (connectingIdRef.current === myId) connectingIdRef.current = null;
          await connect(); // single retry with a clean TCC record
          return;
        }
      }
      teardown();
      setState("error");
      const raw = err instanceof Error ? err.message : String(err);
      setError(
        isMicPermissionFailure(err)
          ? "Microphone permission is blocked. Open System Settings → Privacy & Security → Microphone, allow Pane, then click the bot again."
          : raw,
      );
      enabledRef.current = false;
    } finally {
      // Ownership-safe release (two-voices fix): only the connect that SET
      // this id may clear it — a stale connect unwinding after teardown
      // must never release a replacement's guard. If a queued request is
      // pending (rapid voice switch), hand off: clear the marker, re-invoke.
      // Queued requests are never dropped — that was the "voice silently
      // dead after switching" failure mode.
      if (connectingIdRef.current === myId) {
        connectingIdRef.current = null;
        if (pendingConnectRef.current) {
          pendingConnectRef.current = false;
          vlog("connect handoff — running queued connect request");
          void connect(); // re-checks enabledRef at entry — off stays off
        }
      }
    }
  }, [handleEvent, pushAgentStatus, teardown]);

  const scheduleReconnect = useCallback((): void => {
    if (reconnectTimerRef.current !== null) return;
    // Live (enabled) sessions always reconnect. Parked (standby) sessions
    // reconnect too — silently, back into standby with a placeholder
    // track — so wake stays instant even after an overnight drop. A
    // session that is neither (user never enabled, or hard-off) stays down.
    if (!enabledRef.current && !standbyRef.current) return;
    // teardown() resets standbyRef (end-of-life bookkeeping) — but here it
    // is NOT end-of-life, it's a rebuild. Capture park intent across the
    // teardown: without this, connect() takes the mic path and silently
    // REACTIVATES the microphone on a session the user parked.
    const rebuildIntoStandby = !enabledRef.current && standbyRef.current;
    teardown();
    if (rebuildIntoStandby) standbyRef.current = true;
    const attempt = reconnectAttemptRef.current++;
    setState(enabledRef.current ? "connecting" : "standby");
    reconnectTimerRef.current = window.setTimeout(() => {
      reconnectTimerRef.current = null;
      void connect();
    }, backoffDelay(attempt));
  }, [connect, teardown]);

  /** User toggles voice on/off. Off → WARM STANDBY when a session is open:
   *  the realtime session stays negotiated with the mic detached (capture
   *  ends, OS indicator off); the conversation continues across standby —
   *  no distill, no teardown. On → wake is just getUserMedia +
   *  replaceTrack (no mint/ICE/SDP). Full teardown + distill remains for
   *  unmount, fatal error, and settings re-mint. */
  const toggle = useCallback(async (): Promise<void> => {
    vlog("toggle — enabled:", enabledRef.current ? "on→off" : "off→on");
    if (armedRef.current && !enabledRef.current) {
      // Armed (parked + listening for the name): toggle means "stop
      // listening entirely" — disarm and go fully off, same as standby.
      disarmWakeWord();
      teardown();
      distillAtCloseRef.current();
      pendingCallsRef.current.clear();
      setState("off");
      return;
    }
    if (enabledRef.current) {
      enabledRef.current = false;
      const sessionAlive =
        !!pcRef.current &&
        pcRef.current.connectionState === "connected" &&
        !!dcRef.current &&
        dcRef.current.readyState === "open";
      if (sessionAlive) {
        // ── Park it. Mic stops; session stays. Context stays loaded. ──
        detachMic();
        setState("standby");
        vlog("voice parked — session stays open, mic detached");
        // Wake-word mode: parking arms the local listener (opt-in via
        // settings) so the phrase wakes it hands-free. armFnRef is the
        // late-bound handle — armWakeWord is defined below (needs wake).
        if (wakeEnabledRef.current) armFnRef.current?.();
        return;
      }
      // No session to park (still connecting, or died while enabled) —
      // full teardown, same as before standby existed.
      teardown();
      distillAtCloseRef.current();
      pendingCallsRef.current.clear();
      setState("off");
      return;
    }
    // ── On ──
    if (
      pcRef.current &&
      pcRef.current.connectionState === "connected" &&
      dcRef.current &&
      dcRef.current.readyState === "open"
    ) {
      // Warm session parked below us — wake it. Fresh instructions/context
      // come with the wake's first status push; the minted persona is
      // still in the session. (If the user changed voice/accent while
      // parked, the settings-changed effect already re-minted.)
      reconnectAttemptRef.current = 0;
      eventCountRef.current = 0;
      enabledRef.current = true;
      setState("idle"); // optimistic — wake sets it again on completion
      await wake();
      // A manual wake joins the hands-free loop too: after the next
      // completed exchange, park and re-arm like a word-triggered wake.
      // response.done's reparkFnRef is empty until scheduleRePark has run
      // once — the render-time ref always has the current function.
      scheduleReParkRef.current?.();
      return;
    }
    enabledRef.current = true;
    reconnectAttemptRef.current = 0;
    eventCountRef.current = 0;
    await connect();
  }, [connect, teardown, detachMic, wake]);

  /** Interrupt model speech (barge-in). */
  const interrupt = useCallback((): void => {
    send({ type: "response.cancel" });
    setState("idle");
  }, [send]);

  /** User pins a mic. Live session: restart so the new device takes effect
   *  immediately. */
  const selectMic = useCallback(
    (deviceId: string): void => {
      micDeviceIdRef.current = deviceId;
      try {
        localStorage.setItem(PANE_MIC_KEY, deviceId);
      } catch {
        /* storage unavailable — session-only selection */
      }
      vlog("mic pinned:", deviceId);
      if (enabledRef.current) scheduleReconnect();
    },
    [scheduleReconnect],
  );

  // ── Wake-word armed mode ────────────────────────────────────────────────
  // While parked, listen for the configured phrase with the LOCAL keyword
  // spotter (main process). On detection: wake the session exactly as the
  // toggle does. After the conversation goes quiet (no speech for
  // RE_PARK_AFTER_MS following a completed model response), park again and
  // re-arm — the hands-free loop. The armed mic feeds ONLY the local
  // spotter; the realtime session's track stays detached until wake.
  const RE_PARK_AFTER_MS = 30_000;

  const disarmWakeWord = useCallback((): void => {
    if (reparkTimerRef.current !== null) {
      window.clearTimeout(reparkTimerRef.current);
      reparkTimerRef.current = null;
    }
    if (!armedRef.current) return;
    armedRef.current = false;
    wakeListenerRef.current?.stop();
    wakeListenerRef.current = null;
    vlog("wake word disarmed");
    if (!enabledRef.current && standbyRef.current) setState("standby");
  }, []);

  const scheduleRePark = useCallback((): void => {
    if (reparkTimerRef.current !== null) window.clearTimeout(reparkTimerRef.current);
    reparkTimerRef.current = window.setTimeout(() => {
      reparkTimerRef.current = null;
      if (!enabledRef.current) return; // already parked/off
      if (!wakeEnabledRef.current) return; // armed mode off — stay live
      vlog("voice idle — re-parking and re-arming wake word");
      enabledRef.current = false;
      detachMic();
      setState("armed");
      armedRef.current = true;
      const listener = createWakeWordListener(wakeWordRef.current);
      wakeListenerRef.current = listener;
      void listener.start().then((ok) => {
        if (!ok && armedRef.current) {
          // Mic unavailable (or spotter failed) — plain standby, no armed
          // ear. Click-to-wake still works.
          vlog("wake-word listener failed to start — plain standby");
          armedRef.current = false;
          wakeListenerRef.current = null;
          setState("standby");
        }
      });
    }, RE_PARK_AFTER_MS);
    reparkFnRef.current = scheduleRePark;
  }, [detachMic]);
  // Render-time handle so paths defined BEFORE scheduleRePark (the manual
  // orb wake in toggle) can enter the hands-free loop without a cycle in
  // the dependency graph. reparkFnRef only populates after scheduleRePark
  // has run once — useless for a first manual wake.
  scheduleReParkRef.current = scheduleRePark;

  const armWakeWord = useCallback((): void => {
    if (armedRef.current) return;
    if (!standbyRef.current) return; // only meaningful while parked
    armedRef.current = true;
    setState("armed");
    vlog("wake word armed — listening for:", wakeWordRef.current);
    const listener = createWakeWordListener(wakeWordRef.current);
    wakeListenerRef.current = listener;
    listener.onDetect((_keyword) => {
      if (enabledRef.current || !standbyRef.current) return; // already awake
      vlog(`wake word detected — waking`);
      // Same wake path as the toggle: swap the mic in, no re-mint.
      reconnectAttemptRef.current = 0;
      eventCountRef.current = 0;
      enabledRef.current = true;
      armedRef.current = false;
      wakeListenerRef.current?.stop();
      wakeListenerRef.current = null;
      setState("idle");
      void wake().then(() => scheduleRePark());
    });
    void listener.start().then((ok) => {
      if (!ok && armedRef.current) {
        vlog("wake-word listener failed to start — plain standby");
        armedRef.current = false;
        wakeListenerRef.current = null;
        setState("standby");
      }
    });
  }, [wake, scheduleRePark]);
  armFnRef.current = armWakeWord;

  /** Configure (or change) the wake phrase. Re-arms if currently armed. */
  const setWakePhrase = useCallback(
    (phrase: string): void => {
      const clean = phrase.trim().toLowerCase();
      if (!clean) return;
      wakeWordRef.current = clean;
      if (armedRef.current) {
        armedRef.current = false;
        wakeListenerRef.current?.stop();
        wakeListenerRef.current = null;
        if (standbyRef.current) armWakeWord();
      }
    },
    [armWakeWord],
  );



  // Voice/accent changed in settings (Profile) → re-mint a live session.
  // Voice + accent are baked in at mint time; a settings change with no
  // reconnect meant the old voice/accent kept playing until manual
  // restart. Immediate swap, zero backoff — this is a deliberate change,
  // not a network failure. A PARKED session also re-mints (the next wake
  // must speak the new voice), rebuilding into standby — no mic ever.
  // Wake-word settings ride along on the same event: phrase changes
  // re-configure the spotter; enable/disable re-arms or disarms a parked
  // session (the re-mint below rebuilds into standby, and toggle-park
  // arms from there — but an already-parked session needs the explicit
  // arm/disarm here since no park event will fire).
  useEffect(() => {
    const unlisten = window.electronAPI.on(
      "pane:voice-settings-changed",
      (next: { wake_word?: string; wake_word_enabled?: boolean }) => {
        if (typeof next?.wake_word === "string" && next.wake_word.trim()) {
          setWakePhrase(next.wake_word.trim().toLowerCase());
        }
        wakeEnabledRef.current = next?.wake_word_enabled === true;
        if (!enabledRef.current && standbyRef.current) {
          if (wakeEnabledRef.current) armFnRef.current?.();
          else disarmWakeWord();
        }
        if (!enabledRef.current && !standbyRef.current) return;
        vlog(
          enabledRef.current
            ? "voice settings changed — re-minting live session"
            : "voice settings changed while parked — re-minting into standby",
        );
        // Reset the attempt counter so the swap takes the shortest
        // backoff (1s at attempt 0) — a deliberate change, not failure.
        reconnectAttemptRef.current = 0;
        scheduleReconnect();
      },
    );
    return unlisten;
  }, [scheduleReconnect, disarmWakeWord]);

  // Load wake-word settings once at mount: phrase + whether parking arms.
  useEffect(() => {
    loadSettings()
      .then((s) => {
        const vs = (
          s as {
            voice_settings?: { wake_word?: string; wake_word_enabled?: boolean };
          }
        ).voice_settings;
        if (vs?.wake_word?.trim()) wakeWordRef.current = vs.wake_word.trim().toLowerCase();
        wakeEnabledRef.current = vs?.wake_word_enabled === true;
      })
      .catch(() => undefined);
  }, []);

  // ── Agent observation: watch conversation store for status changes ────
  useEffect(() => {
    if (!enabledRef.current) return;
    // Poll agent status — cheap (reads a ref), pushes only on change.
    const interval = window.setInterval(() => {
      const dc = dcRef.current;
      if (dc && dc.readyState === "open") pushAgentStatus();
    }, 3000);
    return () => clearInterval(interval);
  }, [pushAgentStatus, state === "off"]);

  // ── Cleanup on unmount (the session is global — no per-project teardown)
  useEffect(() => {
    return () => {
      enabledRef.current = false;
      teardown();
      distillAtCloseRef.current();
    };
  }, [teardown, distillAtCloseRef]);

  // Active thread changed: push the new workspace line so the model knows
  // where the user's attention is. No reconnect — one session spans all
  // threads; only the passive context line moves.
  useEffect(() => {
    if (!enabledRef.current) return;
    // defer a tick so the store has settled on the new thread
    const t = window.setTimeout(() => pushAgentStatus(true), 250);
    return () => window.clearTimeout(t);
  }, [activeProjectId, pushAgentStatus]);

  return {
    state,
    error,
    transcript,
    lastSpoken,
    available,
    micStream,
    micDevices,
    activeMicId,
    refreshMicDevices,
    selectMic,
    audioPulseRef,
    /** Real analyser on the model's audio track — the orb's outer ring and
     *  the room glow read true amplitude from this (replaces delta-rate
     *  guessing). Null until the remote track arrives. */
    modelAnalyserRef,
    toggle,
    interrupt,
    /** Imperative status push — e.g. right after delegation fires. */
    pushAgentStatus,
    /** Wake-word: arm while parked (opt-in), disarm, set phrase. */
    armWakeWord,
    disarmWakeWord,
    setWakePhrase,
    armedRef,
  };
}
