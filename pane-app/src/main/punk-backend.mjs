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
   * Legacy: CLI backends have been removed. Session resume is not supported.
   */
  get supportsSessionResume() { return false; }

  async spawn() {
    throw new Error("Not implemented");
  }

  /** Lightweight text-only call (no tools). Override in backends that support it. */
  async planningCall() {
    throw new Error("Not implemented");
  }

  async abort() {
    throw new Error("Not implemented");
  }

  async terminate() {
    throw new Error("Not implemented");
  }

  async shutdown() {
    throw new Error("Not implemented");
  }
}
