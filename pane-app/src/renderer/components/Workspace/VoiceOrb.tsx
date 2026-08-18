/**
 * VoiceOrb — the living robot face.
 *
 * A little robot head with eyes and a mouth that:
 *   - sleeps (closed eyes) when off,
 *   - blinks and breathes when connected & idle,
 *   - LEANS IN — eyes widen with the USER's live mic amplitude while they
 *     speak (real analyser signal, not a loop),
 *   - chomps its mouth to the MODEL's audio (delta-rate driven) while it
 *     speaks, with happy ∪∪ eyes,
 *   - looks up-and-away with a wavy mouth while thinking,
 *   - scans its eyes left-right while connecting,
 *   - plays dead (X_X) with a frown on error — click to revive.
 *
 * All motion is imperative (rAF + refs) — no re-renders per frame.
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
   *  converts its rate-of-change into chomp intensity. No re-renders. */
  audioPulseRef?: { current: number };
  /** Toggle session on/off (called when off/error → start, live → stop). */
  onToggle: () => void;
  /** Interrupt model speech (click while speaking). */
  onInterrupt: () => void;
}

export function VoiceOrb({ state, error, micStream, audioPulseRef, onToggle, onInterrupt }: VoiceOrbProps) {
  // Imperatively-animated elements.
  const eyeGroupRef = useRef<SVGGElement | null>(null);
  const eyeLRef = useRef<SVGCircleElement | null>(null);
  const eyeRRef = useRef<SVGCircleElement | null>(null);
  const mouthRef = useRef<SVGRectElement | null>(null);
  const antennaRef = useRef<SVGCircleElement | null>(null);
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
    // Blink scheduling (open-eye states only).
    let nextBlinkAt = startTime + 1800 + Math.random() * 2600;
    let blinkUntil = 0;

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

      // ── Eyes (open-eye states: idle, listening, connecting, thinking) ──
      const openEyes = state === "idle" || state === "listening" || state === "connecting" || state === "thinking";
      if (openEyes) {
        // Blink: schedule → close 140ms → reopen.
        if (now >= nextBlinkAt) {
          blinkUntil = now + 140;
          nextBlinkAt = now + 2200 + Math.random() * 3000;
        }
        const blinking = now < blinkUntil;
        if (eyeGroupRef.current) {
          eyeGroupRef.current.setAttribute("transform", `translate(12 12.5) scale(1 ${blinking ? 0.08 : 1}) translate(-12 -12.5)`);
        }
        // Pupil behaviour per state.
        let dx = 0;
        let dy = 0;
        let eyeR = 1.6;
        if (state === "listening") {
          // Lean in: eyes grow with the user's actual voice level.
          eyeR = 1.6 + user * 1.1 + 0.15 * Math.sin(t * 6);
          dy = -0.2;
        } else if (state === "thinking") {
          // Classic look-up-and-away, alternating sides every ~1.6s.
          const side = Math.floor(t / 1.6) % 2 === 0 ? 1 : -1;
          dx = side * (0.7 + 0.2 * Math.sin(t * 2));
          dy = -0.9;
          eyeR = 1.4;
        } else if (state === "connecting") {
          // Scanning left↔right while the session comes up.
          dx = Math.sin(t * 3.2) * 1.1;
        } else {
          // idle — gentle wander, mostly centred.
          dx = 0.25 * Math.sin(t * 0.7);
        }
        for (const eye of [eyeLRef.current, eyeRRef.current]) {
          if (!eye) continue;
          eye.setAttribute("r", eyeR.toFixed(2));
          eye.style.transform = `translate(${dx}px, ${dy}px)`;
        }
      }

      // ── Mouth (speaking: real chomp driven by model audio deltas) ──────
      if (state === "speaking" && mouthRef.current) {
        const pulses = audioPulseRef?.current ?? 0;
        const rate = Math.min(1, (pulses - lastPulseCount) / 6); // ~60ms of deltas
        lastPulseCount = pulses;
        const target = Math.max(0.25, rate);
        speakLevelRef.current += (target - speakLevelRef.current) * 0.3;
        const h = 1.2 + speakLevelRef.current * 4.2; // 1.2px..5.4px chomp
        mouthRef.current.setAttribute("height", h.toFixed(2));
        mouthRef.current.setAttribute("y", (17.4 - h / 2).toFixed(2));
      }

      // ── Antenna ball — heartbeat speed says what the robot is doing ────
      if (antennaRef.current) {
        const speed =
          state === "error" ? 9 :
          state === "connecting" ? 6 :
          state === "thinking" ? 4 :
          state === "speaking" ? 3 :
          state === "listening" ? 2.5 : 1.4;
        const pulse = 0.5 + 0.5 * Math.sin(t * speed);
        antennaRef.current.setAttribute("r", (1 + pulse * 0.55).toFixed(2));
        antennaRef.current.style.opacity = String(0.45 + pulse * 0.55);
      }

      rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    };
  }, [state]);

  // Decay speakLevelRef continuously so chomps fade out.
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

  // ── Eye shapes per state ────────────────────────────────────────────────
  // Open-eye states share animated circle eyes; the rest get drawn faces.
  const eyes = (() => {
    if (state === "idle" || state === "listening" || state === "connecting" || state === "thinking") {
      return (
        <g ref={eyeGroupRef}>
          <circle ref={eyeLRef} cx={9} cy={12.5} r={1.6} fill="currentColor" />
          <circle ref={eyeRRef} cx={15} cy={12.5} r={1.6} fill="currentColor" />
        </g>
      );
    }
    if (state === "speaking") {
      // Happy closed ∪∪ eyes while chomping.
      return (
        <g stroke="currentColor" strokeWidth={1.2} strokeLinecap="round" fill="none">
          <path d="M7.6 12.9 q1.4 -1.7 2.8 0" />
          <path d="M13.6 12.9 q1.4 -1.7 2.8 0" />
        </g>
      );
    }
    if (state === "error") {
      // X_X — the robot has seen the upstream error and perished.
      return (
        <g stroke="currentColor" strokeWidth={1.1} strokeLinecap="round">
          <path d="M7.8 11.3 l2.4 2.4 M10.2 11.3 l-2.4 2.4" />
          <path d="M13.8 11.3 l2.4 2.4 M16.2 11.3 l-2.4 2.4" />
        </g>
      );
    }
    // off — fast asleep.
    return (
      <g stroke="currentColor" strokeWidth={1.1} strokeLinecap="round" fill="none">
        <path d="M7.7 12.8 q1.3 1.1 2.6 0" />
        <path d="M13.7 12.8 q1.3 1.1 2.6 0" />
      </g>
    );
  })();

  // ── Mouth per state ─────────────────────────────────────────────────────
  const mouth = (() => {
    if (state === "speaking") {
      // Animated capsule — height driven by model audio in the rAF loop.
      return (
        <rect
          ref={mouthRef}
          x={9.6}
          y={16.7}
          width={4.8}
          height={1.4}
          rx={0.9}
          fill="currentColor"
        />
      );
    }
    if (state === "listening") {
      // Attentive little smile.
      return <path d="M9.7 16.9 q2.3 1.9 4.6 0" stroke="currentColor" strokeWidth={1.2} strokeLinecap="round" fill="none" />;
    }
    if (state === "thinking") {
      // Wavy uncertain mouth.
      return (
        <path
          d="M9.7 17.3 q1.15 -1.1 2.3 0 q1.15 1.1 2.3 0"
          stroke="currentColor"
          strokeWidth={1.1}
          strokeLinecap="round"
          fill="none"
        />
      );
    }
    if (state === "error") {
      // Frown.
      return <path d="M9.7 17.9 q2.3 -2 4.6 0" stroke="currentColor" strokeWidth={1.2} strokeLinecap="round" fill="none" />;
    }
    if (state === "connecting") {
      // Small "o" — anticipation.
      return <circle cx={12} cy={17.3} r={1.15} stroke="currentColor" strokeWidth={1.1} fill="none" />;
    }
    if (state === "idle") {
      // Content smile, breathes with the antenna.
      return <path d="M9.7 16.9 q2.3 1.7 4.6 0" stroke="currentColor" strokeWidth={1.2} strokeLinecap="round" fill="none" />;
    }
    // off — flat asleep mouth.
    return <path d="M9.9 17.4 h4.2" stroke="currentColor" strokeWidth={1.1} strokeLinecap="round" />;
  })();

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
      <svg viewBox="0 0 24 24" width={22} height={22} className={colorClass} aria-hidden="true">
        {/* antenna */}
        <line x1={12} y1={2.6} x2={12} y2={6} stroke="currentColor" strokeWidth={1.1} strokeLinecap="round" />
        <circle ref={antennaRef} cx={12} cy={2.4} r={1.3} fill="currentColor" opacity={state === "off" ? 0.35 : 0.8} />
        {/* head */}
        <rect x={3.6} y={6} width={16.8} height={13} rx={3.4} stroke="currentColor" strokeWidth={1.3} fill="none" />
        {/* side bolts */}
        <rect x={1.4} y={10.2} width={2} height={4} rx={1} fill="currentColor" opacity={0.75} />
        <rect x={20.6} y={10.2} width={2} height={4} rx={1} fill="currentColor" opacity={0.75} />
        {/* face */}
        {eyes}
        {mouth}
      </svg>
    </button>
  );
}
