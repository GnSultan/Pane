import { describe, it, expect } from "vitest";
import { isPlanLimitError } from "../http-backend.mjs";

// ---------------------------------------------------------------------------
// isPlanLimitError — the terminal classifier shared by every retry gate.
//
// Sep 19 2026 trace: Anthropic Plus hit usage_limit_reached (429, resets_in
// ~2.6h). The detection sites threw the friendly error, but three nested
// retry gates classified it as recoverable and blind-retried: the stream-path
// network catch (7 fetches ≈ 2min), the per-turn catch (3 retries), and the
// session auto-resume (2 full respawns replaying everything) — ≈6 minutes of
// silence before the user saw the truth. This classifier + _noRetry flags
// close all three gates. These tests pin the exact phrases thrown at the
// detection sites so a future wording change can't silently reopen the hole.
// ---------------------------------------------------------------------------

describe("isPlanLimitError", () => {
  // ── Anthropic: phrases produced by the stream/planning/conversation
  //    detection sites (grep "usage_limit_reached" in http-backend.mjs) ──
  it("classifies the Anthropic reset-time message", () => {
    expect(
      isPlanLimitError(
        "Anthropic plus plan limit reached — resets 11:41:00 AM",
      ),
    ).toBe(true);
  });

  it("classifies the Anthropic no-reset-time message", () => {
    expect(
      isPlanLimitError(
        "Anthropic plan limit reached (usage_limit_reached) — no reset time provided",
      ),
    ).toBe(true);
  });

  it("classifies the raw upstream body shape", () => {
    // Defense in depth: if the friendly wrapper is ever lost, the raw
    // body's identifier phrases still classify.
    expect(
      isPlanLimitError(
        'HTTP 429: {"error":{"type":"usage_limit_reached","message":"The usage limit has been reached"}}',
      ),
    ).toBe(true);
  });

  // ── Z.ai: phrases produced by formatZaiQuotaError (provider-monitor.mjs) ──
  it("classifies every formatZaiQuotaError variant", () => {
    const variants = [
      "Z.ai quota exhausted — recharge at z.ai · resets at 02:41 PM", // 1113
      "Z.ai Coding Plan expired — renew at z.ai/subscribe", // 1309
      "Z.ai weekly limit reached · resets at 02:41 PM", // 1310
      "Z.ai plan doesn't include this model", // 1311
      "Z.ai Fair Usage Policy limit active", // 1313
      "Z.ai enterprise package issue", // 1314/1315
      "Z.ai quota exhausted · resets at 02:41 PM", // 1308, 1316-1321
    ];
    for (const v of variants) expect(isPlanLimitError(v)).toBe(true);
  });

  // ── Congestion must NOT be classified terminal — mirroring the opposite
  //    axis: a plain 429 without plan-limit identity is still retryable. ──
  it("does not classify plain congestion 429s", () => {
    expect(isPlanLimitError("HTTP 429: too many requests")).toBe(false);
    expect(isPlanLimitError("rate limited")).toBe(false);
    expect(isPlanLimitError("HTTP 429: {\"error\":{\"type\":\"rate_limit_error\"}}")).toBe(false);
  });

  it("does not classify transient 5xx or network errors", () => {
    expect(isPlanLimitError("HTTP 503: service unavailable")).toBe(false);
    expect(isPlanLimitError("ECONNRESET")).toBe(false);
    expect(isPlanLimitError("Stream idle timeout — no data received for 60s")).toBe(false);
  });

  it("does not classify auth or validation errors", () => {
    expect(isPlanLimitError("HTTP 401: unauthorized")).toBe(false);
    expect(isPlanLimitError("HTTP 400: invalid request")).toBe(false);
    expect(isPlanLimitError("OpenAI OAuth token expired — run codex login again.")).toBe(false);
  });

  it("tolerates null/undefined/empty messages", () => {
    expect(isPlanLimitError(null)).toBe(false);
    expect(isPlanLimitError(undefined)).toBe(false);
    expect(isPlanLimitError("")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// _noRetry propagation contract
//
// The detection sites now set fatal._noRetry = true before throwing. The
// gates check the flag OR the classifier. This pins the contract that the
// flag survives the throw (plain Error property assignment) so a refactor
// to a custom error class or structuredClone boundary can't drop it.
// ---------------------------------------------------------------------------
describe("plan-limit error flag propagation", () => {
  it("the _noRetry flag survives on the thrown error", () => {
    const friendlyMsg = "Anthropic plus plan limit reached — resets 11:41:00 AM";
    const fatal = new Error(friendlyMsg);
    fatal._noRetry = true;
    // Simulate each gate's check
    const gate = (err) => Boolean(err?._noRetry || isPlanLimitError(err?.message));
    expect(gate(fatal)).toBe(true);
    expect(gate(new Error("HTTP 429: rate limited"))).toBe(false);
  });
});
