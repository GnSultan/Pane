/**
 * Companion Memory — the voice assistant's own memory of conversations.
 *
 * The project brain (playbook, knowledge graph) is SEMANTIC memory — lessons
 * about what we build. This is EPISODIC memory — the moments between us:
 * what we talked about Tuesday, what you decided, what's still open. The
 * assistant in the room remembers; the wiki doesn't.
 *
 * Three layers, each doing what it's uniquely good at:
 *
 *   1. JOURNAL (append-only) — exact words, exact times, forever. One JSONL
 *      file at ~/.pane/companion/journal.jsonl. When you say "remember when
 *      I told you about X four days ago", recall_conversation searches THIS
 *      and quotes it back. Deterministic keyword search — never an LLM
 *      guessing at history (no hallucinated memories, ever).
 *
 *   2. DISTILLED SELF (memory.md) — the working state of the relationship:
 *      who you're building what with, open threads, how you like to work.
 *      Rebuilt by a small LLM pass at session end from raw journal slices.
 *      Injected at every session mint so the assistant opens already
 *      knowing where you left off — continuity you can hear in the first
 *      sentence, without stuffing the whole journal into context.
 *
 *   3. PROJECT MEMORY BRIDGE — project facts land in the project's own
 *      memory via the existing pane_remember pipeline, not here. The
 *      companion journal records that we talked about them (episodic),
 *      the project memory keeps the fact itself (semantic).
 *
 * Storage is global — one companion across all projects. A conversation
 * about the voice orb in the portfolio project is still a conversation we
 * had; per-project walls would fragment exactly the continuity this exists
 * to create. Project-specific facts go to project memory instead.
 *
 * Bounded: journal capped at 5000 entries (~2-4 MB), distill input capped
 * at 400 lines, every LLM call has a timeout. Memory failures NEVER break
 * the voice session — journal() is fire-and-forget, recall() returns empty
 * results on error, distill failures keep the previous memory.md.
 */

import path from "node:path";
import fs from "node:fs";
import os from "node:os";

const COMPANION_DIR = path.join(os.homedir(), ".pane", "companion");
const JOURNAL_PATH = path.join(COMPANION_DIR, "journal.jsonl");
const MEMORY_PATH = path.join(COMPANION_DIR, "memory.md");

const MAX_JOURNAL_ENTRIES = 5000;
const MAX_ENTRY_CHARS = 2000; // per utterance — conversations, not essays
const MAX_RECALL_HITS = 8;
const MAX_RECALL_CHARS = 12000;

// Distill LLM call budget
const DISTILL_TIMEOUT_MS = 30_000;
const MIN_EXCHANGES_FOR_DISTILL = 3;
const DISTILL_INPUT_LINES = 400;

/** Append a spoken exchange to the journal. Fire-and-forget safe. */
export function journalExchange(entry) {
  try {
    const {
      role, // "user" | "assistant"
      text, // exact spoken words
      projectId, // where we were (context, not the memory's subject)
      projectName, // human name for the place we were in
    } = entry;
    if (!role || !text) return { ok: false, error: "role and text required" };
    const record = {
      ts: Date.now(),
      role: role === "assistant" ? "assistant" : "user",
      text: String(text).slice(0, MAX_ENTRY_CHARS),
      projectId: projectId || null,
      projectName: projectName || null,
    };
    fs.mkdirSync(COMPANION_DIR, { recursive: true });
    fs.appendFileSync(JOURNAL_PATH, JSON.stringify(record) + "\n", "utf-8");
    trimJournal();
    return { ok: true };
  } catch (err) {
    console.warn("[companion] journal append failed:", err?.message);
    return { ok: false, error: String(err) };
  }
}

/** Keep the journal bounded — drop oldest beyond the cap, atomically. */
function trimJournal() {
  try {
    const stat = fs.statSync(JOURNAL_PATH);
    if (stat.size < 1_000_000) return; // small enough — skip the rewrite cost
    const lines = fs.readFileSync(JOURNAL_PATH, "utf-8").split("\n").filter(Boolean);
    if (lines.length <= MAX_JOURNAL_ENTRIES) return;
    const keep = lines.slice(lines.length - MAX_JOURNAL_ENTRIES);
    const tmp = JOURNAL_PATH + ".tmp";
    fs.writeFileSync(tmp, keep.join("\n") + "\n", "utf-8");
    fs.renameSync(tmp, JOURNAL_PATH);
  } catch {
    // Trimming is best-effort; never let it break an append path.
  }
}

