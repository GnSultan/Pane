/**
 * VoiceGlow — full-window edge glow overlay for voice mode.
 *
 * Renders gradient-based light bleeding in from the window edges.
 * No box-shadow (Pane design rule). Pure CSS gradients + opacity animation.
 * pointer-events: none — doesn't intercept any clicks.
 *
 * States:
 *   recording    — warm amber/rose breathing from bottom edge, fading up sides
 *   transcribing — brief accent shimmer
 *   speaking     — cool accent pulse, subtler than recording
 *   idle/off     — nothing rendered
 */

import type { VoiceState } from "../hooks/useVoiceMode";

interface VoiceGlowProps {
  state: VoiceState;
}

export function VoiceGlow({ state }: VoiceGlowProps) {
  if (state === "idle") return null;

  // Pick color palette per state
  const config = {
    recording: {
      // Warm amber-rose — "the app is listening"
      bottom: "rgba(210, 140, 90, 0.35)",
      sides: "rgba(210, 140, 90, 0.12)",
      top: "rgba(210, 140, 90, 0.04)",
      animation: "voice-glow-breathe 2s ease-in-out infinite",
    },
    transcribing: {
      // Accent color — brief processing flash
      bottom: "rgba(138, 172, 202, 0.25)",
      sides: "rgba(138, 172, 202, 0.08)",
      top: "rgba(138, 172, 202, 0.02)",
      animation: "voice-glow-shimmer 1.2s ease-in-out infinite",
    },
    speaking: {
      // Softer accent — "I'm talking back"
      bottom: "rgba(138, 172, 202, 0.18)",
      sides: "rgba(138, 172, 202, 0.06)",
      top: "rgba(138, 172, 202, 0.01)",
      animation: "voice-glow-speak 2.4s ease-in-out infinite",
    },
  }[state];

  return (
    <div
      className="fixed inset-0 z-50 pointer-events-none"
      style={{ animation: config.animation }}
    >
      {/* Bottom edge — strongest glow, where the mic lives */}
      <div
        className="absolute bottom-0 left-0 right-0"
        style={{
          height: "40%",
          background: `radial-gradient(ellipse 80% 50% at 50% 100%, ${config.bottom}, transparent 70%)`,
        }}
      />

      {/* Left edge */}
      <div
        className="absolute top-0 bottom-0 left-0"
        style={{
          width: "15%",
          background: `linear-gradient(to right, ${config.sides}, transparent)`,
        }}
      />

      {/* Right edge */}
      <div
        className="absolute top-0 bottom-0 right-0"
        style={{
          width: "15%",
          background: `linear-gradient(to left, ${config.sides}, transparent)`,
        }}
      />

      {/* Top edge — very faint */}
      <div
        className="absolute top-0 left-0 right-0"
        style={{
          height: "8%",
          background: `linear-gradient(to bottom, ${config.top}, transparent)`,
        }}
      />

      {/* Bottom corners — extra warmth where edges meet */}
      <div
        className="absolute bottom-0 left-0"
        style={{
          width: "25%",
          height: "25%",
          background: `radial-gradient(ellipse at 0% 100%, ${config.sides}, transparent 70%)`,
        }}
      />
      <div
        className="absolute bottom-0 right-0"
        style={{
          width: "25%",
          height: "25%",
          background: `radial-gradient(ellipse at 100% 100%, ${config.sides}, transparent 70%)`,
        }}
      />
    </div>
  );
}
