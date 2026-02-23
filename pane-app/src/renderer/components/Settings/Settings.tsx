import { useEffect, useState, useRef, useCallback } from "react";
import { useWorkspaceStore } from "../../stores/workspace";
import {
  ACTION_DEFINITIONS,
  DEFAULT_BINDINGS,
  resolveBindings,
  formatBinding,
  eventToBinding,
  isModifierOnly,
  isReserved,
  findConflict,
  bindingsEqual,
  getActionLabel,
  type ActionId,
  type KeyBinding,
} from "../../lib/keybindings";

const isMac = navigator.platform.includes("Mac");
const mod = isMac ? "\u2318" : "Ctrl";

function SettingRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between py-3 border-b border-pane-border/50">
      <span className="text-pane-text font-mono" style={{ fontSize: "var(--pane-font-size-sm)" }}>
        {label}
      </span>
      <div className="flex items-center gap-2">
        {children}
      </div>
    </div>
  );
}

function FontSizeControl({
  value,
  onIncrease,
  onDecrease,
  onReset,
  unit = "px",
}: {
  value: number;
  onIncrease: () => void;
  onDecrease: () => void;
  onReset: () => void;
  unit?: string;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <button
        onClick={onDecrease}
        className="w-7 h-7 flex items-center justify-center rounded
          text-pane-text-secondary hover:text-pane-text hover:bg-pane-text/[0.06] font-mono"
        style={{ fontSize: "var(--pane-font-size)" }}
      >
        -
      </button>
      <button
        onClick={onReset}
        className="min-w-10 h-7 flex items-center justify-center rounded px-1
          text-pane-text font-mono hover:bg-pane-text/[0.04]"
        style={{ fontSize: "var(--pane-font-size-sm)" }}
        title="Reset to default"
      >
        {value}{unit}
      </button>
      <button
        onClick={onIncrease}
        className="w-7 h-7 flex items-center justify-center rounded
          text-pane-text-secondary hover:text-pane-text hover:bg-pane-text/[0.06] font-mono"
        style={{ fontSize: "var(--pane-font-size)" }}
      >
        +
      </button>
    </div>
  );
}

// --- Keybinding rebinding UI ---

function KeybindingRow({
  actionId,
  binding,
  isDefault,
  isRecording,
  onStartRecording,
  onReset,
  message,
}: {
  actionId: ActionId;
  binding: KeyBinding;
  isDefault: boolean;
  isRecording: boolean;
  onStartRecording: () => void;
  onReset: () => void;
  message: string | null;
}) {
  const label = getActionLabel(actionId);

  return (
    <div className="flex items-center justify-between py-2">
      <span
        className="text-pane-text-secondary/70 font-mono"
        style={{ fontSize: "var(--pane-font-size-xs)" }}
      >
        {label}
      </span>
      <div className="flex items-center gap-1.5">
        {message && (
          <span
            className="text-pane-error font-mono"
            style={{ fontSize: "var(--pane-font-size-xs)" }}
          >
            {message}
          </span>
        )}
        <button
          onClick={onStartRecording}
          className={`px-2.5 py-1 rounded font-mono ${
            isRecording
              ? "bg-pane-text/[0.12] text-pane-text ring-1 ring-pane-text/30"
              : "bg-pane-text/[0.06] text-pane-text-secondary hover:text-pane-text"
          }`}
          style={{ fontSize: "var(--pane-font-size-xs)" }}
        >
          {isRecording ? "press keys..." : formatBinding(binding)}
        </button>
        {!isDefault && !isRecording && (
          <button
            onClick={onReset}
            className="text-pane-text-secondary/40 hover:text-pane-text-secondary"
            title="Reset to default"
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
              <path d="M2.5 2.5L6 6m0 0l3.5 3.5M6 6l3.5-3.5M6 6L2.5 9.5" />
            </svg>
          </button>
        )}
      </div>
    </div>
  );
}

