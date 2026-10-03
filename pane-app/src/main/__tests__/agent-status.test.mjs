import { describe, it, expect, beforeEach } from "vitest";
import {
  setPhase,
  getThreadStatus,
  getSnapshot,
  voiceSnapshot,
  _resetForTest,
  AGENT_PHASES,
} from "../agent-status.mjs";

beforeEach(() => {
  _resetForTest();
});

// ── Schema enforcement ────────────────────────────────────────────────────

describe("schema enforcement", () => {
  it("ignores unknown phases — store unchanged", () => {
    setPhase("t1", { phase: "planning" });
    setPhase("t1", { phase: "vibing" });
    expect(getThreadStatus("t1").phase).toBe("planning");
  });

  it("ignores non-string projectIds", () => {
    setPhase(null, { phase: "planning" });
    setPhase(undefined, { phase: "planning" });
    setPhase(123, { phase: "planning" });
    expect(getSnapshot().threads).toHaveLength(0);
  });

  it("accepts exactly the standard phase vocabulary", () => {
    expect([...AGENT_PHASES].sort()).toEqual(
      ["done", "editing", "error", "idle", "planning", "waiting"].sort(),
    );
  });

  it("drops extra fields — no free-form detail can enter the store", () => {
    setPhase("t1", {
      phase: "planning",
      detail: "SECRET user prompt text",
      prompt: "another secret",
      content: "file contents",
      apiKey: "sk-xxx",
    });
    const rec = getThreadStatus("t1");
    expect(rec.detail).toBeUndefined();
    expect(rec.prompt).toBeUndefined();
    expect(rec.content).toBeUndefined();
    expect(rec.apiKey).toBeUndefined();
    // Structurally: the record has exactly the known keys.
    expect(Object.keys(rec).sort()).toEqual(
      [
        "threadId",
        "threadName",
        "phase",
        "readOnly",
        "currentTool",
        "lastFile",
        "turnCount",
        "agent",
        "updatedAt",
        "events",
      ].sort(),
    );
  });

  it("stores file paths as basenames only", () => {
    setPhase("t1", { phase: "editing", tool: "replace", file: "src/renderer/components/Deep/Secret.tsx" });
    expect(getThreadStatus("t1").lastFile).toBe("Secret.tsx");
  });

  it("handles windows-style paths", () => {
    setPhase("t1", { phase: "editing", file: "C:\\Users\\macbook\\ Pane\\thing.ts" });
    expect(getThreadStatus("t1").lastFile).toBe("thing.ts");
  });

  it("clamps oversized strings", () => {
    setPhase("t1", { phase: "planning", agent: "x".repeat(500) });
    expect(getThreadStatus("t1").agent.length).toBeLessThanOrEqual(120);
  });
});

// ── Voice projection (permissions boundary) ───────────────────────────────

describe("voiceSnapshot redaction", () => {
  it("projects only whitelisted fields — unknown future fields invisible", () => {
    setPhase("t1", { phase: "editing", tool: "replace", file: "a.ts" });
    // Simulate the store growing a field later (direct map poke):
    const rec = getThreadStatus("t1");
    rec.futureSecretField = "leak?";
    const vs = voiceSnapshot();
    const t = vs.threads[0];
    expect(t.futureSecretField).toBeUndefined();
    expect(t.threadId).toBe("t1");
    expect(t.phase).toBe("editing");
  });

  it("events carry only ts/phase/tool/file", () => {
    setPhase("t1", { phase: "planning" });
    setPhase("t1", { phase: "editing", tool: "write_file", file: "a.ts" });
    const rec = getThreadStatus("t1");
    rec.events[0].sneaky = "payload";
    const vs = voiceSnapshot();
    for (const ev of vs.threads[0].events) {
      expect(Object.keys(ev).every((k) => ["ts", "phase", "tool", "file"].includes(k))).toBe(true);
    }
  });

  it("never contains prompt-derived data — no detail field exists at all", () => {
    setPhase("t1", { phase: "planning" });
    const vs = JSON.stringify(voiceSnapshot());
    expect(vs).not.toContain("detail");
  });
});

// ── Agent identity ────────────────────────────────────────────────────────

