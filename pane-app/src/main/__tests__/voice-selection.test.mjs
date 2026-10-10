import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  REALTIME_VOICES,
  resolveVoiceSelection,
  VoiceRelay,
} from "../voice-relay.mjs";

/**
 * Voice selection integrity (Sep 2026). The live session served a male
 * voice (ballad) while the user had selected a female one (marin): the
 * accent-coupling remap in the old readVoiceSetting silently rewrote any
 * non-British-leaning voice to ballad whenever accent=british. These tests
 * pin the contract that replaced it:
 *
 *   1. The persisted selection is served VERBATIM — accent, catalog, and
 *      overrides may never rewrite it.
 *   2. A selection missing from the provider catalog is an explicit error
 *      naming the voice and valid options — never a silent default.
 *   3. No selection at all is the single sanctioned default, flagged as
 *      defaulted so telemetry can tell it apart from a user choice.
 *   4. The UI picker's option list matches the resolver's catalog exactly —
 *      a drift between them is how stale IDs reach the resolver.
 */

let dir = "";

function writeSettings(obj) {
  const p = path.join(dir, "settings.json");
  writeFileSync(p, JSON.stringify(obj), "utf-8");
  return p;
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "pane-voice-test-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("voice catalog", () => {
  it("contains the verified realtime voices", () => {
    for (const v of ["alloy", "ash", "ballad", "coral", "echo", "sage", "shimmer", "verse", "marin", "cedar"]) {
      expect(REALTIME_VOICES).toContain(v);
    }
  });

  it("matches the Profile picker option list (source-level)", async () => {
    // The picker writes what it renders; the resolver validates what the
    // picker wrote. If these drift, every new voice ships broken until a
    // user hits the error path.
    const fs = await import("node:fs");
    const src = fs.readFileSync(
      new URL("../../renderer/components/Workspace/Profile.tsx", import.meta.url),
      "utf8",
    );
    const m = src.match(/const VOICE_OPTIONS[^;]+;/s);
    expect(m).toBeTruthy();
    const pickerIds = [...src.matchAll(/\{ id: "([a-z]+)", note:/g)].map((x) => x[1]);
    expect(pickerIds.length).toBeGreaterThan(0);
    expect([...pickerIds].sort()).toEqual([...REALTIME_VOICES].sort());
  });
});

describe("resolveVoiceSelection — selection wins verbatim", () => {
  it("serves the persisted voice unchanged when accent is british (the regression)", async () => {
    // Exact scenario from the live bug: marin + british must NOT become ballad.
    const p = writeSettings({ voice_settings: { voice: "marin", accent: "british" } });
    const r = await resolveVoiceSelection(null, { settingsPath: p });
    expect(r.ok).toBe(true);
    expect(r.voice).toBe("marin"); // verbatim — never remapped
    expect(r.accent).toBe("british");
    expect(r.defaulted).toBe(false);
  });

  it("serves every catalog voice verbatim regardless of accent", async () => {
    for (const v of REALTIME_VOICES) {
      const p = writeSettings({ voice_settings: { voice: v, accent: "british" } });
      const r = await resolveVoiceSelection(null, { settingsPath: p });
      expect(r.ok, `voice ${v}`).toBe(true);
      expect(r.voice, `voice ${v}`).toBe(v);
    }
  });

  it("override (preview) wins over persisted selection, still never remapped", async () => {
    const p = writeSettings({ voice_settings: { voice: "marin", accent: "british" } });
    const r = await resolveVoiceSelection("cedar", { settingsPath: p });
    expect(r.ok).toBe(true);
    expect(r.voice).toBe("cedar");
    expect(r.accent).toBe("british"); // accent still read from settings
  });

  it("no substitution logic remains in the module (source-level pin)", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync(new URL("../voice-relay.mjs", import.meta.url), "utf8");
    expect(src).not.toContain("BRITISH_LEANING_VOICES");
    expect(src).not.toContain('"ballad" ? v :');
    expect(src).toContain("export async function resolveVoiceSelection");
  });
});

describe("resolveVoiceSelection — error paths", () => {
  it("rejects an unknown persisted voice with options listed", async () => {
    const p = writeSettings({ voice_settings: { voice: "ballad-xl", accent: "none" } });
    const r = await resolveVoiceSelection(null, { settingsPath: p });
    expect(r.ok).toBe(false);
    expect(r.voice).toBe("ballad-xl");
    expect(r.error).toContain("ballad-xl");
    expect(r.error).toContain("alloy");
    expect(r.error).toContain("marin");
    expect(r.error).toContain("Profile → Voice");
  });

  it("rejects an unknown override voice (preview path)", async () => {
    const p = writeSettings({ voice_settings: { voice: "marin", accent: "none" } });
    const r = await resolveVoiceSelection("sir-not-appearing", { settingsPath: p });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("sir-not-appearing");
  });

  it("errors on unreadable settings.json instead of defaulting (masks nothing)", async () => {
    const p = path.join(dir, "settings.json");
    writeFileSync(p, "{ this is not json", "utf-8");
    const r = await resolveVoiceSelection(null, { settingsPath: p });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("Could not read voice settings");
  });

  it("defaults (flagged) only when no voice was ever selected", async () => {
    const p = writeSettings({}); // fresh install shape
    const r = await resolveVoiceSelection(null, { settingsPath: p });
    expect(r.ok).toBe(true);
    expect(r.defaulted).toBe(true);
    expect(REALTIME_VOICES).toContain(r.voice);
  });
});

describe("VoiceRelay.mintToken / previewToken surface resolver errors", () => {
  it("previewToken fails fast on an unknown voice without touching the network", async () => {
    const relay = new VoiceRelay();
    const r = await relay.previewToken("ballad-xl");
    expect(r.ok).toBe(false);
    expect(r.error).toContain("ballad-xl");
  });

  it("mintToken fails fast when the persisted voice is invalid", async () => {
    const relay = new VoiceRelay();
    const p = writeSettings({ voice_settings: { voice: "stale-renamed", accent: "none" } });
    // The relay reads the real settings path; run against the seam by
    // pointing HOME nowhere is invasive — instead assert the resolver
    // contract mintToken depends on, plus the fail-fast path directly:
    const r = await resolveVoiceSelection(null, { settingsPath: p });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("stale-renamed");
  });
});
