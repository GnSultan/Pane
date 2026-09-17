/**
 * VoiceOrb — the voice presence: a face.
 *
 * A living face — one circle, two almond eyes with pupils, one mouth.
 * Every stroke shares the same weight and color; nothing is muted or
 * secondary, so it reads as a single drawn face:
 *   - off: the resting face exactly as drawn in the static markup
 *   - idle: slow blinks — each eye lens squashes to a line, reopens
 *   - listening: eyes on you (centered), brighten (terminal blue) and
 *     widen slightly with the USER's live mic amplitude
 *   - speaking: pupils sweep left↔right on real saccade timing as the
 *     MODEL talks; the mouth lens opens vertically with the model's
 *     real audio amplitude; the head follows the gaze with a lag and
 *     bobs gently with speech energy
 *   - thinking: gaze drifts up-and-away, eyes half-lidded
 *   - connecting: the eyes breathe while the session comes up
 *   - error: red — click to retry
 *
 * Click = wake/end; click while speaking = interrupt; right-click = mic
 * input picker (born from the Bluetooth phantom-input incident).
 *
 * All motion is imperative (rAF + refs) — no re-renders per frame. The
 * face also owns the room: it publishes smoothed user/model levels +
 * state to the shared voiceLight signal every frame for VoiceFloorGlow.
 */

import { useEffect, useRef, useState } from "react";
import { voiceLight } from "../../lib/voice-light";

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
  /** Real analyser on the MODEL's audio track — true amplitude for the
   *  mouth animation. Null until the remote track arrives. */
  modelAnalyserRef?: { current: AnalyserNode | null };
  /** Mutable counter bumped once per model audio delta — fallback mouth
   *  motion when no analyser exists yet. */
  audioPulseRef?: { current: number };
  /** Toggle session on/off (called when off/error → start, live → stop). */
  onToggle: () => void;
  /** Interrupt model speech (click while speaking). */
  onInterrupt: () => void;
  /** Audio inputs for the right-click picker. */
  micDevices?: Array<{ deviceId: string; label: string }>;
  /** deviceId of the input currently feeding the session (null = default). */
  activeMicId?: string | null;
  /** Pin an input device (restarts the session if live). */
  onSelectMic?: (deviceId: string) => void;
  /** Re-enumerate inputs (called when the picker opens). */
  onRefreshMics?: () => void;
}

