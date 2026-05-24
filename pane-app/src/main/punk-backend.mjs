// PunkBackend base class - extracted to avoid circular dependencies
// All backends (CLI, HTTP, future) must implement this contract.

/**
 * @callback EventCallback
 * @param {string} projectId
 * @param {PunkEvent} event
 * @returns {void}
 */

export class PunkBackend {
  /**
   * @param {EventCallback} onEvent
   */
  constructor(onEvent) {
    this.onEvent = onEvent;
  }

  /** Whether the backend supports tool calling (Plan tool, read_file, etc.). */
  get supportsToolCalling() { return false; }

  /**
   * Whether the backend supports resuming a session by ID.
   * CLI backends that use the claude-agent-sdk support this; Gemini does not.
   * Used by the planning agent to decide whether Pass 2 (session resume) is viable.
   */
  get supportsSessionResume() { return false; }

  async spawn(_request) {
    throw new Error("Not implemented");
  }

  /** Lightweight text-only call (no tools). Override in backends that support it. */
  async planningCall(_systemPrompt, _userPrompt, _request, _onChunk) {
    throw new Error("Not implemented");
  }

  async abort(_projectId) {
    throw new Error("Not implemented");
  }

  async terminate(_projectId) {
    throw new Error("Not implemented");
  }

  async shutdown() {
    throw new Error("Not implemented");
  }
}
