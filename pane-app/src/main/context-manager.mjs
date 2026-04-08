/**
 * Context Manager - Automatic conversation context compaction
 *
 * Manages conversation context by automatically compressing/summarizing
 * older message history when context pressure is high, preserving critical
 * context while freeing up tokens for continuation.
 */

import { getContextLimit } from "./pane-system-prompt.mjs";

// Context compaction thresholds
const COMPACTION_THRESHOLDS = {
  building: 0.7,  // 70% - Start considering compaction
  high: 0.85,     // 85% - Auto-compaction triggered
  critical: 0.95, // 95% - Aggressive compaction
};

// Critical context markers that should always be preserved
const CRITICAL_CONTEXT_MARKERS = [
  "commit:",
  "task:",
  "TODO:",
  "FIXME:",
  "TODOs:",
  "decisions:",
  "applying changes",
  "modifying",
  "fixing",
  "implementing",
  "updating",
];

// Sentences that indicate critical context
const CRITICAL_SENTENCE_STARTS = [
  "I'll",
  "Let me",
  "Now I need to",
  "Next, I'll",
  "After that",
  "This means",
  "Therefore",
  "Consequently",
];

// Threshold for preserving exact message vs summarizing
const MINIMUM_MESSAGES_TO_KEEP = 5;
const MINIMUM_TURN_COUNT = 3;

export class ContextManager {
  constructor() {
    this.conversationHistory = [];
    this.compactionState = {
      isCompacting: false,
      lastCompactionAt: null,
      totalCompactions: 0,
      tokensSaved: 0,
    };
  }

  /**
   * Analyze conversation and determine if compaction is needed
   */
  analyzeContextPressure(conversation, model) {
    const totalTokens = this.estimateTokenCount(conversation);
    const limit = getContextLimit(model);
    const usagePercent = totalTokens / limit;

    // Determine pressure level
    let pressure = "none";
    if (usagePercent >= COMPACTION_THRESHOLDS.critical) {
      pressure = "critical";
    } else if (usagePercent >= COMPACTION_THRESHOLDS.high) {
      pressure = "high";
    } else if (usagePercent >= COMPACTION_THRESHOLDS.building) {
      pressure = "building";
    }

    return {
      pressure,
      usagePercent,
      totalTokens,
      limit,
      needsCompaction: pressure === "high" || pressure === "critical",
      recommendedStrategy: this.getCompactionStrategy(pressure, conversation.length),
    };
  }

  /**
   * Get compaction strategy based on pressure and conversation length
   */
  getCompactionStrategy(pressure, turnCount) {
    if (turnCount < MINIMUM_TURN_COUNT * 2) {
      return "none";
    }

    switch (pressure) {
      case "critical":
        return "aggressive";
      case "high":
        return "moderate";
      case "building":
        return "conservative";
      default:
        return "none";
    }
  }

  /**
   * Compact conversation by summarizing older turns while preserving critical context
   */
  async compactConversation(conversation, model, strategy = "moderate") {
    if (conversation.length < MINIMUM_TURN_COUNT * 2) {
      return conversation; // Too short to compact
    }

    this.compactionState.isCompacting = true;
    this.compactionState.lastCompactionAt = Date.now();

    try {
      const result = await this.applyCompactionStrategy(conversation, strategy);
      this.compactionState.totalCompactions++;
      this.compactionState.tokensSaved += result.tokensSaved;

      console.log(
        `[context-manager] Compacted ${conversation.length} turns → ${result.compacted.length} turns ` +
        `(saved ~${result.tokensSaved} tokens, strategy: ${strategy})`
      );

      return result.compacted;
    } catch (error) {
      console.error("[context-manager] Compaction failed:", error);
      return conversation; // Return original on failure
    } finally {
      this.compactionState.isCompacting = false;
    }
  }

  /**
   * Apply different compaction strategies based on aggressiveness
   */
  async applyCompactionStrategy(conversation, strategy) {
    switch (strategy) {
      case "aggressive":
        return this.compactAggressive(conversation);
      case "moderate":
        return this.compactModerate(conversation);
      case "conservative":
        return this.compactConservative(conversation);
      default:
        return {
          compacted: conversation,
          tokensSaved: 0,
        };
    }
  }

