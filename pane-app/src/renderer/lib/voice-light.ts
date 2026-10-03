/**
 * voice-light — shared, mutable signal bus between the VoiceOrb (which owns
 * the audio analysis) and VoiceFloorGlow (which paints ambient light).
 *
 * Both sides animate imperatively via rAF; this singleton is written every
 * frame by the orb's loop and read every frame by the glow's loop. No React
 * state, no re-renders — the same pattern the orb itself uses for eyes/mouth.
 *
 *   state — mirrors the voice session state ("off" | "idle" | ... | "error")
 *   user  — 0..1 smoothed mic amplitude (0 when no analyser / session off)
 *   model — 0..1 model speech intensity (chomp level; 0 unless "speaking")
 */

export interface VoiceLightSignal {
  state: string;
  user: number;
  model: number;
}

export const voiceLight: VoiceLightSignal = { state: "off", user: 0, model: 0 };