/** Read the whole journal, oldest first. Corrupt lines are skipped. */
function readJournal() {
  try {
    const content = fs.readFileSync(JOURNAL_PATH, "utf-8");
    const out = [];
    for (const line of content.split("\n")) {
      if (!line) continue;
      try {
        out.push(JSON.parse(line));
      } catch {
        // torn/corrupt line — skip, never crash recall
      }
    }
    return out;
  } catch {
    return []; // no journal yet — first session
  }
}

const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "but", "if", "of", "at", "by", "for", "with",
  "about", "to", "from", "in", "on", "is", "are", "was", "were", "be", "been",
  "it", "this", "that", "these", "those", "i", "you", "we", "they", "he",
  "me", "my", "your", "our", "their", "do", "does", "did", "have", "has", "had",
  "will", "would", "can", "could", "should", "just", "so", "not", "no", "yes",
  "what", "when", "where", "which", "who", "how", "why", "them", "then", "than",
  "there", "here", "like", "get", "got", "go", "going", "went", "up", "out",
]);

/**
 * Deterministic keyword recall over the journal — the exact-recall path.
 * Multi-token: every non-stopword token must appear in the entry's text
 * (case-insensitive). Newest first; returns compact hits so the voice model
 * can quote them naturally in speech.
 */
export function recallConversations(query, opts = {}) {
  try {
    const { limit = MAX_RECALL_HITS, daysBack = null } = opts;
    const tokens = String(query || "")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length >= 2 && !STOPWORDS.has(t));
    if (!tokens.length) {
      return { ok: true, query, hits: [], note: "query had no searchable tokens" };
    }

    const cutoff = daysBack ? Date.now() - daysBack * 864e5 : 0;
    const hits = [];
    for (const entry of readJournal()) {
      if (!entry || typeof entry.ts !== "number" || entry.ts < cutoff) continue;
      const text = String(entry.text || "").toLowerCase();
      const matched = tokens.filter((t) => text.includes(t));
      if (matched.length === tokens.length) {
        hits.push({
          ts: entry.ts,
          role: entry.role,
          project: entry.projectName || entry.projectId || null,
          text: entry.text,
        });
      }
    }

    // Newest first: "that thing from last week" should surface the recent one.
    hits.sort((a, b) => b.ts - a.ts);
    const capped = hits.slice(0, limit);
    let budget = MAX_RECALL_CHARS;
    const out = [];
    for (const h of capped) {
      if (budget <= 200) break;
      const slice = h.text.slice(0, Math.min(h.text.length, budget - 200));
      out.push({
        when: new Date(h.ts).toISOString(),
        role: h.role,
        project: h.project,
        text: slice,
      });
      budget -= slice.length + 120;
    }
    return {
      ok: true,
      query,
      hits: out,
      note: out.length ? `${hits.length} match(es), showing newest ${out.length}` : "no matches",
    };
  } catch (err) {
    console.warn("[companion] recall failed:", err?.message);
    return { ok: false, error: String(err), hits: [] };
  }
}

/**
 * Distill the journal into memory.md — the working state of the relationship.
 * Called at session end. llmCall goes through the same OpenAI key already
 * used for realtime/TTS; failures keep the existing memory.md untouched.
 */
