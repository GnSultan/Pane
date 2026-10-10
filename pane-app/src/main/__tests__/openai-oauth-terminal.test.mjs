import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ── Harness ──────────────────────────────────────────────────────────────────
// openai-oauth keeps module-level state (_cache, _refreshPromise, _terminalAuth).
// vi.resetModules() + dynamic import (literal path, Vite-analyzable) gives each
// test a pristine module instance. CODEX_HOME is read at call time inside
// readCodexCredentials, so pointing it at a temp dir per test isolates creds.

const CASES = mkdtempSync(join(tmpdir(), "pane-oauth-test-"));

function fakeAuthJson({ refreshToken = "rt-old", expOffsetSec = -60, lastRefresh = null } = {}) {
  // Minimal JWT: header.payload.signature — payload carries exp
  const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64url");
  const access = ["x", b64({ exp: Math.floor(Date.now() / 1000) + expOffsetSec }), "y"].join(".");
  return JSON.stringify({
    tokens: {
      access_token: access,
      refresh_token: refreshToken,
      id_token: "",
      account_id: "acct_test",
    },
    last_refresh: lastRefresh,
  });
}

async function freshModule() {
  vi.resetModules();
  return import("../openai-oauth.mjs");
}

async function setupCase(authJson) {
  const dir = join(CASES, `c${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "auth.json"), authJson);
  process.env.CODEX_HOME = dir;
  return dir;
}

function successResponse() {
  const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64url");
  const access = ["x", b64({ exp: Math.floor(Date.now() / 1000) + 3600 }), "y"].join(".");
  return {
    ok: true,
    status: 200,
    text: async () => "",
    json: async () => ({ access_token: access, refresh_token: "rt-NEW", expires_in: 3600 }),
  };
}

const originalCodexHome = process.env.CODEX_HOME;

afterEach(() => {
  process.env.CODEX_HOME = originalCodexHome;
  vi.unstubAllGlobals();
});

afterAll(() => {
  rmSync(CASES, { recursive: true, force: true });
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe("openai-oauth terminal auth handling", () => {
  it("returns null (not a stale token) when refresh fails terminally with invalid_grant", async () => {
    await setupCase(fakeAuthJson({ refreshToken: "rt-dead" }));
    const mod = await freshModule();

    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 400,
      text: async () =>
        JSON.stringify({
          error: {
            message:
              "Your refresh token has already been used to generate a new access token. Please try signing in again.",
            type: "invalid_request_error",
          },
        }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    const token = await mod.getAccessToken();
    expect(token).toBeNull(); // NOT the stale access token
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Latched: subsequent calls fail fast without another POST
    const token2 = await mod.getAccessToken();
    expect(token2).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1); // no re-POST of the dead token
  });

  it("treats network errors as transient and falls back to the existing token", async () => {
    await setupCase(fakeAuthJson({ refreshToken: "rt-net", expOffsetSec: -60 }));
    const mod = await freshModule();

    const fetchMock = vi.fn(async () => {
      throw new Error("ECONNRESET");
    });
    vi.stubGlobal("fetch", fetchMock);

    const token = await mod.getAccessToken();
    // Transient: returns the existing access token as fallback — it may
    // still be accepted server-side (signature valid)
    expect(typeof token).toBe("string");
    expect(token.startsWith("x.")).toBe(true);
  });

  it("single-flights concurrent refreshes — one POST for parallel callers", async () => {
    await setupCase(fakeAuthJson({ refreshToken: "rt-race" }));
    const mod = await freshModule();

    // Deferred response: the POST stays pending until we settle it, giving
    // the second caller time to arrive and share the in-flight promise.
    let resolveRefresh;
    const fetchMock = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveRefresh = () => resolve(successResponse());
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const p1 = mod.getAccessToken();
    const p2 = mod.getAccessToken();
    // Let both callers pass their synchronous prefix and reach the refresh
    await new Promise((r) => setTimeout(r, 20));
    expect(fetchMock).toHaveBeenCalledTimes(1); // exactly one POST so far

    resolveRefresh();
    const [a, b] = await Promise.all([p1, p2]);

    // Both callers served by the single shared POST — never a second one
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(a).toBeTruthy();
    expect(b).toBeTruthy();
  });

  it("clears the terminal latch when a different (fresh) refresh token appears on disk", async () => {
    const dir = await setupCase(fakeAuthJson({ refreshToken: "rt-dead-1" }));
    const mod = await freshModule();

    let dead = true;
    const fetchMock = vi.fn(async () => {
      if (dead) {
        return {
          ok: false,
          status: 400,
          text: async () => JSON.stringify({ error: { message: "revoked", code: "invalid_grant" } }),
        };
      }
      return successResponse();
    });
    vi.stubGlobal("fetch", fetchMock);

    // First: dead token → null + latch
    expect(await mod.getAccessToken()).toBeNull();

    // codex login writes a NEW refresh token. No invalidateCache — the
    // latch must self-clear from the on-disk mismatch alone.
    dead = false;
    writeFileSync(join(dir, "auth.json"), fakeAuthJson({ refreshToken: "rt-fresh-1" }));

    const token = await mod.getAccessToken();
    expect(typeof token).toBe("string");
    expect(fetchMock).toHaveBeenCalledTimes(2); // dead attempt + fresh success
  });
});
