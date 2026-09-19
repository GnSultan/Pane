/**
 * Regression test: two-voices overlap bug (Aug 2026).
 *
 * Reproduces the exact race in useRealtimeVoice.ts connect() using a
 * standalone state machine that mirrors the hook's structure — same
 * guard order, same await points (token mint, mic acquire, SDP), same
 * teardown() semantics. The bug: connect()'s entry guard
 * `if (pcRef.current) return` only holds while pcRef is null — which
 * spans the async mint + getUserMedia window (~1–2s). A teardown +
 * reconnect landing inside that window let a second connect() through;
 * both adopted PCs, and the first PC was orphaned while still streaming
 * audio (two voices at once). Log signature: two session.created events
 * seconds apart on one continuous event counter (#2226 → #2229).
 *
 * The FIXED model below mirrors the hook exactly:
 *   - entry: pcRef null AND connectingId === null, else queue (pending)
 *   - owner-id: only the connect that set connectingId may release it
 *   - epoch: bumped by teardown; checked after every await; stale → abort
 *   - handoff: the owner's finally re-invokes a queued connect
 *
 * Run: npx vitest run src/main/__tests__/voice-session-race.test.mjs
 */
import { describe, it, expect } from "vitest";

function makeSession() {
  return {
    pcRef: null,
    connectSeq: 0,
    connectingId: null,
    pending: false,
    lastQueued: null, // latest label queued while another connect ran
    epoch: 0,
    livePCs: new Set(),
  };
}

function deferred() {
  let resolve, reject;
  const p = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise: p, resolve, reject };
}

function makePC(s, label) {
  const pc = {
    label,
    closed: false,
    close() {
      this.closed = true;
    },
  };
  s.livePCs.add(pc);
  return pc;
}

function teardown(s) {
  s.epoch += 1;
  if (s.pcRef) {
    s.pcRef.close();
    s.pcRef = null;
  }
}

async function connectFixed(s, io, label) {
  if (s.pcRef) return;
  if (s.connectingId !== null) {
    s.pending = true;
    s.lastQueued = label; // latest intent wins on handoff
    return;
  }
  const myId = ++s.connectSeq;
  s.connectingId = myId;
  s.pending = false;
  const epoch = s.epoch;
  try {
    await io.mint(label); // await #1 (~1.5s in prod)
    if (s.epoch !== epoch) return; // stale → abort silently
    const mic = await io.micAcquire(label); // await #2
    if (s.epoch !== epoch) {
      mic.stop();
      return;
    }
    await io.sdp(label); // await #3
    if (s.epoch !== epoch) {
      mic.stop();
      return;
    }
    const pc = makePC(s, label);
    s.pcRef = pc; // adopt — the only assignment
  } finally {
    if (s.connectingId === myId) {
      // owner-checked release
      s.connectingId = null;
      if (s.pending) {
        // handoff — never drop. Re-run with the LATEST queued intent:
        // mirrors the hook, whose handoff re-invokes connect()
        // parameterless — it re-mints with current settings, so the
        // newest request wins (rapid voice switches converge on the
        // final voice, not the first).
        s.pending = false;
        const next = s.lastQueued ?? label;
        s.lastQueued = null;
        void connectFixed(s, io, next);
      }
    }
  }
}

async function connectBuggy(s, io, label) {
  if (s.pcRef) return; // the only guard
  await io.mint(label);
  const mic = await io.micAcquire(label);
  await io.sdp(label);
  const pc = makePC(s, label);
  s.pcRef = pc; // clobber — PC_A orphaned
}

function ioResolved() {
  return {
    mint: () => Promise.resolve(),
    micAcquire: () => Promise.resolve({ stop() {} }),
    sdp: () => Promise.resolve(),
  };
}

describe("voice session connect() race", () => {
  it("BUGGY code orphans a PC when a voice switch lands during mint (reproduces two voices)", async () => {
    const s = makeSession();
    const mintGate = deferred();
    const io = {
      mint: () => mintGate.promise, // A blocks in mint
      micAcquire: () => Promise.resolve({ stop() {} }),
      sdp: () => Promise.resolve(),
    };

    const a = connectBuggy(s, io, "A"); // stalls inside mint
    teardown(s); // voice switch mid-mint
    const b = connectBuggy(s, io, "B"); // passes null guard — BUG

    mintGate.resolve();
    await Promise.all([a, b]);

    expect(s.pcRef?.label).toBe("B");
    const orphaned = [...s.livePCs].filter((p) => !p.closed);
    expect(orphaned).toHaveLength(2); // ← the two-voices bug
    expect(orphaned.map((p) => p.label).sort()).toEqual(["A", "B"]);
  });

  it("FIXED code: teardown during mint → handoff → exactly one live session", async () => {
    const s = makeSession();
    const mintGate = deferred();
    const io = {
      mint: () => mintGate.promise,
      micAcquire: () => Promise.resolve({ stop() {} }),
      sdp: () => Promise.resolve(),
    };

    const a = connectFixed(s, io, "A"); // stalls in mint
    teardown(s); // voice switch mid-mint
    const b = connectFixed(s, io, "B"); // queues (A owns slot)

    mintGate.resolve(); // A aborts stale, hands off
    await a;
    await new Promise((r) => setTimeout(r, 0)); // let handoff run
    await new Promise((r) => setTimeout(r, 0)); // let B's awaits resolve

    // Exactly one live PC, and it's the replacement (B), not A.
    const live = [...s.livePCs].filter((p) => !p.closed);
    expect(live).toHaveLength(1);
    expect(live[0].label.startsWith("B")).toBe(true);
    expect(s.pcRef?.label.startsWith("B")).toBe(true);
  });

  it("FIXED code: teardown AFTER adoption closes the adopted PC (normal switch)", async () => {
    const s = makeSession();
    await connectFixed(s, ioResolved(), "A");
    expect(s.pcRef).not.toBeNull();

    teardown(s);
    expect(s.pcRef).toBeNull();
    expect([...s.livePCs].filter((p) => !p.closed)).toHaveLength(0);
  });

  it("FIXED code: three rapid switches still end with exactly one live session", async () => {
    const s = makeSession();
    const gates = { a: deferred(), b: deferred(), c: deferred() };
    const io = {
      mint: (l) =>
        (l.startsWith("A") ? gates.a : l.startsWith("B") ? gates.b : gates.c)
          .promise,
      micAcquire: () => Promise.resolve({ stop() {} }),
      sdp: () => Promise.resolve(),
    };

    const p1 = connectFixed(s, io, "A");
    teardown(s);
    const p2 = connectFixed(s, io, "B");
    teardown(s);
    const p3 = connectFixed(s, io, "C");
    gates.a.resolve();
    gates.b.resolve();
    gates.c.resolve();
    await Promise.all([p1, p2, p3]);
    // A aborts stale → hands off to B's queued request → B aborts stale
    // (epoch bumped twice) → hands off to C → C adopts. Drain microtasks.
    for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));

    const live = [...s.livePCs].filter((p) => !p.closed);
    expect(live).toHaveLength(1);
    expect(s.pcRef?.label.startsWith("C")).toBe(true);
  });
});