export async function distillCompanionMemory(llmCall, opts = {}) {
  try {
    const { force = false, sessionExchanges = null } = opts;
    if (typeof llmCall !== "function") {
      return { ok: false, error: "llmCall (systemPrompt, userPrompt) => string required" };
    }

    // Skip trivial sessions — nothing relationship-worthy happened.
    // sessionExchanges is the count from THIS session (caller knows it);
    // null means caller couldn't tell us, fall back to journal presence.
    if (!force) {
      if (typeof sessionExchanges === "number" && sessionExchanges < MIN_EXCHANGES_FOR_DISTILL) {
        return { ok: true, skipped: true, reason: "session too small" };
      }
      if (sessionExchanges === null) {
        const total = readJournal().length;
        if (total < MIN_EXCHANGES_FOR_DISTILL) {
          return { ok: true, skipped: true, reason: "too few exchanges" };
        }
      }
    }

    const journal = readJournal();
    const recent = journal.slice(-DISTILL_INPUT_LINES).map((e) => {
      const day = new Date(e.ts).toISOString().slice(0, 10);
      const where = e.projectName ? ` [${e.projectName}]` : "";
      return `${day}${where} ${e.role}: ${e.text}`;
    });

    const previous = safeRead(MEMORY_PATH);
    const system = [
      "You maintain the memory of an ongoing working relationship between Aslam and his voice assistant.",
      "You will receive the previous memory and a recent slice of the conversation journal.",
      "Update the memory to reflect what's new. Keep what's still true. Drop what's stale or resolved.",
      "",
      "The memory has four sections:",
      "## Working on",
      "One line per active project — what it is and where it stands.",
      "## Open threads",
      "Unresolved questions, promised follow-ups, things Aslam circled back to. Mark resolved threads as done — or drop them.",
      "## How we work",
      "Stable preferences observed in conversation (not code lessons — those live in project memory). E.g. 'prefers being asked one clarifying question before delegation'.",
      "## Last time",
      "A 2-3 sentence recap of the most recent session — what we talked about, where we left off.",
      "",
      "Rules:",
      "- Write in second person about Aslam, plain declarative sentences. No headers beyond the four above.",
      "- ONLY facts from the journal provided. Never invent, never fill gaps, never speculate from training data.",
      "- If the journal slice contradicts the previous memory, the journal wins.",
      "- Keep the whole thing under 300 words. Tight memory, not a transcript.",
      "- Return ONLY the markdown. No code fences, no commentary.",
    ].join("\n");

    const user = [
      previous ? `## Previous memory\n${previous}` : "## Previous memory\n(none — first distillation)",
      "",
      `## Journal slice (${recent.length} most recent entries, ${new Date().toISOString().slice(0, 10)})`,
      ...recent,
      "",
      "Return the updated memory markdown.",
    ].join("\n");

    const result = await withTimeout(llmCall(system, user), DISTILL_TIMEOUT_MS, "distill llm call");
    const md = String(result || "").trim();
    if (!md) return { ok: false, error: "distill returned empty" };
    fs.mkdirSync(COMPANION_DIR, { recursive: true });
    fs.writeFileSync(MEMORY_PATH, md + "\n", "utf-8");
    return { ok: true, words: md.split(/\s+/).length };
  } catch (err) {
    console.warn("[companion] distill failed:", err?.message);
    return { ok: false, error: String(err) };
  }
}

function safeRead(p) {
  try {
    return fs.readFileSync(p, "utf-8").trim() || null;
  } catch {
    return null;
  }
}

function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

/**
 * The companion-memory block injected into voice session instructions.
 * Empty string when nothing exists yet — first session has no past, honestly.
 */
export function getCompanionBlock() {
  const memory = safeRead(MEMORY_PATH);
  if (!memory) return "";
  return (
    "\n\n## Your memory of us\n\n" +
    "This is your own continuously-updated memory of your conversations with Aslam — " +
    "not project knowledge (the project memory tools cover that). When he references " +
    "something you discussed days ago, this is what it was:\n\n" +
    memory +
    "\n\nUse it naturally: open with where we left off when it fits, recall specifics " +
    "when asked, never recite it. For anything not in this memory, search the exact " +
    "record with recall_conversation."
  );
}

/** Journal size + memory presence, for diagnostics. */
export function companionStats() {
  const journal = readJournal();
  return {
    entries: journal.length,
    oldest: journal.length ? journal[0].ts : null,
    newest: journal.length ? journal[journal.length - 1].ts : null,
    memoryBytes: safeRead(MEMORY_PATH)?.length ?? 0,
  };
}
