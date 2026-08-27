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
  type: string;
  [key: string]: unknown;
}

const PANE_MIC_KEY = "pane.micDeviceId";

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

  const pinned = pinnedId ?? (() => {
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

  const constraints: MediaStreamConstraints = chosen
    ? { audio: { deviceId: { exact: chosen.deviceId } } }
    : { audio: true };
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
  projectId: string;
  projectRoot: string | null;
  getAgentStatus: () => AgentStatusSnapshot;
  onDelegate: (instruction: string, phase: "think" | "build") => void;
}) {
  const { projectId, projectRoot, getAgentStatus, onDelegate } = opts;

  // Project name for the companion journal — read once per project switch.
  // Fallback to the path tail so journal entries are placeable even when
  // the store hasn't hydrated.
  const projectNameRef = useRef<string>(projectId);
  useEffect(() => {
    const proj = useProjectsStore.getState().projects.get(projectId);
    projectNameRef.current = proj?.name ?? projectId;
  }, [projectId]);

  /** Journal this exchange into the companion memory (voice's episodic
   *  memory of conversations). Fire-and-forget: memory failures never
   *  touch the live session. Debounced per role so interleaved transcript
   *  events for one utterance journal once. */
  const journalTimerRef = useRef<Record<"user" | "assistant", number | null>>({ user: null, assistant: null });
  const pendingJournalRef = useRef<Record<"user" | "assistant", string | null>>({ user: null, assistant: null });
  const exchangeCountRef = useRef(0);
  const writeJournalRef = useRef((role: "user" | "assistant", text: string): void => {
    const t = text.trim();
    if (t.length < 2) return;
    exchangeCountRef.current += 1;
    pendingJournalRef.current[role] = null;
    void window.electronAPI
      .invoke("voice_journal_exchange", {
        role,
        text: t,
        projectId,
        projectName: projectNameRef.current,
      })
      .catch(() => undefined); // diagnostics only — never surface
  });
  const journalRef = useRef((role: "user" | "assistant", text: string): void => {
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
  });

  const [state, setState] = useState<VoiceState>("off");
  const [error, setError] = useState<string | null>(null);
  const [transcript, setTranscript] = useState<string>(""); // last user utterance (live)
  const [lastSpoken, setLastSpoken] = useState<string>(""); // last model utterance
  const [available, setAvailable] = useState<boolean | null>(null); // null = unchecked
  const [micStream, setMicStream] = useState<MediaStream | null>(null); // for the orb analyser
  const [micDevices, setMicDevices] = useState<Array<{ deviceId: string; label: string }>>([]);
  const [activeMicId, setActiveMicId] = useState<string | null>(null); // deviceId of the live input
  const audioPulseRef = useRef(0); // mutable counter, bumped per model audio delta — no re-renders

  // ── Refs (stable across renders; session state lives here) ────────────
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const dcRef = useRef<RTCDataChannel | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const audioElRef = useRef<HTMLAudioElement | null>(null);
  const enabledRef = useRef(false); // user intent: session should be live
  const reconnectAttemptRef = useRef(0);
  const reconnectTimerRef = useRef<number | null>(null);
  const statusRef = useRef(getAgentStatus);
  const delegateRef = useRef(onDelegate);
  const projectRef = useRef({ projectId, projectRoot });
  const lastStatusPushRef = useRef<string | null>(null);
  const eventCountRef = useRef(0);
  const deltaCountRef = useRef(0); // audio deltas are high-rate — counted, not logged
  // Events fired while the data channel is still handshaking. The channel
  // opens ~400ms AFTER pc.connectionState becomes "connected" (DTLS/SCTP
  // completes after ICE) — sends in that window used to be silent no-ops,
  // dropping the session's initial context item every single time.
  const pendingSendsRef = useRef<RealtimeEvent[]>([]);
  const statsTimerRef = useRef<number | null>(null);
  // Mic capture diagnostics: meters the EXACT stream we send to OpenAI so
  // "silent capture" (dead Bluetooth input, zero input volume) is provable
  // locally instead of masquerading as "model not responding".
  const meterTimerRef = useRef<number | null>(null);
  const meterCtxRef = useRef<AudioContext | null>(null);
  const sawSignalRef = useRef(false); // any sample above noise floor, ever

  statusRef.current = getAgentStatus;
  delegateRef.current = onDelegate;
  projectRef.current = { projectId, projectRoot };

  /** Send a client event over the data channel. Sends issued while the
   *  channel is still handshaking are QUEUED and flushed when it opens —
   *  the old version silently dropped them, losing the session's initial
   *  context item every time (the channel opens ~400ms after the peer
   *  connection reports "connected"). */
  const send = useCallback((event: RealtimeEvent): void => {
    const dc = dcRef.current;
    if (dc && dc.readyState === "open") {
      dc.send(JSON.stringify(event));
    } else if (enabledRef.current) {
      pendingSendsRef.current.push(event);
      vlog("send queued (channel not open):", event.type);
    } else {
      vlog("send dropped (channel closed, voice off):", event.type);
    }
  }, []);

  /** Tear down the current session completely (tracks, channel, timers). */
  const teardown = useCallback((): void => {
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
    void window.electronAPI
      .invoke("voice_distill_memory", { sessionExchanges: count })
      .catch(() => undefined);
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
          (active.length > 0 ? `, agents running: ${activeNames}` : ", no agents running") +
          (activeFile ? `, open file: ${activeFile}` : "");
      } catch {
        /* store read failed — agent line only */
      }
      const agentLine = snap.running
        ? `agent is working: ${snap.lastLine ?? "processing"}`
        : "agent is idle";
      const line = `${workspaceLine} | ${agentLine}`;
      if (!force && line === lastStatusPushRef.current) return; // dedupe
      lastStatusPushRef.current = line;
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

  /** Handle a function call from the model; send the output back. */
  const handleFunctionCall = useCallback(
    (callId: string, name: string, argsJson: string): void => {
      let output: string;
      let thenRespond = true;

      if (name === "delegate_task") {
        try {
          const args = JSON.parse(argsJson || "{}") as {
            instruction?: string;
            phase?: "think" | "build";
          };
          const instruction = (args.instruction || "").trim();
          if (!instruction) {
            output = JSON.stringify({ ok: false, error: "instruction required" });
          } else {
            delegateRef.current(instruction, args.phase === "think" ? "think" : "build");
            output = JSON.stringify({
              ok: true,
              note: "Agent started. Watch conversation.item inputs for progress.",
            });
          }
        } catch (err) {
          output = JSON.stringify({ ok: false, error: String(err) });
        }
      } else if (name === "get_agent_status") {
        const snap = statusRef.current();
        output = JSON.stringify({
          running: snap.running,
          current: snap.lastLine,
        });
      } else if (name === "workspace_state") {
        // Snapshot of threads/activity — executed in main, same flow as
        // run_knowledge_tool.
        thenRespond = false;
        const { invoke } = window.electronAPI;
        void (async () => {
          let result: string;
          try {
            const res = (await invoke("voice_tool_call", {
              projectId: projectRef.current.projectId,
              projectRoot: projectRef.current.projectRoot,
              tool: "workspace_state",
              args: {},
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
            item: { type: "function_call_output", call_id: callId, output: result },
          });
          send({ type: "response.create" });
        })();
        return;
      } else if (name === "look_at_screen") {
        // Sight: capture the Pane window in main, push it into the
        // conversation as input_image, then answer with the function output.
        thenRespond = false;
        const { invoke } = window.electronAPI;
        void (async () => {
          let parsed: { detail?: "low" | "high" } = {};
          try {
            parsed = JSON.parse(argsJson || "{}") as { detail?: "low" | "high" };
          } catch {
            /* default detail */
          }
          let output: string;
          let imageUri: string | null = null;
          try {
            const res = (await invoke("voice_capture_screen", {
              detail: parsed.detail === "high" ? "high" : "low",
            })) as { ok?: boolean; image?: string; width?: number; error?: string };
            if (res?.ok && res.image) {
              imageUri = res.image;
              output = JSON.stringify({ ok: true, note: `Screenshot captured (${res.width ?? "?"}px wide). It is attached to the conversation — look at it, then respond.` });
            } else {
              output = JSON.stringify({ ok: false, error: res?.error ?? "capture failed" });
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
                  { type: "input_text", text: "[screen capture — the Pane window as the user sees it now]" },
                  { type: "input_image", image_url: imageUri, detail: parsed.detail === "high" ? "high" : "low" },
                ],
              },
            });
          }
          send({
            type: "conversation.item.create",
            item: { type: "function_call_output", call_id: callId, output },
          });
          send({ type: "response.create" });
        })();
        return;
      } else if (name === "run_knowledge_tool" || name === "mcp_call" || name === "recall_conversation") {
        // Executed async below — this branch just defines the flow.
        thenRespond = false;
        const { invoke } = window.electronAPI;
        void (async () => {
          let result: string;
          try {
            const parsed = JSON.parse(argsJson || "{}") as { tool?: string; args?: object; query?: string; days_back?: number };
            // run_knowledge_tool carries the real tool name in { tool, args };
            // mcp_call and recall_conversation are the tools themselves.
            const invokeTool = name === "run_knowledge_tool" ? parsed.tool : name;
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
            item: { type: "function_call_output", call_id: callId, output: result },
          });
          send({ type: "response.create" });
        })();
        return;
      } else {
        output = JSON.stringify({ ok: false, error: `unknown function ${name}` });
      }

      send({
        type: "conversation.item.create",
        item: { type: "function_call_output", call_id: callId, output },
      });
      if (thenRespond) send({ type: "response.create" });
    },
    [send],
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
          vlog("…audio deltas:", deltaCountRef.current, "last type:", event.type);
        }
      }
      switch (event.type) {
        case "input_audio_buffer.speech_started":
          setState("listening");
          break;
        case "input_audio_buffer.speech_stopped":
          setState("thinking");
          break;
        case "conversation.item.input_audio_transcription.completed": {
          const transcriptText = (event as { transcript?: string }).transcript ?? "";
          if (transcriptText) {
            setTranscript(transcriptText);
            journalRef.current("user", transcriptText);
          }
          break;
        }
        case "response.output_item.done": {
          const item = (event as { item?: { type?: string; call_id?: string; name?: string; arguments?: string; transcript?: string } }).item;
          if (item?.type === "function_call" && item.call_id) {
            handleFunctionCall(item.call_id, item.name ?? "", item.arguments ?? "{}");
          } else if (item?.type === "message" && item.transcript) {
            setLastSpoken(item.transcript);
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
          const detail = (event as { error?: { message?: string } | string }).error;
          const msg = typeof detail === "string" ? detail : detail?.message ?? "realtime error";
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
      vlog("mic permission repair:", res?.ok ? "TCC record reset — retrying" : `failed: ${res?.error}`);
      return !!res?.ok;
    } catch (err) {
      vlog("mic permission repair unavailable:", err instanceof Error ? err.message : String(err));
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
        .map((d) => ({ deviceId: d.deviceId, label: d.label || "(unnamed input)" }));
      setMicDevices(inputs);
      vlog("input devices:", inputs.map((d) => d.label).join(" | ") || "(none)");
    } catch (err) {
      vlog("enumerateDevices failed:", err instanceof Error ? err.message : String(err));
    }
  }, []);

  /** Establish the session (token + WebRTC + data channel). */
  const connect = useCallback(async (): Promise<void> => {
    if (pcRef.current) return; // already live
    setState("connecting");
    setError(null);

    try {
      const snap = statusRef.current();
      const statusLine = snap.running ? `working: ${snap.lastLine ?? "processing"}` : "idle";
      const mint = (await window.electronAPI.invoke("voice_mint_token", {
        projectId: projectRef.current.projectId,
        projectRoot: projectRef.current.projectRoot,
        agentStatus: statusLine,
      })) as { ok: boolean; token?: string; instructions?: string; error?: string };
      if (!mint?.ok || !mint.token) {
        const reason = mint?.error ?? "token mint failed";
        console.error("[voice] session could not start:", reason);
        setState("error");
        setAvailable(false);
        setError(reason);
        enabledRef.current = false;
        return;
      }
      setAvailable(true);

      // ── WebRTC setup (verified flow from OpenAI realtime-webrtc docs) ──
      const mic = await acquireMic(micDeviceIdRef.current);
      micStreamRef.current = mic;
      setMicStream(mic);
      const micTrack = mic.getTracks()[0];
      if (!micTrack) throw new Error("microphone granted no audio track");
      vlog("mic acquired — label:", micTrack.label || "(no label)", "enabled:", micTrack.enabled);
      setActiveMicId(micTrack.getSettings().deviceId ?? null);
      // Labels are empty pre-permission; re-enumerate now that we have it.
      void refreshMicDevices();

      // ── Capture diagnostics: meter the exact stream we send ──────────
      // bytesSent rising proves transport, NOT that the payload contains
      // a voice. A dead Bluetooth input or zero input volume still sends
      // bytes — encoded silence. This meter proves which one we have.
      try {
        const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
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
            if (peak <= 0.02) silentMs += 500; else silentMs = 0;
            vlog(
              "mic meter — peak:", peak.toFixed(4),
              "rms:", rms.toFixed(4),
              "sawSignal:", sawSignalRef.current ? "yes" : "no",
            );
            // Dead-capture warning (once): 12s of digital silence while live
            // is a capture failure, not "model ignoring you".
            if (!warned && silentMs >= 12000 && !sawSignalRef.current) {
              warned = true;
              vlog("⚠ MIC SILENT 12s+ — captured stream is digital silence. Check input device/volume. label:", micTrack.label);
              setError(`Mic is capturing silence (${micTrack.label}). Check your input device — System Settings → Sound → Input.`);
            }
          }, 500);
        }
      } catch (meterErr) {
        vlog("mic meter unavailable (non-fatal):", meterErr instanceof Error ? meterErr.message : String(meterErr));
      }

      const pc = new RTCPeerConnection();
      pcRef.current = pc;

      const audioEl = document.createElement("audio");
      audioEl.autoplay = true;
      audioElRef.current = audioEl;
      pc.ontrack = (e: RTCTrackEvent) => {
        audioEl.srcObject = e.streams[0] ?? null;
        vlog("remote track arrived — audio element updated");
      };

      pc.addTrack(micTrack);

      const dc = pc.createDataChannel("oai-events");
      dcRef.current = dc;
      dc.onopen = () => {
        vlog("data channel OPEN — flushing", pendingSendsRef.current.length, "queued sends");
        for (const ev of pendingSendsRef.current) dc.send(JSON.stringify(ev));
        pendingSendsRef.current = [];
        // Proof of outbound audio: if bytesSent rises while you speak,
        // mic audio reaches OpenAI and any silence is server/model-side.
        statsTimerRef.current = window.setInterval(() => {
          const p = pcRef.current;
          if (!p) return;
          void p.getStats().then((report) => {
            for (const entry of report.values()) {
              const t = entry as { type?: string; kind?: string; bytesSent?: number; bytesReceived?: number };
              if (t.type === "outbound-rtp" && t.kind === "audio" && typeof t.bytesSent === "number") {
                vlog("stats outbound-rtp audio bytesSent:", t.bytesSent);
              }
            }
          }).catch(() => undefined);
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
        vlog("data channel closed", enabledRef.current ? "(unexpected — will reconnect)" : "(expected — user off)");
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
        throw new Error(`SDP exchange failed ${sdpRes.status}: ${body.slice(0, 300)}`);
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
        } else if ((st === "failed" || st === "disconnected" || st === "closed") && enabledRef.current) {
          vlog("connection lost — scheduling reconnect, attempt", reconnectAttemptRef.current + 1);
          scheduleReconnect();
        }
      };
    } catch (err) {
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
  const selectMic = useCallback((deviceId: string): void => {
    micDeviceIdRef.current = deviceId;
    try {
      localStorage.setItem(PANE_MIC_KEY, deviceId);
    } catch {
      /* storage unavailable — session-only selection */
    }
    vlog("mic pinned:", deviceId);
    if (enabledRef.current) scheduleReconnect();
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pushAgentStatus, state === "off"]);

  // ── Cleanup on unmount / project switch ─────────────────────────────────
  useEffect(() => {
    return () => {
      enabledRef.current = false;
      teardown();
      distillAtCloseRef.current();
    };
  }, [teardown]);

  // Reset live transcript state when switching projects.
  useEffect(() => {
    setTranscript("");
    setLastSpoken("");
    lastStatusPushRef.current = null;
  }, [projectId]);

  // Reconnect when project changes and voice is on: session carries project-
  // specific instructions, so mint a fresh token for the new project.
  useEffect(() => {
    if (!enabledRef.current) return;
    scheduleReconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

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
    toggle,
    interrupt,
    /** Imperative status push — e.g. right after delegation fires. */
    pushAgentStatus,
  };
}
