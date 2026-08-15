/**
 * useVoiceMode — voice input (STT via Whisper) + voice output (TTS via OpenAI)
 *
 * Same request-response model as typing. Click mic → record → transcribe → onSend().
 * When voice mode is active, assistant responses are spoken aloud via TTS.
 *
 * Requires an OpenAI API key in settings (httpApiKeys.openai).
 */

import { useState, useCallback, useRef, useEffect } from "react";
import { create } from "zustand";
import { useWorkspaceStore } from "../stores/workspace";

// ── Global voice state store (for VoiceGlow overlay) ─────────────────────────

interface VoiceStateStore {
  state: VoiceState;
  setState: (s: VoiceState) => void;
}

export const useVoiceStateStore = create<VoiceStateStore>((set) => ({
  state: "idle",
  setState: (s) => set({ state: s }),
}));

// ── Types ────────────────────────────────────────────────────────────────────

export type VoiceState =
  | "idle"           // not recording, not speaking
  | "recording"      // mic is active, capturing audio
  | "transcribing"   // audio sent to Whisper, waiting for text
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
  /** Whether an OpenAI key is configured */
  hasApiKey: boolean;
  /** Error message if something went wrong */
  error: string | null;
}

// ── Constants ────────────────────────────────────────────────────────────────

const WHISPER_URL = "https://api.openai.com/v1/audio/transcriptions";
const TTS_URL = "https://api.openai.com/v1/audio/speech";
const TTS_MODEL = "gpt-4o-mini-tts";
const TTS_VOICE = "ash";
const TTS_INSTRUCTIONS =
  "Voice and personality: direct, concise, technical. " +
  "You are a collaborator — not an assistant. Speak naturally but efficiently. " +
  "No filler words, no hedging. When reading code or file paths, say them clearly.";

// ── Hook ─────────────────────────────────────────────────────────────────────

export function useVoiceMode(): UseVoiceModeReturn {
  const [state, setStateLocal] = useState<VoiceState>("idle");
  const [enabled, setEnabled] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Sync to global store so VoiceGlow can read it from App level
  const setGlobalState = useVoiceStateStore((s) => s.setState);
  const setState = useCallback((s: VoiceState) => {
    setStateLocal(s);
    setGlobalState(s);
  }, [setGlobalState]);

  // Refs for cleanup
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const audioElementRef = useRef<HTMLAudioElement | null>(null);
  const audioUrlRef = useRef<string | null>(null);

  // Get OpenAI API key from workspace store
  const apiKey = useWorkspaceStore((s) => s.httpApiKeys?.openai || "");
  const hasApiKey = !!apiKey;

  // ── Cleanup on unmount ───────────────────────────────────────────────────
  useEffect(() => {
    return () => {
      // Stop any active recording
      if (mediaRecorderRef.current?.state === "recording") {
        mediaRecorderRef.current.stop();
      }
      // Release mic stream
      streamRef.current?.getTracks().forEach((t) => t.stop());
      // Stop audio playback
      if (audioElementRef.current) {
        audioElementRef.current.pause();
        audioElementRef.current = null;
      }
      // Revoke blob URL
      if (audioUrlRef.current) {
        URL.revokeObjectURL(audioUrlRef.current);
        audioUrlRef.current = null;
      }
    };
  }, []);

  // ── Toggle voice mode ────────────────────────────────────────────────────
  const toggleEnabled = useCallback(() => {
    setEnabled((prev) => {
      if (prev) {
        // Turning off — stop everything
        if (mediaRecorderRef.current?.state === "recording") {
          mediaRecorderRef.current.stop();
        }
        streamRef.current?.getTracks().forEach((t) => t.stop());
        if (audioElementRef.current) {
          audioElementRef.current.pause();
        }
        setState("idle");
      }
      return !prev;
    });
    setError(null);
  }, []);

  // ── Start recording ──────────────────────────────────────────────────────
  const startRecording = useCallback(async () => {
    if (!hasApiKey) {
      setError("OpenAI API key required for voice mode. Add it in settings.");
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

      // Use webm/opus — Whisper accepts it natively
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

      recorder.start(100); // Collect data every 100ms
      setState("recording");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Microphone access denied";
      setError(msg);
      setState("idle");
    }
  }, [hasApiKey]);

  // ── Stop recording and transcribe ────────────────────────────────────────
  const stopAndTranscribe = useCallback(async (): Promise<string | null> => {
    const recorder = mediaRecorderRef.current;
    if (!recorder || recorder.state !== "recording") {
      return null;
    }

    // Stop recording and wait for final data
    return new Promise<string | null>((resolve) => {
      recorder.onstop = async () => {
        // Release mic immediately
        streamRef.current?.getTracks().forEach((t) => t.stop());
        streamRef.current = null;

        const chunks = audioChunksRef.current;
        if (chunks.length === 0) {
          setState("idle");
          resolve(null);
          return;
        }

        const audioBlob = new Blob(chunks, { type: recorder.mimeType });
        audioChunksRef.current = [];

        // Skip tiny recordings (likely accidental clicks)
        if (audioBlob.size < 1000) {
          setState("idle");
          resolve(null);
          return;
        }

        setState("transcribing");

        try {
          const formData = new FormData();
          formData.append("file", audioBlob, "recording.webm");
          formData.append("model", "whisper-1");
          formData.append("response_format", "json");

          const response = await fetch(WHISPER_URL, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${apiKey}`,
            },
            body: formData,
          });

          if (!response.ok) {
            const errBody = await response.text();
            throw new Error(`Whisper API error ${response.status}: ${errBody}`);
          }

          const result = await response.json();
          const text = result.text?.trim();

          setState("idle");

          if (text) {
            resolve(text);
          } else {
            resolve(null);
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : "Transcription failed";
          setError(msg);
          setState("idle");
          resolve(null);
        }
      };

      recorder.stop();
    });
  }, [apiKey]);

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

  // ── Speak text via TTS ───────────────────────────────────────────────────
  const speak = useCallback(
    async (text: string) => {
      if (!hasApiKey || !text.trim()) return;

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
        .replace(/```[\s\S]*?```/g, " (code block) ") // code blocks → spoken label
        .replace(/`([^`]+)`/g, "$1") // inline code → just the text
        .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1") // links → just the text
        .replace(/#{1,6}\s/g, "") // headings
        .replace(/[*_]{1,3}/g, "") // bold/italic markers
        .replace(/\n{2,}/g, ". ") // paragraph breaks → pause
        .replace(/\n/g, " ") // single newlines → space
        .replace(/\s{2,}/g, " ") // collapse whitespace
        .trim();

      if (!cleanText) return;

      // Truncate very long responses — TTS is expensive for walls of text
      const MAX_TTS_CHARS = 4000;
      const truncated =
        cleanText.length > MAX_TTS_CHARS
          ? cleanText.slice(0, MAX_TTS_CHARS) + "... I'll stop there. The rest is in the text."
          : cleanText;

      setState("speaking");

      try {
        const response = await fetch(TTS_URL, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: TTS_MODEL,
            input: truncated,
            voice: TTS_VOICE,
            instructions: TTS_INSTRUCTIONS,
            response_format: "mp3",
          }),
        });

        if (!response.ok) {
          const errBody = await response.text();
          throw new Error(`TTS API error ${response.status}: ${errBody}`);
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
    [apiKey, hasApiKey],
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
  }, [state]);

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
    error,
  };
}
