/**
 * useVoiceMode — voice input (STT) + voice output (TTS)
 *
 * Same request-response model as typing. Click mic → record → transcribe → onSend().
 * When voice mode is active, assistant responses are spoken aloud via TTS.
 *
 * Provider priority (ElevenLabs key present → full ElevenLabs pipeline, no OpenAI needed):
 *   STT: ElevenLabs Scribe v2 > OpenAI Whisper
 *   TTS: ElevenLabs Flash v2.5 > OpenAI gpt-4o-mini-tts
 *
 * Audio feedback: real-time mic level exposed via useVoiceStateStore.audioLevel
 * for volume-reactive UI (VoiceGlow). Auto-stops after silence threshold.
 */

import { useState, useCallback, useRef, useEffect } from "react";
import { create } from "zustand";
import { useWorkspaceStore } from "../stores/workspace";

// ── Global voice state store (for VoiceGlow overlay) ─────────────────────────

interface VoiceStateStore {
  state: VoiceState;
  /** 0–1 normalized mic input level, updated ~30fps during recording */
  audioLevel: number;
  setState: (s: VoiceState) => void;
  setAudioLevel: (level: number) => void;
}

export const useVoiceStateStore = create<VoiceStateStore>((set) => ({
  state: "idle",
  audioLevel: 0,
  setState: (s) => set({ state: s }),
  setAudioLevel: (level) => set({ audioLevel: level }),
}));

// ── Types ────────────────────────────────────────────────────────────────────

export type VoiceState =
  | "idle"           // not recording, not speaking
  | "recording"      // mic is active, capturing audio
  | "transcribing"   // audio sent to STT API, waiting for text
  | "speaking";      // TTS audio playing back

interface UseVoiceModeReturn {
  /** Current state of the voice pipeline */
  state: VoiceState;
  /** Whether voice mode is enabled (persists across messages) */
  enabled: boolean;
  /** Toggle voice mode on/off */
  toggleEnabled: () => void;
  /** Start recording from mic */
  startRecording: () => Promise<void>;
  /** Stop recording and transcribe — returns the transcribed text */
  stopAndTranscribe: () => Promise<string | null>;
  /** Toggle recording: start if idle, stop+transcribe if recording */
  toggleRecording: () => Promise<string | null>;
  /** Speak text aloud via TTS */
  speak: (text: string) => Promise<void>;
  /** Stop any currently playing TTS audio */
  stopSpeaking: () => void;
  /** Whether a voice API key is configured (ElevenLabs or OpenAI) */
  hasApiKey: boolean;
  /** Which TTS provider is active */
  ttsProvider: "elevenlabs" | "openai" | "none";
  /** Error message if something went wrong */
  error: string | null;
}

// ── Constants ────────────────────────────────────────────────────────────────

// STT — ElevenLabs Scribe v2 (preferred) or OpenAI Whisper (fallback)
const ELEVENLABS_STT_URL = "https://api.elevenlabs.io/v1/speech-to-text";
const WHISPER_URL = "https://api.openai.com/v1/audio/transcriptions";

// STT timeout — don't hang forever on network issues
const STT_TIMEOUT_MS = 15_000;

// Silence detection
const SILENCE_THRESHOLD = 0.02;  // audio level below this = silence
const SILENCE_DURATION_MS = 1800; // 1.8s of silence → auto-stop

// TTS — OpenAI fallback
const OPENAI_TTS_URL = "https://api.openai.com/v1/audio/speech";
const OPENAI_TTS_MODEL = "gpt-4o-mini-tts";
const OPENAI_TTS_VOICE = "ash";
const OPENAI_TTS_INSTRUCTIONS =
  "Voice and personality: direct, concise, technical. " +
  "You are a collaborator — not an assistant. Speak naturally but efficiently. " +
  "No filler words, no hedging. When reading code or file paths, say them clearly.";

// TTS — ElevenLabs (preferred when key is present)
const ELEVENLABS_TTS_VOICE_ID = "iP95p4xoKVk53GoZ742B";
const ELEVENLABS_TTS_MODEL = "eleven_flash_v2_5";

// ── Hook ─────────────────────────────────────────────────────────────────────

