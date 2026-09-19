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

export type VoiceState =
  | "off" // feature disabled / no key
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
  const isMicPermissionFailure = (err: unknown): boolean => {
    const msg = err instanceof Error ? err.message : String(err);
    return (
      /Requested device not found/i.test(msg) ||
      /not ?allowed/i.test(msg) ||
      /permission denied/i.test(msg)
    );
  };

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
    if (!enabledRef.current) return;
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

      // ── WebRTC setup (verified flow from OpenAI realtime-webrtc docs) ──
      const mic = await acquireMic(micDeviceIdRef.current);
      micStreamRef.current = mic;
      setMicStream(mic);
      const micTrack = mic.getTracks()[0];
      if (!micTrack) throw new Error("microphone granted no audio track");
      // Same staleness check after the second await.
      if (epoch !== sessionEpochRef.current) {
        vlog(
          "connect aborted — stale epoch after mic acquire (session superseded)",
        );
        for (const t of mic.getTracks()) t.stop(); // don't leak the mic
        if (connectingIdRef.current === myId) connectingIdRef.current = null; // owner release — superseded
        return;
      }
      vlog(
        "mic acquired — label:",
        micTrack.label || "(no label)",
        "enabled:",
        micTrack.enabled,
      );
      setActiveMicId(micTrack.getSettings().deviceId ?? null);
      // Labels are empty pre-permission; re-enumerate now that we have it.
      void refreshMicDevices();

      // ── Capture diagnostics: meter the exact stream we send ──────────
      // bytesSent rising proves transport, NOT that the payload contains
      // a voice. A dead Bluetooth input or zero input volume still sends
      // bytes — encoded silence. This meter proves which one we have.
      try {
        const Ctx =
          window.AudioContext ??
          (window as unknown as { webkitAudioContext?: typeof AudioContext })
            .webkitAudioContext;
        if (Ctx) {
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
        }
      } catch (meterErr) {
        vlog(
          "mic meter unavailable (non-fatal):",
          meterErr instanceof Error ? meterErr.message : String(meterErr),
        );
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

      pc.addTrack(micTrack);

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
            : "(expected — user off)",
        );
        // Unexpected drop while enabled → reconnect with backoff.
        if (enabledRef.current && pcRef.current) scheduleReconnect();
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
          setState("idle");
          pushAgentStatus(true);
        } else if (
          (st === "failed" || st === "disconnected" || st === "closed") &&
          enabledRef.current
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
    if (!enabledRef.current) return;
    teardown();
    const attempt = reconnectAttemptRef.current++;
    setState("connecting");
    reconnectTimerRef.current = window.setTimeout(() => {
      reconnectTimerRef.current = null;
      void connect();
    }, backoffDelay(attempt));
  }, [connect, teardown]);

  /** User toggles voice on/off. */
  const toggle = useCallback(async (): Promise<void> => {
    vlog("toggle — enabled:", enabledRef.current ? "on→off" : "off→on");
    if (enabledRef.current) {
      enabledRef.current = false;
      teardown();
      distillAtCloseRef.current();
      // Deliberate end-of-session: unresolved calls must NOT replay into a
      // future session (a Tuesday call answering itself Thursday would be
      // confusing, not helpful). Auto-reconnect keeps the map — only the
      // user's toggle-off discards it.
      pendingCallsRef.current.clear();
      setState("off");
      return;
    }
    enabledRef.current = true;
    reconnectAttemptRef.current = 0;
    eventCountRef.current = 0;
    await connect();
  }, [connect, teardown]);

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

  // Voice/accent changed in settings (Profile) → re-mint a live session.
  // Voice + accent are baked in at mint time; a settings change with no
  // reconnect meant the old voice/accent kept playing until manual
  // restart. Immediate swap, zero backoff — this is a deliberate change,
  // not a network failure.
  useEffect(() => {
    const unlisten = window.electronAPI.on(
      "pane:voice-settings-changed",
      () => {
        if (!enabledRef.current) return;
        vlog("voice settings changed — re-minting live session");
        // Reset the attempt counter so the swap takes the shortest
        // backoff (1s at attempt 0) — a deliberate change, not failure.
        reconnectAttemptRef.current = 0;
        scheduleReconnect();
      },
    );
    return unlisten;
  }, [scheduleReconnect]);

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
  };
}