export function VoiceOrb({
  state,
  error,
  micStream,
  modelAnalyserRef,
  audioPulseRef,
  onToggle,
  onInterrupt,
  micDevices,
  activeMicId,
  onSelectMic,
  onRefreshMics,
}: VoiceOrbProps) {
  // Right-click picker: which input device feeds the model.
  const [pickerOpen, setPickerOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  // Imperatively-animated elements.
  const leftEyeRef = useRef<SVGPathElement | null>(null);
  const rightEyeRef = useRef<SVGPathElement | null>(null);
  const mouthPathRef = useRef<SVGPathElement | null>(null);
  const pupilLRef = useRef<SVGPathElement | null>(null);
  const pupilRRef = useRef<SVGPathElement | null>(null);
  const faceGroupRef = useRef<SVGGElement | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const rafRef = useRef<number | null>(null);

// ── Face geometry (24×24 viewBox; every stroke shares weight + color) ──
const EYE_CY = 9.6;        // eye row
const PUPIL_R = 0.62;      // pupil radius inside each lens
/** Pupil hidden — mid-blink. */
const PUPIL_CLOSED = "M-10 -10";
/** Centered pupil dot at eye column cx (resting / off pose). */
const PUPIL_DOT = (cx: number): string =>
  `M${cx} ${EYE_CY} m${-PUPIL_R} 0 a${PUPIL_R} ${PUPIL_R} 0 1 0 ${2 * PUPIL_R} 0 a${PUPIL_R} ${PUPIL_R} 0 1 0 ${-2 * PUPIL_R} 0`;
/** Mouth at rest — a closed-lips dash at mouth height: ~60% of the way
 *  from the eye row (9.6) to the chin (20.9). The old row (15.6) sat at
 *  the exact midpoint — nose territory — so the dash read as a nose. */
const MOUTH_ROW = 16.7;
const MOUTH_CLOSED = `M${12 - 1.4} ${MOUTH_ROW} L${12 + 1.4} ${MOUTH_ROW}`;

/**
 * Draw an almond eye: two symmetric arcs meeting at points. open ∈ [0,1]
 * (1 = round lens, 0 = closed line). The pupil sits at (cx + gaze offsets).
 * Stroke-only, same weight as the head circle — one drawn face.
 */
function setEyeShape(
  el: SVGPathElement,
  cx: number,
  open: number,
  gx: number,
  gy: number,
): void {
  const w = 2.0;                       // half-width of the lens
  const h = 1.35 * Math.max(0, open);  // half-height, squashes on blink
  const x0 = cx + gx - w, x1 = cx + gx + w;
  const cy = EYE_CY + gy;
  el.setAttribute(
    "d",
    `M${x0.toFixed(2)} ${cy.toFixed(2)} Q${(cx + gx).toFixed(2)} ${(cy - 2 * h).toFixed(2)} ${x1.toFixed(2)} ${cy.toFixed(2)} Q${(cx + gx).toFixed(2)} ${(cy + 2 * h).toFixed(2)} ${x0.toFixed(2)} ${cy.toFixed(2)} Z`,
  );
}

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
    // Session over: reset every animated feature to its static off pose,
    // darken the room, and never start the loop.
    if (state === "off") {
      const eyeL = leftEyeRef.current;
      const eyeR = rightEyeRef.current;
      if (eyeL && eyeR) {
        setEyeShape(eyeL, 8.9, 1, 0, 0);
        setEyeShape(eyeR, 15.1, 1, 0, 0);
      }
      const pupilL = pupilLRef.current;
      const pupilR = pupilRRef.current;
      if (pupilL) pupilL.setAttribute("d", PUPIL_DOT(8.9));
      if (pupilR) pupilR.setAttribute("d", PUPIL_DOT(15.1));
      if (faceGroupRef.current) faceGroupRef.current.setAttribute("transform", "none");
      if (mouthPathRef.current) mouthPathRef.current.setAttribute("d", MOUTH_CLOSED);
      voiceLight.state = "off";
      voiceLight.user = 0;
      voiceLight.model = 0;
      return;
    }

    const buf = new Uint8Array(128);
    const startTime = performance.now();
    // Model audio: delta-rate fallback (before the analyser arrives) and
    // smoothed level for the mouth + room.
    let glowPulses = audioPulseRef?.current ?? 0;
    let modelSmooth = 0;
    // Delta-rate estimator: events/second, smoothed ~150ms so the level
    // is frame-rate independent (deltas arrive every ~20-60ms in speech).
    let pulseRate = 0;
    // Blink scheduling: next blink + where we are inside it.
    let nextBlink = 1.6 + Math.random() * 2.2;
    // Gaze: target pupil offset; pupils snap, the head eases after them.
    let gazeX = 0, gazeY = 0;          // current pupil offset (svg units)
    let gazeHold = 0.8 + Math.random();// seconds until next saccade
    // Head follow: eased toward a fraction of the gaze + a gentle sway.
    let headX = 0, headY = 0, headRot = 0;
    // Frame timing for saccade holds (frame-rate independent).
    let prevNow = performance.now();

    /** RMS amplitude of an analyser, scaled to 0..1 speech range. */
    const levelOf = (analyser: AnalyserNode | null): number => {
      if (!analyser) return 0;
      analyser.getByteTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) {
        const sample = buf[i] ?? 128;
        const v = (sample - 128) / 128;
        sum += v * v;
      }
      return Math.min(1, Math.sqrt(sum / buf.length) * 4);
    };

    const tick = (now: number): void => {
      const t = (now - startTime) / 1000;
      const dt = Math.min(0.05, (now - prevNow) / 1000);
      prevNow = now;

      // ── Real levels: user from mic analyser, model from track analyser ──
      const user = levelOf(analyserRef.current);
      const analyserLevel = levelOf(modelAnalyserRef?.current ?? null);
      // Delta-rate estimator: realtime audio deltas arrive every ~20-60ms
      // during speech (15-50 events/s), NOT 3 per frame — the old
      // perFrame/3 math computed ≈0 forever (same bug the room glow had).
      // Smoothing over ~150ms makes this frame-rate independent.
      const pulses = audioPulseRef?.current ?? glowPulses;
      const newPulses = pulses - glowPulses;
      glowPulses = pulses;
      const instRate = dt > 0 ? newPulses / dt : 0; // events/s this frame
      pulseRate += (instRate - pulseRate) * Math.min(1, dt / 0.15);
      const pulseLevel = Math.min(1, pulseRate / 30); // ~30 ev/s = solid speech
      // Analyser is the real signal; pulses carry the motion when the
      // analyser is absent or its AudioContext sits suspended (reads 0).
      // max() means a dead analyser can never suppress the delta signal.
      const model = Math.max(analyserLevel, pulseLevel);
      // Smooth: fast attack, ~350ms release — speech swells, pauses settle.
      const mTarget = state === "speaking" ? model : 0;
      modelSmooth = mTarget > modelSmooth
        ? modelSmooth + (mTarget - modelSmooth) * 0.5
        : modelSmooth * 0.9;

      // ── Publish shared signals for the floor glow ─────────────────────
      voiceLight.state = state;
      voiceLight.user = user;
      voiceLight.model = modelSmooth;

      // ── Blink — 0 outside a blink, sin curve inside (~130ms) ───────────
      let blink = 0;
      const bt = t - nextBlink;
      if (bt >= 0) {
        if (bt < 0.13) blink = Math.sin((bt / 0.13) * Math.PI);
        else nextBlink = t + 2.2 + Math.random() * 3.4;
      }

      // ── Eye openness (0 = closed line, 1 = fully open) ─────────────────
      let eyeOpen = 1;
      if (state === "connecting") {
        eyeOpen = 0.45 + 0.35 * (0.5 + 0.5 * Math.sin(t * 2.2));
      } else if (state === "listening") {
        eyeOpen = 0.9 + Math.min(0.25, user * 0.5); // widens with the voice
      } else if (state === "speaking") {
        eyeOpen = 0.7; // slightly narrowed — mid-sentence
      } else if (state === "thinking") {
        eyeOpen = 0.55; // half-lidded, gaze elsewhere
      } else if (state === "error") {
        eyeOpen = 0.65;
      }
      // The blink closes whatever state we're in.
      eyeOpen = Math.max(0, eyeOpen * (1 - blink));

      // ── Gaze — where the pupils look ────────────────────────────────────
      // Speaking: the eyes sweep left↔right with real saccade timing —
      // hold a direction, snap to the next. Thinking: gaze drifts
      // up-and-away. Listening/idle: eyes on you, centered.
      gazeHold -= dt;
      if (state === "speaking") {
        if (gazeHold <= 0) {
          // Snap to a new direction: alternate sides, slight vertical roam.
          gazeX = (Math.random() < 0.5 ? -1 : 1) * (0.35 + Math.random() * 0.55);
          gazeY = (Math.random() - 0.5) * 0.3;
          gazeHold = 0.5 + Math.random() * 0.7;        // hold 0.5–1.2s
        }
      } else if (state === "thinking") {
        gazeX += (0.9 - gazeX) * 0.02;   // slow drift up-and-away
        gazeY += (-0.8 - gazeY) * 0.02;
        gazeHold = 1.0;
      } else {
        gazeX += (0 - gazeX) * 0.15;     // settle back to center
        gazeY += (0 - gazeY) * 0.15;
      }

      // ── Head — follows the gaze with a lag, plus gentle speech sway ────
      // Eyes lead, head follows: the head chases a fraction of where the
      // pupils are, with a slow bob while the model talks.
      let sway = 0, bob = 0;
      if (state === "speaking") {
        sway = Math.sin(t * 1.1) * 0.35 + Math.sin(t * 0.47) * 0.2;
        bob = Math.sin(t * 2.3) * (0.1 + modelSmooth * 0.25);
      } else if (state === "listening") {
        sway = Math.sin(t * 0.6) * 0.15;   // a slight lean toward you
        bob = Math.sin(t * 1.6) * 0.06;
      } else if (state === "thinking") {
        sway = Math.sin(t * 0.35) * 0.2;
        bob = Math.sin(t * 0.5) * 0.08;
      }
      const headTX = gazeX * 0.45 + sway;   // head goes part of the way
      const headTY = gazeY * 0.3 + bob;
      headX += (headTX - headX) * 0.06;
      headY += (headTY - headY) * 0.06;
      headRot = headX * 3.2;                 // subtle tilt, degrees

      // ── The eyes ── almond lenses; blink squashes them to a line ──────
      const eyeL = leftEyeRef.current;
      const eyeR = rightEyeRef.current;
      if (eyeL && eyeR) {
        const scale = state === "listening" ? 1 + user * 0.18 : 1;
        setEyeShape(eyeL, 8.9, eyeOpen * scale, gazeX * 0.18, gazeY * 0.18);
        setEyeShape(eyeR, 15.1, eyeOpen * scale, gazeX * 0.18, gazeY * 0.18);
        // Pupils ride inside the lenses, offset by the gaze.
        const pupilL2 = pupilLRef.current;
        const pupilR2 = pupilRRef.current;
        if (pupilL2 && pupilR2) {
          if (eyeOpen > 0.25) {
            const r = PUPIL_R * Math.min(1, eyeOpen * 1.4);
            // Clamp so the dot stays inside the lens outline —
            // vertically bounded by how open the lid currently is.
            const lensH = 1.35 * Math.max(0, eyeOpen) * (state === "listening" ? 1 + user * 0.18 : 1);
            const maxPy = Math.min(0.55, Math.max(0, lensH - r - 0.12));
            const px = Math.max(-1.0, Math.min(1.0, gazeX));
            const py = Math.max(-maxPy, Math.min(maxPy, gazeY));
            pupilL2.setAttribute("d", `M${(8.9 + px).toFixed(2)} ${(EYE_CY + py).toFixed(2)} m${(-r).toFixed(2)} 0 a${r.toFixed(2)} ${r.toFixed(2)} 0 1 0 ${(2 * r).toFixed(2)} 0 a${r.toFixed(2)} ${r.toFixed(2)} 0 1 0 ${(-2 * r).toFixed(2)} 0`);
            pupilR2.setAttribute("d", `M${(15.1 + px).toFixed(2)} ${(EYE_CY + py).toFixed(2)} m${(-r).toFixed(2)} 0 a${r.toFixed(2)} ${r.toFixed(2)} 0 1 0 ${(2 * r).toFixed(2)} 0 a${r.toFixed(2)} ${r.toFixed(2)} 0 1 0 ${(-2 * r).toFixed(2)} 0`);
          } else {
            pupilL2.setAttribute("d", PUPIL_CLOSED);
            pupilR2.setAttribute("d", PUPIL_CLOSED);
          }
        }
      }

      // ── The mouth ── a lens that opens vertically with the voice ───────
      // Quiet = closed-lips dash; speaking = the jaw drops on real amplitude.
      const mouth = mouthPathRef.current;
      if (mouth) {
        let open = 0;
        if (state === "speaking") open = 0.15 + modelSmooth * 0.85;
        else if (state === "listening") open = 0.08 + user * 0.1;
        else if (state === "thinking") open = 0.1;
        const h = open * 1.5;                     // half-height of the lens
        const w = 1.4 + open * 1.0;               // closed-lips dash at rest, widens as it opens
        mouth.setAttribute(
          "d",
          `M${(12 - w).toFixed(2)} ${MOUTH_ROW}  Q12 ${(MOUTH_ROW - 2 * h).toFixed(2)} ${(12 + w).toFixed(2)} ${MOUTH_ROW}  Q12 ${(MOUTH_ROW + 2 * h).toFixed(2)} ${(12 - w).toFixed(2)} ${MOUTH_ROW} Z`,
        );
      }

      // ── The face group ── head carries the features with it ────────────
      if (faceGroupRef.current) {
        faceGroupRef.current.setAttribute(
          "transform",
          `translate(${headX.toFixed(2)} ${headY.toFixed(2)}) rotate(${headRot.toFixed(2)} 12 12)`,
        );
      }

      rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    };
  }, [state]);
  // Open-picker housekeeping: refresh the device list when it opens, close
  // on any outside click / Escape.
  useEffect(() => {
    if (!pickerOpen) return;
    onRefreshMics?.();
    const onDown = (e: MouseEvent): void => {
      if (!(e.target instanceof Node) || !rootRef.current?.contains(e.target)) {
        setPickerOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setPickerOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [pickerOpen, onRefreshMics]);

  const colorClass =
    state === "error"
      ? "text-pane-error/80"
      : state === "listening"
        ? "text-pane-terminal"
        : state === "speaking"
          ? "text-pane-accent"
          : state === "thinking"
            ? "text-pane-accent/70"
            : state === "connecting"
              ? "text-pane-accent/60"
              : state === "off"
                ? "text-pane-text-secondary/40"
                : "text-pane-accent/70";

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
    <div ref={rootRef} className="relative">
      <button
        onClick={() => {
          if (state === "speaking") onInterrupt();
          else onToggle();
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          setPickerOpen((o) => !o);
        }}
        className="pointer-events-auto w-8 h-8 flex items-center justify-center rounded-md btn-press transition-colors"
        title={title}
        aria-label={title}
      >
        <svg viewBox="0 0 24 24" width={24} height={24} className={colorClass} aria-hidden="true">
          {/* One drawn face — every stroke shares weight and color.
              These static attributes ARE the off state; the loop only
              runs while a session is live. The whole face travels
              together inside one group — the head carries its
              features with it as it turns. */}
          <g ref={faceGroupRef}>
            <circle cx={12} cy={12} r={8.9} fill="none" stroke="currentColor" strokeWidth={1.3} />
            <path ref={leftEyeRef} d="M6.9 9.6 Q8.9 6.9 10.9 9.6 Q8.9 12.3 6.9 9.6 Z" fill="none" stroke="currentColor" strokeWidth={1.3} strokeLinecap="round" />
            <path ref={rightEyeRef} d="M13.1 9.6 Q15.1 6.9 17.1 9.6 Q15.1 12.3 13.1 9.6 Z" fill="none" stroke="currentColor" strokeWidth={1.3} strokeLinecap="round" />
            <path ref={pupilLRef} d="M8.9 9.6 m-0.62 0 a0.62 0.62 0 1 0 1.24 0 a0.62 0.62 0 1 0 -1.24 0" fill="none" stroke="currentColor" strokeWidth={1.3} />
            <path ref={pupilRRef} d="M15.1 9.6 m-0.62 0 a0.62 0.62 0 1 0 1.24 0 a0.62 0.62 0 1 0 -1.24 0" fill="none" stroke="currentColor" strokeWidth={1.3} />
            <path ref={mouthPathRef} d="M10.6 16.7 L13.4 16.7" fill="none" stroke="currentColor" strokeWidth={1.3} strokeLinecap="round" />
          </g>
        </svg>
      </button>

      {/* Device picker — born from the Bluetooth-speaker incident. */}
      {pickerOpen && (
        <div
          className="absolute bottom-full left-0 mb-1.5 w-64 rounded-lg bg-pane-bg ring-1 ring-pane-border/40 shadow-lg py-1 z-50"
          role="menu"
          aria-label="microphone input"
        >
          <div
            className="px-3 py-1.5 font-mono text-pane-text-secondary/50"
            style={{ fontSize: "var(--pane-font-size-xs)" }}
          >
            voice input
          </div>
          {(micDevices ?? []).length === 0 ? (
            <div
              className="px-3 py-1.5 font-mono text-pane-text-secondary/50"
              style={{ fontSize: "var(--pane-font-size-xs)" }}
            >
              grant mic access once to name inputs
            </div>
          ) : (
            (micDevices ?? []).map((d) => {
              const active = d.deviceId === activeMicId;
              return (
                <button
                  key={d.deviceId}
                  onClick={() => {
                    onSelectMic?.(d.deviceId);
                    setPickerOpen(false);
                  }}
                  className={`w-full text-left px-3 py-1.5 font-mono truncate transition-colors hover:bg-pane-text/[0.04] ${
                    active ? "text-pane-accent" : "text-pane-text-secondary"
                  }`}
                  style={{ fontSize: "var(--pane-font-size-xs)" }}
                  title={d.label}
                >
                  {active ? "● " : "○ "}
                  {d.label}
                </button>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}