export function useVoiceMode(): UseVoiceModeReturn {
  const [state, setStateLocal] = useState<VoiceState>("idle");
  const [enabled, setEnabled] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Sync to global store so VoiceGlow can read it from App level
  const setGlobalState = useVoiceStateStore((s) => s.setState);
  const setGlobalAudioLevel = useVoiceStateStore((s) => s.setAudioLevel);
  const setState = useCallback((s: VoiceState) => {
    setStateLocal(s);
    setGlobalState(s);
    if (s !== "recording") setGlobalAudioLevel(0);
  }, [setGlobalState, setGlobalAudioLevel]);

  // Refs for cleanup
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const audioElementRef = useRef<HTMLAudioElement | null>(null);
  const audioUrlRef = useRef<string | null>(null);

  // Audio analyser refs
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const animFrameRef = useRef<number | null>(null);

  // Silence detection refs
  const silenceStartRef = useRef<number | null>(null);
  const autoStopTriggeredRef = useRef(false);
  // Store the resolve callback for auto-stop to call
  const pendingResolveRef = useRef<((text: string | null) => void) | null>(null);

  // Get API keys from workspace store
  const openaiKey = useWorkspaceStore((s) => s.httpApiKeys?.openai || "");
  const elevenLabsKey = useWorkspaceStore((s) => s.httpApiKeys?.elevenlabs || "");
  const useElevenLabs = !!elevenLabsKey;
  const hasApiKey = useElevenLabs || !!openaiKey;

  // ── Audio level monitoring ───────────────────────────────────────────────
  const startAudioMonitoring = useCallback((stream: MediaStream) => {
    try {
      const audioCtx = new AudioContext();
      const source = audioCtx.createMediaStreamSource(stream);
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.4;
      source.connect(analyser);

      audioContextRef.current = audioCtx;
      analyserRef.current = analyser;
      silenceStartRef.current = null;
      autoStopTriggeredRef.current = false;

      const dataArray = new Uint8Array(analyser.frequencyBinCount);

      const tick = () => {
        if (!analyserRef.current) return;

        analyser.getByteFrequencyData(dataArray);

        // RMS-ish level: average of frequency magnitudes, normalized to 0–1
        let sum = 0;
        for (let i = 0; i < dataArray.length; i++) {
          sum += dataArray[i]!;
        }
        const avg = sum / dataArray.length / 255;
        // Apply slight curve so quiet sounds register more visibly
        const level = Math.min(1, Math.pow(avg, 0.6) * 2.5);

        setGlobalAudioLevel(level);

        // ── Silence detection ────────────────────────────────────────
        if (level < SILENCE_THRESHOLD) {
          if (silenceStartRef.current === null) {
            silenceStartRef.current = Date.now();
          } else if (
            !autoStopTriggeredRef.current &&
            Date.now() - silenceStartRef.current > SILENCE_DURATION_MS
          ) {
            // Silence exceeded threshold — auto-stop
            autoStopTriggeredRef.current = true;
            // Trigger stop from outside the animation frame
            triggerAutoStop();
            return; // Stop the loop
          }
        } else {
          // Voice detected — reset silence timer
          silenceStartRef.current = null;
        }

        animFrameRef.current = requestAnimationFrame(tick);
      };

      animFrameRef.current = requestAnimationFrame(tick);
    } catch {
      // AudioContext not available — degrade gracefully, no volume feedback
    }
  }, [setGlobalAudioLevel]);

  const stopAudioMonitoring = useCallback(() => {
    if (animFrameRef.current) {
      cancelAnimationFrame(animFrameRef.current);
      animFrameRef.current = null;
    }
    analyserRef.current = null;
    if (audioContextRef.current) {
      audioContextRef.current.close().catch(() => {});
      audioContextRef.current = null;
    }
    setGlobalAudioLevel(0);
    silenceStartRef.current = null;
  }, [setGlobalAudioLevel]);

  // ── Cleanup on unmount ───────────────────────────────────────────────────
  useEffect(() => {
    return () => {
      if (mediaRecorderRef.current?.state === "recording") {
        mediaRecorderRef.current.stop();
      }
      streamRef.current?.getTracks().forEach((t) => t.stop());
      if (audioElementRef.current) {
        audioElementRef.current.pause();
        audioElementRef.current = null;
      }
      if (audioUrlRef.current) {
        URL.revokeObjectURL(audioUrlRef.current);
        audioUrlRef.current = null;
      }
      stopAudioMonitoring();
    };
  }, [stopAudioMonitoring]);

  // ── Toggle voice mode ────────────────────────────────────────────────────
  const toggleEnabled = useCallback(() => {
    setEnabled((prev) => {
      if (prev) {
        if (mediaRecorderRef.current?.state === "recording") {
          mediaRecorderRef.current.stop();
        }
        streamRef.current?.getTracks().forEach((t) => t.stop());
        stopAudioMonitoring();
        if (audioElementRef.current) {
          audioElementRef.current.pause();
        }
        setState("idle");
      }
      return !prev;
    });
    setError(null);
  }, [stopAudioMonitoring, setState]);

  // ── Transcribe audio blob ────────────────────────────────────────────────
  const transcribeBlob = useCallback(async (audioBlob: Blob): Promise<string | null> => {
    if (audioBlob.size < 1000) return null; // skip tiny recordings

    setState("transcribing");

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), STT_TIMEOUT_MS);

    try {
      let text: string | undefined;

      if (useElevenLabs) {
        const formData = new FormData();
        formData.append("file", audioBlob, "recording.webm");
        formData.append("model_id", "scribe_v2");

        const response = await fetch(ELEVENLABS_STT_URL, {
          method: "POST",
          headers: { "xi-api-key": elevenLabsKey },
          body: formData,
          signal: controller.signal,
        });

        if (!response.ok) {
          const errBody = await response.text();
          throw new Error(`ElevenLabs STT error ${response.status}: ${errBody}`);
        }

        const result = await response.json();
        text = result.text?.trim();
      } else {
        const formData = new FormData();
        formData.append("file", audioBlob, "recording.webm");
        formData.append("model", "whisper-1");
        formData.append("response_format", "json");

        const response = await fetch(WHISPER_URL, {
          method: "POST",
          headers: { Authorization: `Bearer ${openaiKey}` },
          body: formData,
          signal: controller.signal,
        });

        if (!response.ok) {
          const errBody = await response.text();
          throw new Error(`Whisper API error ${response.status}: ${errBody}`);
        }

        const result = await response.json();
        text = result.text?.trim();
      }

      setState("idle");
      return text || null;
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        setError("Transcription timed out — try again");
      } else {
        const msg = err instanceof Error ? err.message : "Transcription failed";
        setError(msg);
      }
      setState("idle");
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }, [openaiKey, elevenLabsKey, useElevenLabs, setState]);

  // ── Start recording ──────────────────────────────────────────────────────
  const startRecording = useCallback(async () => {
    if (!hasApiKey) {
      setError("API key required for voice mode. Add ElevenLabs or OpenAI key in settings.");
      return;
    }
    setError(null);

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          sampleRate: 16000,
          echoCancellation: true,
          noiseSuppression: true,
        },
      });
      streamRef.current = stream;
      audioChunksRef.current = [];

      const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : "audio/webm";

      const recorder = new MediaRecorder(stream, { mimeType });
      mediaRecorderRef.current = recorder;

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) {
          audioChunksRef.current.push(e.data);
        }
      };

      recorder.start(100);
      setState("recording");

      // Start volume monitoring + silence detection
      startAudioMonitoring(stream);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Microphone access denied";
      setError(msg);
      setState("idle");
    }
  }, [hasApiKey, setState, startAudioMonitoring]);

  // ── Stop recording and transcribe ────────────────────────────────────────
  const stopAndTranscribe = useCallback(async (): Promise<string | null> => {
    const recorder = mediaRecorderRef.current;
    if (!recorder || recorder.state !== "recording") {
      return null;
    }

    stopAudioMonitoring();

    return new Promise<string | null>((resolve) => {
      // Store resolve so auto-stop can use it too
      pendingResolveRef.current = resolve;

      recorder.onstop = async () => {
        streamRef.current?.getTracks().forEach((t) => t.stop());
        streamRef.current = null;

        const chunks = audioChunksRef.current;
        audioChunksRef.current = [];

        if (chunks.length === 0) {
          setState("idle");
          pendingResolveRef.current = null;
          resolve(null);
          return;
        }

        const audioBlob = new Blob(chunks, { type: recorder.mimeType });

        const text = await transcribeBlob(audioBlob);
        pendingResolveRef.current = null;
        resolve(text);
      };

      recorder.stop();
    });
  }, [stopAudioMonitoring, transcribeBlob, setState]);

  // ── Auto-stop trigger (called from silence detection) ────────────────────
  const triggerAutoStop = useCallback(() => {
    // Only auto-stop if we're actually recording
    const recorder = mediaRecorderRef.current;
    if (!recorder || recorder.state !== "recording") return;

    stopAudioMonitoring();

    recorder.onstop = async () => {
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;

      const chunks = audioChunksRef.current;
      audioChunksRef.current = [];

      if (chunks.length === 0) {
        setState("idle");
        return;
      }

      const audioBlob = new Blob(chunks, { type: recorder.mimeType });
      const text = await transcribeBlob(audioBlob);

      // If there's a pending resolve from stopAndTranscribe, use it
      if (pendingResolveRef.current) {
        pendingResolveRef.current(text);
        pendingResolveRef.current = null;
      } else {
        // Auto-stop fired — dispatch a custom event so InputBar can pick it up
        if (text) {
          window.dispatchEvent(
            new CustomEvent("voice-auto-transcribed", { detail: { text } })
          );
        }
      }
    };

    recorder.stop();
  }, [stopAudioMonitoring, transcribeBlob, setState]);

  // ── Toggle: start if idle, stop+transcribe if recording ──────────────────
  const toggleRecording = useCallback(async (): Promise<string | null> => {
    if (state === "recording") {
      return stopAndTranscribe();
    } else if (state === "idle") {
      await startRecording();
      return null;
    }
    return null;
  }, [state, startRecording, stopAndTranscribe]);

  // ── Speak text via TTS (ElevenLabs preferred, OpenAI fallback) ─────────
  const speak = useCallback(
    async (text: string) => {
      if ((!useElevenLabs && !hasApiKey) || !text.trim()) return;

      // Stop any current playback
      if (audioElementRef.current) {
        audioElementRef.current.pause();
        audioElementRef.current = null;
      }
      if (audioUrlRef.current) {
        URL.revokeObjectURL(audioUrlRef.current);
        audioUrlRef.current = null;
      }

      // Strip markdown artifacts for cleaner speech
      const cleanText = text
        .replace(/```[\s\S]*?```/g, " (code block) ")
        .replace(/`([^`]+)`/g, "$1")
        .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
        .replace(/#{1,6}\s/g, "")
        .replace(/[*_]{1,3}/g, "")
        .replace(/\n{2,}/g, ". ")
        .replace(/\n/g, " ")
        .replace(/\s{2,}/g, " ")
        .trim();

      if (!cleanText) return;

      const MAX_TTS_CHARS = 4000;
      const truncated =
        cleanText.length > MAX_TTS_CHARS
          ? cleanText.slice(0, MAX_TTS_CHARS) + "... I'll stop there. The rest is in the text."
          : cleanText;

      setState("speaking");

      try {
        let response: Response;

        if (useElevenLabs) {
          response = await fetch(
            `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_TTS_VOICE_ID}`,
            {
              method: "POST",
              headers: {
                "xi-api-key": elevenLabsKey,
                "Content-Type": "application/json",
                Accept: "audio/mpeg",
              },
              body: JSON.stringify({
                text: truncated,
                model_id: ELEVENLABS_TTS_MODEL,
                voice_settings: {
                  stability: 0.4,
                  similarity_boost: 0.8,
                  style: 0.15,
                  use_speaker_boost: true,
                  speed: 1.05,
                },
              }),
            },
          );
        } else {
          response = await fetch(OPENAI_TTS_URL, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${openaiKey}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              model: OPENAI_TTS_MODEL,
              input: truncated,
              voice: OPENAI_TTS_VOICE,
              instructions: OPENAI_TTS_INSTRUCTIONS,
              response_format: "mp3",
            }),
          });
        }

        if (!response.ok) {
          const errBody = await response.text();
          const provider = useElevenLabs ? "ElevenLabs" : "OpenAI";
          throw new Error(`${provider} TTS error ${response.status}: ${errBody}`);
        }

        const audioBlob = await response.blob();
        const url = URL.createObjectURL(audioBlob);
        audioUrlRef.current = url;

        const audio = new Audio(url);
        audioElementRef.current = audio;

        audio.onended = () => {
          setState("idle");
          URL.revokeObjectURL(url);
          audioUrlRef.current = null;
          audioElementRef.current = null;
        };

        audio.onerror = () => {
          setState("idle");
          URL.revokeObjectURL(url);
          audioUrlRef.current = null;
          audioElementRef.current = null;
        };

        await audio.play();
      } catch (err) {
        const msg = err instanceof Error ? err.message : "TTS failed";
        setError(msg);
        setState("idle");
      }
    },
    [openaiKey, elevenLabsKey, hasApiKey, useElevenLabs, setState],
  );

  // ── Stop speaking ────────────────────────────────────────────────────────
  const stopSpeaking = useCallback(() => {
    if (audioElementRef.current) {
      audioElementRef.current.pause();
      audioElementRef.current = null;
    }
    if (audioUrlRef.current) {
      URL.revokeObjectURL(audioUrlRef.current);
      audioUrlRef.current = null;
    }
    if (state === "speaking") {
      setState("idle");
    }
  }, [state, setState]);

  return {
    state,
    enabled,
    toggleEnabled,
    startRecording,
    stopAndTranscribe,
    toggleRecording,
    speak,
    stopSpeaking,
    hasApiKey,
    ttsProvider: useElevenLabs ? "elevenlabs" as const : hasApiKey ? "openai" as const : "none" as const,
    error,
  };
}