  /**
   * Conservative: Keep most recent, summarize older
   */
  compactConservative(conversation) {
    const recentCount = Math.min(conversation.length, 8); // Keep last 8 turns
    const olderTurns = conversation.slice(0, conversation.length - recentCount);

    if (olderTurns.length === 0) {
      return { compacted: conversation, tokensSaved: 0 };
    }

    const summary = this.createConversationSummary(olderTurns, "high-level");
    const compacted = [
      ...this.preserveCriticalMessages(summary),
      ...conversation.slice(-recentCount),
    ];

    const tokensSaved = this.estimateTokenCount(olderTurns) - this.estimateTokenCount(summary);
    return { compacted, tokensSaved };
  }

  /**
   * Moderate: Keep last 5, summarize middle, summarize older
   */
  compactModerate(conversation) {
    if (conversation.length < 6) {
      return { compacted: conversation, tokensSaved: 0 };
    }

    const recentCount = 5;
    const middleCount = 3;
    const recent = conversation.slice(-recentCount);
    const middle = conversation.slice(-recentCount - middleCount, -recentCount);
    const older = conversation.slice(0, -recentCount - middleCount);

    const compacted = [];

    // Summarize older if exists
    if (older.length > 0) {
      const summary = this.createConversationSummary(older, "detailed");
      compacted.push(...this.preserveCriticalMessages(summary));
    }

    // Summarize middle
    if (middle.length > 0) {
      const middleSummary = this.createConversationSummary(middle, "medium");
      compacted.push(...middleSummary);
    }

    // Keep recent as-is
    compacted.push(...recent);

    const tokensSaved = this.estimateTokenCount(conversation) - this.estimateTokenCount(compacted);
    return { compacted, tokensSaved };
  }

  /**
   * Aggressive: Keep only last 3, summarize everything else
   */
  compactAggressive(conversation) {
    if (conversation.length < 4) {
      return { compacted: conversation, tokensSaved: 0 };
    }

    const recentCount = 3;
    const recent = conversation.slice(-recentCount);
    const older = conversation.slice(0, -recentCount);

    const summary = this.createConversationSummary(older, "compressed");
    const compacted = [
      ...this.preserveCriticalMessages(summary),
      ...recent,
    ];

    const tokensSaved = this.estimateTokenCount(older) - this.estimateTokenCount(summary);
    return { compacted, tokensSaved };
  }

  /**
   * Create a conversation summary with different levels of detail
   */
  createConversationSummary(turns, detailLevel = "medium") {
    // Extract key information from turns
    const keyTopics = this.extractKeyTopics(turns);
    const decisions = this.extractDecisions(turns);
    const actions = this.extractActions(turns);
    const context = this.extractContext(turns);

    // Build summary based on detail level
    let summaryContent = "";

    switch (detailLevel) {
      case "high-level":
        summaryContent = `Earlier conversation context:
- Key topics: ${keyTopics.join(", ") || "general discussion"}
- Previous decisions: ${decisions.length > 0 ? decisions.join("; ") : "none"}
- Recent actions: ${actions.slice(0, 3).join(", ") || "none"}
- Current context: ${context || "active work in progress"}`;
        break;

      case "medium":
        summaryContent = `Previous conversation summary:
- Topics discussed: ${keyTopics.join(", ")}
- Decisions made: ${decisions.length > 0 ? decisions.join("; ") : "none"}
- Actions taken: ${actions.join("; ") || "none"}
- Current focus: ${context || "ongoing task"}`;
        break;

      case "detailed":
        summaryContent = `Comprehensive conversation history:
Topics: ${keyTopics.join(", ")}
Decisions: ${decisions.length > 0 ? decisions.join("; ") : "none"}
Actions: ${actions.join("; ")}
Context: ${context}`;
        break;

      case "compressed":
      default:
        summaryContent = `Summary: ${keyTopics.join(", ")}. Decisions: ${decisions.join("; ") || "none"}. Current: ${context || "active task"}`;
        break;
    }

    // Create system message with the summary
    return [{
      role: "system",
      content: `[Context Summary: Previous ${turns.length} turns]\n${summaryContent}`,
    }];
  }