describe("agent identity", () => {
  it("records model@provider identity", () => {
    setPhase("t1", { phase: "planning", agent: "gpt-5.6-sol@openai" });
    setPhase("t2", { phase: "editing", agent: "glm-5.3@z-ai" });
    const vs = voiceSnapshot();
    expect(vs.threads.find((t) => t.threadId === "t1").agent).toBe("gpt-5.6-sol@openai");
    expect(vs.threads.find((t) => t.threadId === "t2").agent).toBe("glm-5.3@z-ai");
  });

  it("identity persists across phase changes within a run", () => {
    setPhase("t1", { phase: "planning", agent: "m@p" });
    setPhase("t1", { phase: "editing", tool: "replace" }); // no agent arg
    expect(getThreadStatus("t1").agent).toBe("m@p");
  });
});

// ── Event lifecycle ───────────────────────────────────────────────────────

describe("event lifecycle", () => {
  it("full lifecycle: planning → editing → waiting → done", () => {
    setPhase("t1", { phase: "planning", agent: "m@p" });
    setPhase("t1", { phase: "planning", tool: "read_file", file: "a.ts" });
    setPhase("t1", { phase: "editing", tool: "replace", file: "a.ts" });
    setPhase("t1", { phase: "waiting" });
    setPhase("t1", { phase: "planning", tool: "read_file" });
    setPhase("t1", { phase: "done", turn: 7 });

    const rec = getThreadStatus("t1");
    expect(rec.phase).toBe("done");
    expect(rec.turnCount).toBe(7);
    // Last 6 events, in order
    expect(rec.events.map((e) => e.phase)).toEqual([
      "planning",
      "planning",
      "editing",
      "waiting",
      "planning",
      "done",
    ]);
  });

  it("terminal phases clear currentTool", () => {
    setPhase("t1", { phase: "editing", tool: "replace" });
    expect(getThreadStatus("t1").currentTool).toBe("replace");
    setPhase("t1", { phase: "done" });
    expect(getThreadStatus("t1").currentTool).toBeNull();
  });

  it("caps the event ring at 20", () => {
    for (let i = 0; i < 30; i++) setPhase("t1", { phase: "planning", tool: `t${i}` });
    expect(getThreadStatus("t1").events).toHaveLength(20);
    // Oldest dropped, newest kept
    expect(getThreadStatus("t1").events[19].tool).toBe("t29");
    expect(getThreadStatus("t1").events[0].tool).toBe("t10");
  });

  it("readOnly tracks write classification", () => {
    setPhase("t1", { phase: "planning", readOnly: true });
    expect(getThreadStatus("t1").readOnly).toBe(true);
    setPhase("t1", { phase: "editing", readOnly: false });
    expect(getThreadStatus("t1").readOnly).toBe(false);
  });
});

// ── Snapshot shape ────────────────────────────────────────────────────────

describe("getSnapshot", () => {
  it("sorts threads by recency and reports active count", () => {
    setPhase("older", { phase: "planning" });
    setPhase("newer", { phase: "editing" });
    const snap = getSnapshot();
    expect(snap.threads[0].threadId).toBe("newer");
    // editing is an active phase; planning is also active; both fresh here
    expect(snap.activeThreads).toBe(2);
  });

  it("stale threads are marked and excluded from active count", async () => {
    setPhase("old", { phase: "editing" });
    // Backdate the record to beyond the stale TTL
    getThreadStatus("old").updatedAt = Date.now() - 31 * 60 * 1000;
    setPhase("fresh", { phase: "planning" });
    const snap = getSnapshot();
    const old = snap.threads.find((t) => t.threadId === "old");
    expect(old.stale).toBe(true);
    expect(snap.activeThreads).toBe(1);
  });

  it("terminal phases are not counted as active", () => {
    setPhase("t1", { phase: "done" });
    setPhase("t2", { phase: "error" });
    setPhase("t3", { phase: "idle" });
    expect(getSnapshot().activeThreads).toBe(0);
  });

  it("honors limit", () => {
    for (let i = 0; i < 5; i++) setPhase(`t${i}`, { phase: "planning" });
    expect(getSnapshot({ limit: 2 }).threads).toHaveLength(2);
  });

  it("getThreadStatus returns null for unknown threads", () => {
    expect(getThreadStatus("nope")).toBeNull();
  });
});
