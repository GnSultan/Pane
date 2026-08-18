/**
 * VoiceOrb — the living voice presence.
 *
 * Replaces the dead mic button. A cluster of vertical bars that:
 *   - breathe slowly when connected & idle,
 *   - react to the USER's live mic amplitude (WebAudio analyser) while
 *     they speak,
 *   - react to the MODEL's audio (delta-rate driven) while it speaks.
 *
 * The motion is real signal, not looping CSS: the analyser reads actual
 * samples from the mic stream every frame, so when you speak it moves
 * because it's hearing you.
 *
 * When off: three dim static bars (a resting glyph, not animated).
 * Error state: dim red bars + tooltip with the exact upstream error.
 */

import { useEffect, useRef } from "react";

export interface VoiceOrbProps {
  state:
    | "off"
    | "idle"
    | "connecting"
    | "listening"
    | "thinking"
    | "speaking"
    | "error";
  error?: string | null;
  micStream?: MediaStream | null;
  /** Mutable counter bumped once per model audio delta — the rAF loop
   *  converts its rate-of-change into speaking intensity. No re-renders. */
  audioPulseRef?: { current: number };
  /** Toggle session on/off (called when off/error → start, live → stop). */
  onToggle: () => void;
  /** Interrupt model speech (click while speaking). */
  onInterrupt: () => void;
}

const BAR_COUNT = 5;

export function VoiceOrb({ state, error, micStream, audioPulseRef, onToggle, onInterrupt }: VoiceOrbProps) {
  // Levels 0..1 per bar. 0 = floor height. Updated by rAF, rendered imperatively.
  const barRefs = useRef<Array<HTMLSpanElement | null>>([]);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const rafRef = useRef<number | null>(null);
  // Smoothed intensity for model speech, derived from audioPulseRef rate.
  const speakLevelRef = useRef(0);

  // ── Attach analyser to the mic stream when present ────────────────────
  useEffect(() => {
    if (!micStream || state === "off") {
      analyserRef.current = null;
      return;
    }
    try {
      const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctx) return;
      const ctx = new Ctx();
      audioCtxRef.current = ctx;
      const src = ctx.createMediaStreamSource(micStream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      src.connect(analyser); // analyser only — never connected to destination
      analyserRef.current = analyser;
      return () => {
        analyserRef.current = null;
        void ctx.close().catch(() => undefined);
        audioCtxRef.current = null;
      };
    } catch {
      analyserRef.current = null;
    }
  }, [micStream, state === "off"]);

  // ── The animation loop ─────────────────────────────────────────────────
  useEffect(() => {
    if (state === "off") return;

    const buf = new Uint8Array(128);
    const startTime = performance.now();
    let lastPulseCount = audioPulseRef?.current ?? 0;

    const tick = (now: number): void => {
      const t = (now - startTime) / 1000;
      let user = 0;

      // Real mic amplitude when available
      const analyser = analyserRef.current;
      if (analyser) {
        analyser.getByteTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) {
          const sample = buf[i] ?? 128;
          const v = (sample - 128) / 128;
          sum += v * v;
        }
        user = Math.min(1, Math.sqrt(sum / buf.length) * 4);
      }

      for (let i = 0; i < BAR_COUNT; i++) {
        const el = barRefs.current[i];
        if (!el) continue;
        // Per-bar phase offset so the cluster feels alive, not uniform.
        const phase = t * 2.2 + i * 0.9;

        let level: number; // 0..1
        if (state === "listening") {
          // Micro-movement floor + real user amplitude, bar-phase variation
          const wob = 0.12 + 0.1 * Math.sin(phase * 2.1);
          level = Math.min(1, wob + user * (0.55 + 0.45 * Math.abs(Math.sin(phase * 1.7))));
        } else if (state === "speaking") {
          // Model speech intensity from delta rate: each response.output_audio
          // .delta event bumps audioPulseRef; convert rate → 0..1 intensity.
          const pulses = audioPulseRef?.current ?? 0;
          const rate = Math.min(1, (pulses - lastPulseCount) / 6); // ~60ms of deltas
          lastPulseCount = pulses;
          const target = Math.max(0.35, rate);
          speakLevelRef.current += (target - speakLevelRef.current) * 0.25;
          const base = 0.3 + 0.55 * Math.abs(Math.sin(t * 9 + i * 1.3));
          level = Math.min(1, base * (0.45 + 0.55 * speakLevelRef.current));
        } else if (state === "thinking") {
          level = 0.18 + 0.12 * Math.sin(phase * 2.4);
        } else if (state === "connecting") {
          level = 0.15 + 0.25 * Math.abs(Math.sin(phase * 1.2));
        } else if (state === "error") {
          level = 0.12 + 0.06 * Math.sin(phase * 1.0);
        } else {
          // idle — breathe
          level = 0.14 + 0.1 * Math.sin(phase * 0.9);
        }
        const h = 3 + level * 13; // 3px..16px
        el.style.height = `${h.toFixed(1)}px`;
      }
      rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    };
  }, [state]);

  // Decay speakLevelRef continuously so bursts fade out.
  useEffect(() => {
    const id = window.setInterval(() => {
      speakLevelRef.current *= 0.82;
      if (speakLevelRef.current < 0.01) speakLevelRef.current = 0;
    }, 100);
    return () => clearInterval(id);
  }, []);

  const colorClass =
    state === "error"
      ? "text-pane-error/70"
      : state === "listening"
        ? "text-pane-error"
        : state === "speaking"
          ? "text-pane-accent"
          : state === "thinking"
            ? "text-pane-accent/70"
            : state === "connecting"
              ? "text-pane-accent/60"
              : state === "off"
                ? "text-pane-text-secondary/25"
                : "text-pane-accent/50";

  const title =
    state === "error"
      ? (error ?? "voice error — click to retry")
      : state === "off"
        ? "wake pane voice"
        : state === "speaking"
          ? "interrupt"
          : state === "connecting"
            ? "connecting…"
            : "voice live — click to end";

  return (
    <button
      onClick={() => {
        if (state === "speaking") onInterrupt();
        else onToggle();
      }}
      className="pointer-events-auto w-8 h-8 flex items-center justify-center rounded-md btn-press transition-colors"
      title={title}
      aria-label={title}
    >
      <span className={`flex items-end justify-center gap-[2.5px] h-4 ${colorClass}`}>
        {Array.from({ length: BAR_COUNT }, (_, i) => (
          <span
            key={i}
            ref={(el) => {
              barRefs.current[i] = el;
            }}
            className="w-[2.5px] rounded-full bg-current"
            style={{ height: state === "off" ? 3 : 5, transition: "height 90ms linear" }}
          />
        ))}
      </span>
    </button>
  );
}