function KeybindingsSection() {
  const keybindingsOverrides = useWorkspaceStore((s) => s.keybindings);
  const resolved = resolveBindings(keybindingsOverrides);
  const hasOverrides = keybindingsOverrides !== null && Object.keys(keybindingsOverrides).length > 0;

  const [expanded, setExpanded] = useState(false);
  const [recordingAction, setRecordingAction] = useState<ActionId | null>(null);
  const [message, setMessage] = useState<{ action: ActionId; text: string } | null>(null);
  const messageTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showMessage = useCallback((action: ActionId, text: string) => {
    if (messageTimerRef.current) clearTimeout(messageTimerRef.current);
    setMessage({ action, text });
    messageTimerRef.current = setTimeout(() => setMessage(null), 2000);
  }, []);

  // Capture-phase keydown listener for recording
  useEffect(() => {
    if (recordingAction === null) return;

    const handler = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopImmediatePropagation();

      if (isModifierOnly(e)) return;

      if (e.key === "Escape") {
        setRecordingAction(null);
        return;
      }

      const binding = eventToBinding(e);

      if (isReserved(binding)) {
        showMessage(recordingAction, "reserved");
        return;
      }

      const conflict = findConflict(binding, resolved, recordingAction);
      if (conflict) {
        // Auto-resolve: clear the conflicting binding, apply new one
        useWorkspaceStore.getState().resetKeybinding(conflict);
        showMessage(recordingAction, `unbound ${getActionLabel(conflict)}`);
      }

      // If it matches the default, remove the override instead of storing a duplicate
      const defaultBinding = DEFAULT_BINDINGS[recordingAction];
      if (bindingsEqual(binding, defaultBinding)) {
        useWorkspaceStore.getState().resetKeybinding(recordingAction);
      } else {
        useWorkspaceStore.getState().setKeybinding(recordingAction, binding);
      }

      setRecordingAction(null);
    };

    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [recordingAction, resolved, showMessage]);

  // Cancel recording on outside click
  useEffect(() => {
    if (recordingAction === null) return;
    const handler = () => setRecordingAction(null);
    window.addEventListener("mousedown", handler);
    return () => window.removeEventListener("mousedown", handler);
  }, [recordingAction]);

  return (
    <div className="px-6 py-3 border-t border-pane-border/50">
      <button
        className="flex items-center justify-between w-full group"
        onClick={() => setExpanded((v) => !v)}
      >
        <span
          className="text-pane-text-secondary/40 font-mono uppercase tracking-wider"
          style={{ fontSize: "var(--pane-font-size-xs)" }}
        >
          shortcuts
        </span>
        <svg
          width="12"
          height="12"
          viewBox="0 0 12 12"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          className={`text-pane-text-secondary/30 group-hover:text-pane-text-secondary/60 transition-transform ${
            expanded ? "rotate-180" : ""
          }`}
        >
          <path d="M3 4.5L6 7.5L9 4.5" />
        </svg>
      </button>

      {expanded && (
        <>
          {hasOverrides && (
            <div className="flex justify-end mt-1">
              <button
                onClick={() => useWorkspaceStore.getState().resetAllKeybindings()}
                className="text-pane-text-secondary/40 hover:text-pane-text-secondary font-mono"
                style={{ fontSize: "var(--pane-font-size-xs)" }}
              >
                reset all
              </button>
            </div>
          )}

          <div className="mt-2">
            {ACTION_DEFINITIONS.map((def) => {
              const isDefault = !keybindingsOverrides || !(def.id in keybindingsOverrides);
              return (
                <KeybindingRow
                  key={def.id}
                  actionId={def.id}
                  binding={resolved[def.id]}
                  isDefault={isDefault}
                  isRecording={recordingAction === def.id}
                  onStartRecording={() => {
                    setMessage(null);
                    setRecordingAction(def.id);
                  }}
                  onReset={() => useWorkspaceStore.getState().resetKeybinding(def.id)}
                  message={message?.action === def.id ? message.text : null}
                />
              );
            })}
          </div>

          {/* Non-rebindable shortcuts */}
          <div className="mt-3 pt-2 border-t border-pane-border/30">
            <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
              {([
                [`${mod}1-9`, "switch project"],
                ["Enter", "send message"],
                ["\u21E7Enter", "newline"],
                ["Esc", "cancel / close"],
              ] as const).map(([key, action]) => (
                <div key={key} className="contents">
                  <span
                    className="text-pane-text-secondary/30 font-mono text-right"
                    style={{ fontSize: "var(--pane-font-size-xs)" }}
                  >
                    {key}
                  </span>
                  <span
                    className="text-pane-text-secondary/30 font-mono"
                    style={{ fontSize: "var(--pane-font-size-xs)" }}
                  >
                    {action}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// --- Main Settings component ---

interface SettingsProps {
  onClose: () => void;
}

export function Settings({ onClose }: SettingsProps) {
  const theme = useWorkspaceStore((s) => s.theme);
  const fontSize = useWorkspaceStore((s) => s.fontSize);
  const panelFontSize = useWorkspaceStore((s) => s.panelFontSize);
  const editorFontSize = useWorkspaceStore((s) => s.editorFontSize);
  const fontWeight = useWorkspaceStore((s) => s.fontWeight);
  const setTheme = useWorkspaceStore((s) => s.setTheme);

  const themeLabel = theme;

  // Close on Escape (only if not recording a keybinding — capture handler takes priority)
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      role="presentation"
      onClick={onClose}
    >
      <div className="absolute inset-0 bg-pane-bg/80 backdrop-blur-sm" />
      <div
        className="relative bg-pane-surface border border-pane-border rounded-lg
          w-full max-w-md mx-4 max-h-[85vh] overflow-y-auto"
        role="dialog"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-pane-border">
          <span className="font-mono text-pane-text font-medium" style={{ fontSize: "var(--pane-font-size)" }}>
            settings
          </span>
          <button
            onClick={onClose}
            className="text-pane-text-secondary hover:text-pane-text"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
              <line x1="4" y1="4" x2="12" y2="12" />
              <line x1="12" y1="4" x2="4" y2="12" />
            </svg>
          </button>
        </div>

        {/* Settings content */}
        <div className="px-6 py-2">
          <SettingRow label="theme">
            <div className="flex gap-1">
              {(["system", "dark", "light", "pure"] as const).map((t) => (
                <button
                  key={t}
                  onClick={() => setTheme(t)}
                  className={`px-3 py-1 rounded font-mono
                    ${theme === t
                      ? "bg-pane-text/[0.1] text-pane-text"
                      : "text-pane-text-secondary/50 hover:text-pane-text-secondary"
                    }`}
                  style={{ fontSize: "var(--pane-font-size-sm)" }}
                >
                  {t}
                </button>
              ))}
            </div>
          </SettingRow>

          <SettingRow label="chat font size">
            <FontSizeControl
              value={fontSize}
              onIncrease={() => useWorkspaceStore.getState().increaseFontSize()}
              onDecrease={() => useWorkspaceStore.getState().decreaseFontSize()}
              onReset={() => useWorkspaceStore.getState().resetFontSize()}
            />
          </SettingRow>

          <SettingRow label="editor font size">
            <FontSizeControl
              value={editorFontSize}
              onIncrease={() => useWorkspaceStore.getState().increaseEditorFontSize()}
              onDecrease={() => useWorkspaceStore.getState().decreaseEditorFontSize()}
              onReset={() => useWorkspaceStore.getState().resetEditorFontSize()}
            />
          </SettingRow>

          <SettingRow label="panel font size">
            <FontSizeControl
              value={panelFontSize}
              onIncrease={() => useWorkspaceStore.getState().increasePanelFontSize()}
              onDecrease={() => useWorkspaceStore.getState().decreasePanelFontSize()}
              onReset={() => useWorkspaceStore.getState().resetPanelFontSize()}
            />
          </SettingRow>

          <SettingRow label="font weight">
            <FontSizeControl
              value={fontWeight}
              onIncrease={() => useWorkspaceStore.getState().increaseFontWeight()}
              onDecrease={() => useWorkspaceStore.getState().decreaseFontWeight()}
              onReset={() => useWorkspaceStore.getState().resetFontWeight()}
              unit=""
            />
          </SettingRow>
        </div>

        {/* Keyboard shortcuts — interactive rebinding */}
        <KeybindingsSection />
      </div>
    </div>
  );
}
