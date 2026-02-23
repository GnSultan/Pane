import { useWorkspaceStore } from "../../stores/workspace";

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
}: {
  value: number;
  onIncrease: () => void;
  onDecrease: () => void;
  onReset: () => void;
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
        className="w-10 h-7 flex items-center justify-center rounded
          text-pane-text font-mono hover:bg-pane-text/[0.04]"
        style={{ fontSize: "var(--pane-font-size-sm)" }}
        title="Reset to default"
      >
        {value}px
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

interface SettingsProps {
  onClose: () => void;
}

export function Settings({ onClose }: SettingsProps) {
  const theme = useWorkspaceStore((s) => s.theme);
  const fontSize = useWorkspaceStore((s) => s.fontSize);
  const panelFontSize = useWorkspaceStore((s) => s.panelFontSize);
  const setTheme = useWorkspaceStore((s) => s.setTheme);

  const themeLabel = theme;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      onClick={onClose}
    >
      <div className="absolute inset-0 bg-pane-bg/80 backdrop-blur-sm" />
      <div
        className="relative bg-pane-surface border border-pane-border rounded-lg
          w-full max-w-md mx-4 overflow-hidden"
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

          <SettingRow label="editor font size">
            <FontSizeControl
              value={fontSize}
              onIncrease={() => useWorkspaceStore.getState().increaseFontSize()}
              onDecrease={() => useWorkspaceStore.getState().decreaseFontSize()}
              onReset={() => useWorkspaceStore.getState().resetFontSize()}
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
        </div>

        {/* Footer */}
        <div className="px-6 py-3 border-t border-pane-border/50">
          <p className="text-pane-text-secondary/40 font-mono" style={{ fontSize: "var(--pane-font-size-xs)" }}>
            {themeLabel} theme &middot; editor {fontSize}px &middot; panel {panelFontSize}px
          </p>
        </div>
      </div>
    </div>
  );
}
