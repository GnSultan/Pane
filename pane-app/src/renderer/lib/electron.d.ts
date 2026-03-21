// Declaration for the electronAPI exposed via contextBridge in preload script
export interface ElectronAPI {
  invoke: <T = unknown>(channel: string, ...args: any[]) => Promise<T>;
  on: (channel: string, callback: (...args: any[]) => void) => () => void;
  removeAllListeners: (channel: string) => void;
}

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}