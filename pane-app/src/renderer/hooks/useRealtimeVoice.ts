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

/** Reconnect backoff: 1s, 2s, 4s, 8s, 15s, 15s… capped. */
function backoffDelay(attempt: number): number {
  return Math.min(1000 * 2 ** attempt, 15000);
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

  const [state, setState] = useState<VoiceState>("off");
  const [error, setError] = useState<string | null>(null);
  const [transcript, setTranscript] = useState<string>(""); // last user utterance (live)
  const [lastSpoken, setLastSpoken] = useState<string>(""); // last model utterance
  const [available, setAvailable] = useState<boolean | null>(null); // null = unchecked
  const [micStream, setMicStream] = useState<MediaStream | null>(null); // for the orb analyser
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

  /** Push agent status into the voice conversation as a context item. */
  const pushAgentStatus = useCallback(
    (force = false): void => {
      const snap = statusRef.current();
      const line = snap.running
        ? `agent is working: ${snap.lastLine ?? "processing"}`
        : "agent is idle";
      if (!force && line === lastStatusPushRef.current) return; // dedupe
      lastStatusPushRef.current = line;
      send({
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "system",
          content: [{ type: "input_text", text: `[agent status] ${line}` }],
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
      } else if (name === "run_knowledge_tool") {
        // Executed async below — this branch just defines the flow.
        thenRespond = false;
        const { invoke } = window.electronAPI;
        void (async () => {
          let result: string;
          try {
            const parsed = JSON.parse(argsJson || "{}") as { tool?: string; args?: object };
            const res = (await invoke("voice_tool_call", {
              projectId: projectRef.current.projectId,
              projectRoot: projectRef.current.projectRoot,
              tool: parsed.tool,
              args: parsed.args,
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
          if (transcriptText) setTranscript(transcriptText);
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
          if (t) setLastSpoken(t);
          break;
        }
        case "response.audio_transcript.done": {
          const t = (event as { transcript?: string }).transcript;
          if (t) setLastSpoken(t);
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
      const mic = await navigator.mediaDevices.getUserMedia({ audio: true });
      micStreamRef.current = mic;
      setMicStream(mic);
      const micTrack = mic.getTracks()[0];
      if (!micTrack) throw new Error("microphone granted no audio track");
      vlog("mic acquired — label:", micTrack.label || "(no label)", "enabled:", micTrack.enabled);

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
      teardown();
      setState("error");
      setError(err instanceof Error ? err.message : String(err));
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
    audioPulseRef,
    toggle,
    interrupt,
    /** Imperative status push — e.g. right after delegation fires. */
    pushAgentStatus,
  };
}
