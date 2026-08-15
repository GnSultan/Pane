/**
 * VoiceGlow — full-window edge glow overlay for voice mode.
 *
 * Renders gradient-based light bleeding in from the window edges.
 * No box-shadow (Pane design rule). Pure CSS gradients + opacity animation.
 * pointer-events: none — doesn't intercept any clicks.
 *
 * During recording, the glow intensity is driven by real-time mic audio level
 * so the user can see their voice is being captured. On silence → dims down.
 *
 * States:
 *   recording    — warm amber/rose, intensity follows mic level
 *   transcribing — brief accent shimmer
 *   speaking     — cool accent pulse, subtler than recording
 *   idle/off     — nothing rendered
 */

import { useMemo } from "react";
import type { VoiceState } from "../hooks/useVoiceMode";
import { useVoiceStateStore } from "../hooks/useVoiceMode";

interface VoiceGlowProps {
  state: VoiceState;
}

export function VoiceGlow({ state }: VoiceGlowProps) {
  const audioLevel = useVoiceStateStore((s) => s.audioLevel);

  // For recording state: base opacity + voice-reactive boost
  // audioLevel is 0–1, we map it to opacity multiplier
  const voiceIntensity = state === "recording"
    ? 0.25 + audioLevel * 0.75   // 25% base so it's always visible, up to 100%
    : 1;

  const config = useMemo(() => {
    switch (state) {
      case "recording": {
        return {
          bottom: `rgba(210, 140, 90, ${(0.4 * voiceIntensity).toFixed(3)})`,
          sides: `rgba(210, 140, 90, ${(0.15 * voiceIntensity).toFixed(3)})`,
          top: `rgba(210, 140, 90, ${(0.05 * voiceIntensity).toFixed(3)})`,
          // No CSS animation — the level itself IS the animation
          animation: undefined,
          opacity: 1,
        };
      }
      case "transcribing":
        return {
          bottom: "rgba(138, 172, 202, 0.25)",
          sides: "rgba(138, 172, 202, 0.08)",
          top: "rgba(138, 172, 202, 0.02)",
          animation: "voice-glow-shimmer 1.2s ease-in-out infinite",
          opacity: 1,
        };
      case "speaking":
        return {
          bottom: "rgba(138, 172, 202, 0.18)",
          sides: "rgba(138, 172, 202, 0.06)",
          top: "rgba(138, 172, 202, 0.01)",
          animation: "voice-glow-speak 2.4s ease-in-out infinite",
          opacity: 1,
        };
      default:
        return null;
    }
  }, [state, voiceIntensity]);

  if (!config) return null;

  return (
    <div
      className="fixed inset-0 z-50 pointer-events-none"
      style={{
        animation: config.animation,
        opacity: config.opacity,
        // Smooth transitions when level changes — but not so much it feels laggy
        transition: state === "recording" ? "none" : undefined,
      }}
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
