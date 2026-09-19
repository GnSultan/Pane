// Declaration for the electronAPI exposed via contextBridge in preload script
export interface ElectronAPI {
  invoke: <T = unknown>(channel: string, ...args: unknown[]) => Promise<T>;
  send: (channel: string, ...args: unknown[]) => void;
  on: <T = unknown>(channel: string, callback: (data: T) => void) => () => void;
  removeAllListeners: (channel: string) => void;
  /** Resolve an absolute filesystem path from a dropped File object. */
  getPathForFile: (file: File) => string;
}

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}