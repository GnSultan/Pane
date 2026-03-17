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

  async spawn(_request) {
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