  /**
   * Extract key topics from conversation
   */
  extractKeyTopics(turns) {
    const topics = new Set();

    for (const turn of turns) {
      if (turn.role === "user") {
        const content = typeof turn.content === "string" ? turn.content : "";
        // Look for topic indicators
        const matches = content.match(/(?:doing|working on|building|implementing|fixing|testing)\s+([^.]+)/gi);
        if (matches) {
          matches.forEach(m => topics.add(m.replace(/(?:doing|working on|building|implementing|fixing|testing)\s+/i, "").trim()));
        }
      }
    }

    return Array.from(topics).slice(0, 5); // Limit to 5 topics
  }

  /**
   * Extract decisions made in conversation
   */
  extractDecisions(turns) {
    const decisions = [];

    for (const turn of turns) {
      if (turn.role === "assistant") {
        const content = typeof turn.content === "string" ? turn.content : "";
        // Look for decision indicators
        const patterns = [
          /I'?ll\s+(\w+)/gi,
          /decided?\s+to\s+(\w+)/gi,
          /let me\s+(\w+)/gi,
          /now\s+I\s+(\w+)/gi,
        ];

        patterns.forEach(pattern => {
          const matches = content.match(pattern);
          if (matches) {
            matches.forEach(m => decisions.push(m.substring(0, 50)));
          }
        });
      }
    }

    return decisions.slice(0, 3); // Limit to 3 decisions
  }

  /**
   * Extract actions taken in conversation
   */
  extractActions(turns) {
    const actions = [];

    for (const turn of turns) {
      const content = typeof turn.content === "string" ? turn.content : "";
      // Look for action verbs
      const matches = content.match(/\b(?:fixed|added|created|updated|removed|implemented|refactored|cleaned)\b/gi);
      if (matches) {
        actions.push(...matches);
      }
    }

    return Array.from(new Set(actions)).slice(0, 5); // Limit to 5 unique actions
  }

  /**
   * Extract current context/focus
   */
  extractContext(turns) {
    // Get the last user message that indicates current focus
    const lastUserMessages = turns.filter(t => t.role === "user").slice(-2);
    if (lastUserMessages.length > 0) {
      const content = typeof lastUserMessages[lastUserMessages.length - 1].content === "string"
        ? lastUserMessages[lastUserMessages.length - 1].content
        : "";
      const short = content.substring(0, 100);
      return content.length > 100 ? short + "..." : short;
    }
    return "ongoing work";
  }

  /**
   * Preserve critical messages that should never be summarized
   */
  preserveCriticalMessages(summary) {
    return summary.map(msg => {
      // Add marker to indicate this is a summary
      if (msg.role === "system" && typeof msg.content === "string") {
        return {
          ...msg,
          content: `[CONTEXT SUMMARY]\n${msg.content}`,
        };
      }
      return msg;
    });
  }

  /**
   * Estimate token count for messages (simplified)
   */
  estimateTokenCount(messages) {
    let total = 0;
    for (const msg of messages) {
      const content = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
      // Rough estimate: 1 token ≈ 4 characters + some overhead
      total += Math.ceil(content.length / 4) + 5; // +5 for role overhead
    }
    return total;
  }

  /**
   * Check if conversation should be auto-compacted based on current state
   */
  shouldAutoCompact(conversation, model, force = false) {
    const analysis = this.analyzeContextPressure(conversation, model);

    if (force) {
      return {
        shouldCompact: true,
        reason: "force",
        strategy: this.getCompactionStrategy(analysis.pressure, conversation.length),
      };
    }

    // Auto-compact only on "high" or "critical" pressure
    if (analysis.pressure === "high" || analysis.pressure === "critical") {
      return {
        shouldCompact: true,
        reason: `context ${Math.round(analysis.usagePercent * 100)}%`,
        strategy: this.getCompactionStrategy(analysis.pressure, conversation.length),
      };
    }

    return {
      shouldCompact: false,
      reason: `context ${Math.round(analysis.usagePercent * 100)}%`,
      strategy: "none",
    };
  }

  /**
   * Get current compaction stats
   */
  getStats() {
    return {
      ...this.compactionState,
      totalCompactions: this.compactionState.totalCompactions,
      tokensSaved: this.compactionState.tokensSaved,
    };
  }

  /**
   * Reset compaction state
   */
  reset() {
    this.conversationHistory = [];
    this.compactionState = {
      isCompacting: false,
      lastCompactionAt: null,
      totalCompactions: 0,
      tokensSaved: 0,
    };
  }
}

// Export singleton instance
const contextManager = new ContextManager();
export default contextManager;