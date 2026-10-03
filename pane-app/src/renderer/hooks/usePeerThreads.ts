/**
 * Peer Threads — model-initiated parallel delegation.
 *
 * A model in thread A calls pane_spawn_peer → main emits "peer-spawn-request"
 * → this hook (mounted once at app root) creates the peer thread, force-mounts
 * its Conversation (a never-visited thread has no pane:send-message listener),
 * delivers the objective through the peer's own send path, then watches the
 * peer's conversation until it goes idle and delivers a completion notice back
 * to the delegator via pane:send-message — the exact rail voice delegation
 * uses. The delegator's own busy/queue logic (messageQueueRef) handles a
 * mid-turn arrival; an idle delegator gets woken.
 *
 * Guarantees (learned from voice, Aug 28 2026):
 *   - The completion notice ALWAYS fires — success, error, or timeout. A peer
 *     that wedges (isProcessing stuck true) is reaped at 30 minutes, aborted,
 *     and reported as a failure. Silence is never the failure signal.
 *   - Notices carry failure reasons, not just silence ("peer aborted: X").
 *   - Depth-1 guard, enforced structurally: the renderer tracks which thread
 *     IDs are peers, and a peer thread can never spawn one. Combined with the
 *     one-active-spawn-per-delegator rule, chains are impossible.
 *   - A notice arriving while the delegator is mid-turn steers or queues via
 *     sendMessage's own logic. A notice arriving while the delegator is paused
 *     on ask_user is DEFERRED until the user answers — it must never land as
 *     the ask_user reply (pendingClear would swallow it as the user's answer).
 *   - Sub-poll races: a peer that finishes between polls (instant failure) is
 *     detected by its conversation content, not just the isProcessing edge.
 *
 * Known limits (v1): if the user closes the delegator thread while its peer
 * still runs, the notice has no destination and is dropped — but the peer
 * thread itself completes and stays in the thread list as the record. A page
 * reload orphans active watches (no notice, depth-guard reset) — same class
 * of limit as voice.
 */

import { useEffect, useRef } from "react";
import { useProjectsStore } from "../stores/projects";
import type { ElectronAPI } from "../lib/electron";

const electronAPI = window.electronAPI as ElectronAPI;

/** Hard ceiling on a peer run — anything longer is a wedge, not work. */
const PEER_TIMEOUT_MS = 30 * 60 * 1000;
/** How often to check watched peers for completion. */
const WATCH_POLL_MS = 1000;
/** If the peer never starts processing within this window, the spawn failed. */
const SPAWN_GRACE_MS = 5 * 60 * 1000;
/** Deferred objective delivery — Conversation mounts async (startTransition). */
const DELIVER_DELAY_MS = 400;

interface PeerWatch {
  /** Peer thread's projectId. */
  peerId: string;
  /** Delegating thread's projectId (notice destination). */
  sourceId: string;
  /** Peer thread name, for the notice text. */
  peerName: string;
  /** Started at — for timeout reaping. */
  startedAt: number;
  /** Set once the peer's conversation actually began processing. */
  sawProcessing: boolean;
}

interface PeerSpawnRequest {
  sourceProjectId: string;
  sourceRoot: string;
  objective: string;
  threadName: string;
  toolId: string;
}

/** Format the completion notice delivered to the delegator. */
function buildNotice(
  peerName: string,
  outcome: "completed" | "failed" | "timeout",
  summary: string | null,
): string {
  if (outcome === "completed") {
    return (
      `[peer completed] "${peerName}" finished. Summary from the peer thread:\n\n` +
      `${summary ?? "(no summary text)"}\n\n` +
      `Verify the peer's work before building on it — you delegated it, you own the result.`
    );
  }
  if (outcome === "timeout") {
    return (
      `[peer timeout] "${peerName}" did not finish within 30 minutes and was considered wedged. ` +
      `The peer thread still exists — inspect it to see how far it got; its journal is the record. ` +
      `Do not re-spawn blindly; check what held it up first.`
    );
  }
  return (
    `[peer failed] "${peerName}" aborted with an error. The peer thread's conversation shows exactly where and why. ` +
    `Failure reason: ${summary ?? "unknown"}`
  );
}

/** Notice texts are delivered as the delegator's next input. */

