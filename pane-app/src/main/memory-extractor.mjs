/**
 * Memory Extractor — automatic post-turn memory extraction.
 *
 * After each turn, asks: "Did anything here matter?" If yes, indexes the
 * extracted memories into the brain's knowledge graph at confidence 1.0
 * with standard decay. No separate step. No cold reset. No re-explaining.
 *
 * This is the "effortless" part of the three-tier architecture:
 *   TIER 1 — Sliding window (exact recent turns)
 *   TIER 2 — Semantic compression pool (retrieved per query)
 *   TIER 3 — Heavily compressed knowledge (memories extracted here)
 *
 * Integration:
 *   punkEngine calls extractMemories() after each processEnded event.
 *   Fire-and-forget — never blocks the response path.
 */

// ── Filter thresholds ────────────────────────────────────────────────────
// Minimum length for a memory to be worth storing (avoids noise)
const MIN_MEMORY_LENGTH = 30;
// Maximum length — truncate to avoid embedding token waste
const MAX_MEMORY_LENGTH = 300;

/**
 * System prompt for the extraction LLM call.
 * The model is asked to evaluate the assistant's response and determine
 * if anything worth remembering happened during this turn.
 */
const EXTRACTION_PROMPT = `You are a memory extraction filter for a coding assistant. 
Given the assistant's response to a user's request, determine if anything happened 
that's worth remembering for future sessions.

A "worth remembering" event includes:
- A root cause was identified (e.g. "the bug was caused by X")
- A decision was made (e.g. "we'll use strategy X over Y")
- A pattern was discovered (e.g. "all handlers follow this structure")
- A tool preference emerged (e.g. "always use bun instead of npm")
- A lesson was learned (e.g. "setting Z breaks feature X")
- An error fix revealed non-obvious behavior

NOT worth remembering:
- Routine implementation details
- Code that was written as expected
- Simple yes/no confirmations
- General conversation

Return ONLY a JSON object with this exact format:
{"worthRemembering": true/false, "memories": [{"type": "decision|lesson|pattern|error_fix", "content": "concise factual statement under 200 chars"}]}

If nothing is worth remembering, return {"worthRemembering": false, "memories": []}.`;

/**
 * Extract memories from a completed turn's assistant messages.
 *
 * @param {Function} quickCall - Function(systemPrompt, userPrompt) => string
 * @param {Array} turnMessages - The assistant messages from this turn
 * @param {string} userPrompt - The user's message that started this turn
 * @returns {Promise<{ worthRemembering: boolean, memories: Array<{ type: string, content: string }> }>}
 */
export async function extractMemories(quickCall, turnMessages, userPrompt) {
  if (!quickCall || !turnMessages?.length) {
    return { worthRemembering: false, memories: [] };
  }

  // Build the assistant response text from all assistant messages in the turn
  const assistantText = turnMessages
    .filter(m => m.role === "assistant" && m.content)
    .map(m => {
      if (typeof m.content === "string") return m.content;
      if (Array.isArray(m.content)) {
        return m.content
          .filter(b => b.type === "text")
          .map(b => b.text)
          .join("\n");
      }
      return "";
    })
    .filter(Boolean)
    .join("\n\n")
    .slice(-4000); // Keep last 4000 chars to avoid token waste

  if (!assistantText || assistantText.length < 50) {
    // Too short to contain meaningful context
    return { worthRemembering: false, memories: [] };
  }

  const userMessage = `User request: ${(userPrompt || "").slice(0, 500)}\n\nAssistant response:\n${assistantText}`;

  try {
    const result = await quickCall(EXTRACTION_PROMPT, userMessage);
    if (!result) return { worthRemembering: false, memories: [] };

    const parsed = JSON.parse(result.trim());
    if (!parsed.worthRemembering || !parsed.memories?.length) {
      return { worthRemembering: false, memories: [] };
    }

    // Validate and clean memories
    const validTypes = new Set(["decision", "lesson", "pattern", "error_fix"]);
    const cleanMemories = parsed.memories
      .filter(m => validTypes.has(m.type) && m.content && m.content.length >= MIN_MEMORY_LENGTH)
      .map(m => ({
        type: m.type,
        content: m.content.length > MAX_MEMORY_LENGTH
          ? m.content.slice(0, MAX_MEMORY_LENGTH - 3) + "..."
          : m.content,
      }));

    return {
      worthRemembering: cleanMemories.length > 0,
      memories: cleanMemories,
    };
  } catch (err) {
    // Extraction failures are non-critical
    console.warn(`[memory-extractor] extraction failed: ${err.message}`);
    return { worthRemembering: false, memories: [] };
  }
}

/**
 * Fire-and-forget memory extraction.
 * Call this after a turn completes. Results are indexed into the brain
 * knowledge graph if anything worth remembering was found.
 *
 * @param {string} projectId
 * @param {Function} quickCall - System prompt -> text function
 * @param {Function} brainIndexer - (projectId, events) => Promise
 * @param {Array} turnMessages - The assistant messages from this turn
 * @param {string} userPrompt - The user's message
 */
export async function extractAndIndex(projectId, quickCall, brainIndexer, turnMessages, userPrompt) {
  const { worthRemembering, memories } = await extractMemories(quickCall, turnMessages, userPrompt);
  if (worthRemembering && memories.length > 0 && brainIndexer) {
    try {
      await brainIndexer(projectId, memories);
      console.log(`[memory-extractor] indexed ${memories.length} memory/ies for ${projectId}`);
    } catch (err) {
      console.warn(`[memory-extractor] index failed: ${err.message}`);
    }
  }
}
