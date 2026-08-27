/**
 * VoiceFloorGlow — ambient light rising from the bottom of the conversation.
 *
 * The room tells you what's happening even when you're not looking at the orb:
 *   - LISTENING (terminal blue): a pool of light that swells with the user's
 *     actual voice amplitude — it breathes with you.
 *   - SPEAKING (accent sage): light pulses with the model's speech cadence,
 *     bright enough to read across the room, settling into pauses.
 *   - THINKING (dim accent): slow, patient breath.
 *   - CONNECTING: gentle rise-and-fall until the session is up.
 *   - IDLE (barely-there): resting glow — proof the session is alive.
 *   - OFF: nothing. When voice is off, the surface is honest about it.
 *
 * Colors are Pane's own tokens: --pane-terminal (you) / --pane-accent (pane).
 *
 * Mount inside the conversation container (absolute, inset-x-0 bottom-0) so
 * the light belongs to the room, not the whole window.
 *
 * Perf: fixed height + opacity-only animation. All imperative rAF — zero
 * re-renders. Reads the shared voiceLight signal written every frame by
 * VoiceOrb's animation loop.
 */

import { useEffect, useRef } from "react";
import { voiceLight } from "../../lib/voice-light";

const COL_ACCENT = "var(--pane-accent)";
const COL_TERMINAL = "var(--pane-terminal)"; // you — the terminal's voice

export function VoiceFloorGlow() {
  const glowRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = glowRef.current;
    if (!el) return;
    const style = el.style;

    let raf = 0;
    let smoothBase = 0;
    let lastCol = "";

    const tick = (now: number): void => {
      const t = now / 1000;
      const s = voiceLight.state;

      // ── color + target intensity from state ─────────────────────────
      let col = COL_ACCENT;
      let target = 0;
      switch (s) {
        case "listening":
          col = COL_TERMINAL;
          target = 0.3 + Math.min(0.35, voiceLight.user * 1.1);
          break;
        case "speaking":
          // Floor high enough to always read as "speaking"; the model's
          // cadence rides on top — pauses dim toward the floor, speech
          // brightens past it.
          target = 0.42 + Math.min(0.4, voiceLight.model * 0.85);
          break;
        case "thinking":
          // slow, patient breath
          target = 0.14 + 0.07 * (0.5 + 0.5 * Math.sin(t * 0.9));
          break;
        case "connecting":
          target = 0.12 + 0.09 * (0.5 + 0.5 * Math.sin(t * 1.8));
          break;
        case "idle":
        case "error":
          target = 0.08; // resting — always there, never demanding
          break;
        default:
          target = 0; // off: fade out fully
      }

      // ── smooth toward target (~100ms time constant) ─────────────────
      smoothBase += (target - smoothBase) * 0.16;

      if (smoothBase < 0.004) {
        if (style.opacity !== "0") style.opacity = "0";
      } else {
        if (col !== lastCol) {
          style.setProperty("--vg-col", col);
          lastCol = col;
        }
        style.opacity = String(smoothBase);
      }
      raf = requestAnimationFrame(tick);
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <div
      ref={glowRef}
      aria-hidden="true"
      className="pointer-events-none absolute inset-x-0 bottom-0 z-[5] opacity-0"
      style={{
        height: "200px",
        background:
          "radial-gradient(ellipse 130% 100% at 50% 78%, var(--vg-col, var(--pane-accent)) 0%, transparent 72%)",
        filter: "blur(26px)",
        willChange: "opacity",
      }}
    />
  );
}