export function usePeerThreads(): void {
  const watchesRef = useRef<Map<string, PeerWatch>>(new Map());
  /** sourceId → peerName — active spawn per delegator (breadth guard). */
  const activeSpawnsRef = useRef<Map<string, string>>(new Map());
  /** Thread IDs created by this mechanism — a peer can never spawn a peer. */
  const peerThreadIdsRef = useRef<Set<string>>(new Set());
  /** Deferred notices: sourceId → notice, held while the delegator is paused on ask_user. */
  const deferredNoticesRef = useRef<Map<string, string>>(new Map());

  useEffect(() => {
    const deliver = (projectId: string, message: string): void => {
      window.dispatchEvent(
        new CustomEvent("pane:send-message", {
          detail: { projectId, message },
        }),
      );
    };

    /**
     * Deliver a completion notice to a delegator. If the delegator is paused
     * on ask_user, the notice MUST NOT land as the user's reply — it would be
     * swallowed by pendingClear and shown as the answer to the question the
     * user was asked. Defer it; the watcher loop releases it the moment the
     * pause clears (user answers → conversation goes busy, then idle).
     */
    const deliverNotice = (sourceId: string, notice: string): void => {
      const src = useProjectsStore.getState().projects.get(sourceId);
      if (src?.conversation.pendingInput) {
        deferredNoticesRef.current.set(sourceId, notice);
        return;
      }
      deliver(sourceId, notice);
    };

    /** Release any notice deferred for a delegator whose ask_user pause cleared. */
    const releaseDeferred = (): void => {
      for (const [sourceId, notice] of deferredNoticesRef.current) {
        const src = useProjectsStore.getState().projects.get(sourceId);
        // Still paused → keep holding. Thread gone → drop (delegator closed).
        if (src?.conversation.pendingInput) continue;
        if (!src) {
          deferredNoticesRef.current.delete(sourceId);
          continue;
        }
        // Pause cleared. If the delegator is mid-turn, the normal queue path
        // handles it; if idle, it wakes now.
        deferredNoticesRef.current.delete(sourceId);
        deliver(sourceId, notice);
      }
    };

    // ── Spawn handler ────────────────────────────────────────────────────
    const onSpawn = (req: PeerSpawnRequest) => {
      const store = useProjectsStore.getState();
      const source = store.projects.get(req.sourceProjectId);
      if (!source) {
        // Delegator vanished (thread closed mid-turn). Nothing is running;
        // log it so it's findable — don't fake success anywhere.
        console.warn(
          `[peer] spawn requested for missing source thread ${req.sourceProjectId} — dropped`,
        );
        return;
      }

      // Depth guard, structurally enforced: a peer thread can never spawn.
      // This closes the A→B→C chain that the breadth guard alone permits.
      if (peerThreadIdsRef.current.has(req.sourceProjectId)) {
        console.warn(
          `[peer] thread ${req.sourceProjectId} IS a peer — nested spawn rejected`,
        );
        window.setTimeout(
          () =>
            deliver(req.sourceProjectId,
              `[peer spawn rejected] Peer threads cannot spawn their own peers (depth limit: 1). ` +
              `Complete your objective; your delegator decides what runs next.`),
          0,
        );
        return;
      }

      // Breadth guard: one active peer per delegator.
      const existing = activeSpawnsRef.current.get(req.sourceProjectId);
      if (existing) {
        console.warn(
          `[peer] ${req.sourceProjectId} already has an active peer "${existing}" — spawn rejected`,
        );
        window.setTimeout(
          () =>
            deliver(
              req.sourceProjectId,
              `[peer spawn rejected] You already have an active peer thread "${existing}". ` +
                `Wait for its completion notice before spawning another. (Depth limit: 1.)`,
            ),
          0,
        );
        return;
      }

      // An unbound delegator (empty root) would produce a peer with no
      // project to work on — reject; the model stays in control.
      if (!req.sourceRoot) {
        console.warn(`[peer] spawn from unbound thread ${req.sourceProjectId} — rejected`);
        window.setTimeout(
          () =>
            deliver(
              req.sourceProjectId,
              `[peer spawn rejected] This thread has no project root, so a peer has nothing to work on. ` +
                `Bind the thread to a folder first.`,
            ),
          0,
        );
        return;
      }

      // Create the peer thread — same root as the delegator, so it inherits
      // the project's memory corpus (root-scope). addProject also ACTIVATES
      // the new thread, so capture the user's thread first and restore it
      // right after — the user must not be yanked into the peer.
      const userActiveId = store.activeProjectId;
      const peerId = store.addProject(req.sourceRoot, undefined, req.threadName);
      if (userActiveId && userActiveId !== peerId) {
        useProjectsStore.getState().setActiveProject(userActiveId);
      }
      peerThreadIdsRef.current.add(peerId);

      // Force-mount the peer's Conversation: a never-visited thread mounts
      // lazily on first activation, so it has no pane:send-message listener.
      // forceMount flips the layer to mounted without switching the user.
      useProjectsStore.getState().setForceMount(peerId, true);

      activeSpawnsRef.current.set(req.sourceProjectId, req.threadName);
      watchesRef.current.set(peerId, {
        peerId,
        sourceId: req.sourceProjectId,
        peerName: req.threadName,
        startedAt: Date.now(),
        sawProcessing: false,
      });

      // Deliver the objective through the peer's own send path. Deferred —
      // same mount-timing pattern as voice: a synchronous dispatch lands
      // before the Conversation's listener exists and the objective is lost.
      window.setTimeout(() => deliver(peerId, req.objective), DELIVER_DELAY_MS);
    };

    const offSpawn = electronAPI.on("peer-spawn-request", (req: unknown) => {
      onSpawn(req as PeerSpawnRequest);
    });

    // ── Completion watcher ───────────────────────────────────────────────
    const finishWatch = (
      w: PeerWatch,
      outcome: "completed" | "failed" | "timeout",
      detail: string | null,
    ): void => {
      watchesRef.current.delete(w.peerId);
      activeSpawnsRef.current.delete(w.sourceId);
      useProjectsStore.getState().setForceMount(w.peerId, false);
      deliverNotice(w.sourceId, buildNotice(w.peerName, outcome, detail));
      // If the delegator thread is not on screen, light its unread badge.
      const store = useProjectsStore.getState();
      if (store.activeProjectId !== w.sourceId) {
        store.setHasUnreadCompletion(w.sourceId, true);
      }
    };

    const checkWatch = (w: PeerWatch): void => {
      const store = useProjectsStore.getState();
      const peer = store.projects.get(w.peerId);

      // Peer thread closed by the user mid-run: report as failure —
      // the work did not complete.
      if (!peer) {
        finishWatch(w, "failed", "peer thread was closed while running");
        return;
      }

      const conv = peer.conversation;

      if (conv.isProcessing) {
        w.sawProcessing = true;
        // Wedge reaper — only meaningful once running. ABORT the peer's
        // backend turn too: "considered wedged" must not mean "keep
        // burning tokens and writing files in the background".
        if (Date.now() - w.startedAt > PEER_TIMEOUT_MS) {
          electronAPI
            .invoke("abort_punk", { projectId: w.peerId })
            .catch(() => {});
          finishWatch(w, "timeout", null);
        }
        return;
      }

      // Idle. Sub-poll completion: a peer that failed instantly (before the
      // first poll tick saw isProcessing) still has the objective + an
      // assistant/error record — detect by content, not just the flag.
      const hasContent =
        conv.messages.some((m) => m.type === "assistant") || !!conv.error;
      if (!w.sawProcessing && hasContent) {
        w.sawProcessing = true; // fall through to completion edge below
      }

      // Idle, never processed, no content: either spawn delivery failed
      // (grace window) or it's still the moment before kickoff.
      if (!w.sawProcessing) {
        if (Date.now() - w.startedAt > SPAWN_GRACE_MS) {
          finishWatch(w, "failed", "peer never started processing (spawn delivery failure)");
        }
        return;
      }

      // Completion edge: saw processing, now idle. Extract the peer's
      // last assistant text as its summary; surface any stored error.
      let summary: string | null = null;
      const messages = conv.messages;
      for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i]!;
        if (m.type === "assistant" && !m.isStreaming) {
          const text = (m.content || [])
            .filter((b): b is { type: "text"; text: string } => b?.type === "text")
            .map((b) => b.text)
            .join("\n")
            .trim();
          if (text) {
            summary = text;
            break;
          }
        }
      }
      finishWatch(w, conv.error ? "failed" : "completed", conv.error ?? summary);
    };

    const watchTimer = window.setInterval(() => {
      releaseDeferred();
      for (const w of [...watchesRef.current.values()]) checkWatch(w);
    }, WATCH_POLL_MS);

    return () => {
      offSpawn?.();
      window.clearInterval(watchTimer);
    };
  }, []);
}
