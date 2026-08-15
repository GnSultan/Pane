/**
 * VoiceGlow — bottom-edge glow for voice mode.
 *
 * Single radial gradient bleeding up from the bottom edge.
 * During recording, intensity follows real-time mic level.
 * pointer-events: none — doesn't intercept any clicks.
 */

import { useMemo } from "react";
import type { VoiceState } from "../hooks/useVoiceMode";
import { useVoiceStateStore } from "../hooks/useVoiceMode";

interface VoiceGlowProps {
  state: VoiceState;
}

export function VoiceGlow({ state }: VoiceGlowProps) {
  const audioLevel = useVoiceStateStore((s) => s.audioLevel);

  const voiceIntensity = state === "recording"
    ? 0.25 + audioLevel * 0.75
    : 1;

  const config = useMemo(() => {
    switch (state) {
      case "recording":
        return {
          color: `rgba(210, 140, 90, ${(0.45 * voiceIntensity).toFixed(3)})`,
          animation: undefined,
          opacity: 1,
        };
      case "transcribing":
        return {
          color: "rgba(138, 172, 202, 0.3)",
          animation: "voice-glow-shimmer 1.2s ease-in-out infinite",
          opacity: 1,
        };
      case "speaking":
        return {
          color: "rgba(138, 172, 202, 0.22)",
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
        transition: state === "recording" ? "none" : undefined,
      }}
    >
      {/* Bottom edge — single radial glow */}
      <div
        className="absolute bottom-0 left-0 right-0"
        style={{
          height: "45%",
          background: `radial-gradient(ellipse 90% 55% at 50% 100%, ${config.color}, transparent 70%)`,
        }}
      />
    </div>
  );
}
