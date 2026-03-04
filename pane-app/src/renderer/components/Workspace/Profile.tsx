import { useEffect, useState, useRef, useCallback } from "react";
import { useWorkspaceStore } from "../../stores/workspace";
import {
  brainUpdateIdentity,
  brainSaveAvatar,
  brainGetProfile,
  brainUpdateRules,
  brainUpdatePhilosophy,
} from "../../lib/tauri-commands";
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

// --- Shared UI ---

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <span
      className="text-pane-text-secondary font-mono uppercase tracking-wider"
      style={{ fontSize: "var(--pane-font-size-xs)" }}
    >
      {children}
    </span>
  );
}

function SettingRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between py-3">
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

// --- Keybindings ---

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
  return (
    <div className="flex items-center justify-between py-2">
      <span
        className="text-pane-text-secondary font-mono"
        style={{ fontSize: "var(--pane-font-size-xs)" }}
      >
        {getActionLabel(actionId)}
      </span>
      <div className="flex items-center gap-1.5">
        {message && (
          <span className="text-pane-error font-mono" style={{ fontSize: "var(--pane-font-size-xs)" }}>
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

  useEffect(() => {
    if (recordingAction === null) return;
    const handler = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (isModifierOnly(e)) return;
      if (e.key === "Escape") { setRecordingAction(null); return; }
      const binding = eventToBinding(e);
      if (isReserved(binding)) { showMessage(recordingAction, "reserved"); return; }
      const conflict = findConflict(binding, resolved, recordingAction);
      if (conflict) {
        useWorkspaceStore.getState().resetKeybinding(conflict);
        showMessage(recordingAction, `unbound ${getActionLabel(conflict)}`);
      }
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

  useEffect(() => {
    if (recordingAction === null) return;
    const handler = () => setRecordingAction(null);
    window.addEventListener("mousedown", handler);
    return () => window.removeEventListener("mousedown", handler);
  }, [recordingAction]);

  return (
    <div>
      <button
        className="flex items-center justify-between w-full group py-1"
        onClick={() => setExpanded((v) => !v)}
      >
        <SectionLabel>shortcuts</SectionLabel>
        <svg
          width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor"
          strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"
          className={`text-pane-text-secondary group-hover:text-pane-text transition-transform ${expanded ? "rotate-180" : ""}`}
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
                className="text-pane-text-secondary hover:text-pane-text font-mono"
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
                  onStartRecording={() => { setMessage(null); setRecordingAction(def.id); }}
                  onReset={() => useWorkspaceStore.getState().resetKeybinding(def.id)}
                  message={message?.action === def.id ? message.text : null}
                />
              );
            })}
          </div>
          <div className="mt-3 pt-2 border-t border-pane-border/30">
            <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
              {([
                [`${mod}1-9`, "switch project"],
                ["Enter", "send message"],
                ["\u21E7Enter", "newline"],
                ["Esc", "cancel / close"],
              ] as const).map(([key, action]) => (
                <div key={key} className="contents">
                  <span className="text-pane-text-secondary font-mono text-right" style={{ fontSize: "var(--pane-font-size-xs)" }}>
                    {key}
                  </span>
                  <span className="text-pane-text-secondary font-mono" style={{ fontSize: "var(--pane-font-size-xs)" }}>
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

// --- Main Profile View ---

export function Profile() {
  const profileName = useWorkspaceStore((s) => s.profileName);
  const profileBio = useWorkspaceStore((s) => s.profileBio);
  const profileRole = useWorkspaceStore((s) => s.profileRole);
  const avatarDataUrl = useWorkspaceStore((s) => s.profileAvatarDataUrl);
  const theme = useWorkspaceStore((s) => s.theme);
  const fontSize = useWorkspaceStore((s) => s.fontSize);
  const panelFontSize = useWorkspaceStore((s) => s.panelFontSize);
  const editorFontSize = useWorkspaceStore((s) => s.editorFontSize);
  const fontWeight = useWorkspaceStore((s) => s.fontWeight);
  const setTheme = useWorkspaceStore((s) => s.setTheme);
  const completionSound = useWorkspaceStore((s) => s.completionSound);
  const setCompletionSound = useWorkspaceStore((s) => s.setCompletionSound);
  const playCompletionSound = useWorkspaceStore((s) => s.playCompletionSound);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const identitySaveRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Philosophy & rules state
  const [philosophy, setPhilosophy] = useState("");
  const [rules, setRules] = useState("");
  const philosophySaveRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Load philosophy + rules from brain on mount
  useEffect(() => {
    brainGetProfile().then(({ profile }) => {
      if (profile) {
        setPhilosophy(profile.philosophy || "");
        setRules(profile.rules || "");
      }
    }).catch(() => {});
  }, []);

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        useWorkspaceStore.getState().closeProfile();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  // Debounced identity save
  const saveIdentity = useCallback((field: string, value: string) => {
    if (identitySaveRef.current) clearTimeout(identitySaveRef.current);
    identitySaveRef.current = setTimeout(() => {
      brainUpdateIdentity({ [field]: value }).catch(() => {});
    }, 500);
  }, []);

  const handleAvatarClick = useCallback(() => fileInputRef.current?.click(), []);

  const handleAvatarChange = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async () => {
      const dataUrl = reader.result as string;
      useWorkspaceStore.getState().setProfileAvatarDataUrl(dataUrl);
      const base64Data = dataUrl.split(",")[1]!;
      await brainSaveAvatar(base64Data, file.type).catch(() => {});
    };
    reader.readAsDataURL(file);
    e.target.value = "";
  }, []);

  const handlePhilosophyChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setPhilosophy(e.target.value);
    if (philosophySaveRef.current) clearTimeout(philosophySaveRef.current);
    philosophySaveRef.current = setTimeout(() => {
      brainUpdatePhilosophy(e.target.value).catch(() => {});
    }, 800);
  }, []);

  const handleRulesChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setRules(e.target.value);
    if (philosophySaveRef.current) clearTimeout(philosophySaveRef.current);
    philosophySaveRef.current = setTimeout(() => {
      brainUpdateRules(e.target.value).catch(() => {});
    }, 800);
  }, []);

  const initials = profileName
    ? profileName.split(" ").map(w => w[0]).join("").toUpperCase().slice(0, 2)
    : "";

  return (
    <div className="h-full overflow-y-auto px-10 pt-8 pb-48">
      <div className="max-w-md mx-auto">
        {/* Avatar + Identity */}
        <div className="flex flex-col items-center gap-3 mb-10">
          <button
            onClick={handleAvatarClick}
            className="relative w-20 h-20 rounded-full overflow-hidden bg-pane-bg ring-1 ring-pane-border/40 hover:ring-pane-text/20 transition-shadow group"
            title="Change photo"
          >
            {avatarDataUrl ? (
              <img src={avatarDataUrl} alt="" className="w-full h-full object-cover" />
            ) : (
              <div className="w-full h-full flex items-center justify-center">
                {initials ? (
                  <span className="font-mono text-pane-text text-lg font-medium">{initials}</span>
                ) : (
                  <svg width="28" height="28" viewBox="0 0 28 28" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" className="text-pane-text-secondary/40">
                    <circle cx="14" cy="11" r="5" />
                    <path d="M4 26c0-5.523 4.477-10 10-10s10 4.477 10 10" />
                  </svg>
                )}
              </div>
            )}
            <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="white" strokeWidth="1.5" strokeLinecap="round">
                <circle cx="8" cy="8" r="2.5" />
                <path d="M2.5 6.5V5a1.5 1.5 0 011.5-1.5h1.5M12 3.5h1.5A1.5 1.5 0 0115 5v1.5M13.5 11v1.5a1.5 1.5 0 01-1.5 1.5h-1.5M4 14H2.5A1.5 1.5 0 011 12.5V11" />
              </svg>
            </div>
          </button>
          <input ref={fileInputRef} type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={handleAvatarChange} />

          <input
            type="text"
            value={profileName}
            onChange={(e) => { useWorkspaceStore.getState().setProfileName(e.target.value); saveIdentity("name", e.target.value); }}
            placeholder="your name"
            className="w-full text-center font-mono text-pane-text bg-transparent outline-none text-lg placeholder:text-pane-text-secondary/30"
          />
          <input
            type="text"
            value={profileRole}
            onChange={(e) => { useWorkspaceStore.getState().setProfileRole(e.target.value); saveIdentity("role", e.target.value); }}
            placeholder="role"
            className="w-full text-center font-mono text-pane-text-secondary bg-transparent outline-none placeholder:text-pane-text-secondary/30"
            style={{ fontSize: "var(--pane-font-size-sm)" }}
          />
          <textarea
            value={profileBio}
            onChange={(e) => { useWorkspaceStore.getState().setProfileBio(e.target.value); saveIdentity("bio", e.target.value); }}
            placeholder="about you"
            rows={2}
            className="w-full text-center font-mono text-pane-text-secondary bg-transparent outline-none resize-none placeholder:text-pane-text-secondary/30"
            style={{ fontSize: "var(--pane-font-size-sm)" }}
          />
        </div>

        {/* Philosophy */}
        <div className="mb-6">
          <div className="mb-2"><SectionLabel>philosophy</SectionLabel></div>
          <div className="bg-pane-bg rounded-2xl ring-1 ring-pane-border/40 overflow-hidden">
            <textarea
              value={philosophy}
              onChange={handlePhilosophyChange}
              placeholder="your design principles..."
              rows={3}
              className="w-full font-mono text-pane-text bg-transparent px-5 pt-4 pb-3 outline-none resize-none placeholder:text-pane-text-secondary/30 leading-[1.75]"
              style={{ fontSize: "var(--pane-font-size-sm)" }}
            />
          </div>
        </div>

        {/* Rules */}
        <div className="mb-6">
          <div className="mb-2"><SectionLabel>rules</SectionLabel></div>
          <div className="bg-pane-bg rounded-2xl ring-1 ring-pane-border/40 overflow-hidden">
            <textarea
              value={rules}
              onChange={handleRulesChange}
              placeholder={"always use bun\nnever auto-commit\nprefer functional over class"}
              rows={3}
              className="w-full font-mono text-pane-text bg-transparent px-5 pt-4 pb-3 outline-none resize-none placeholder:text-pane-text-secondary/30 leading-[1.75]"
              style={{ fontSize: "var(--pane-font-size-sm)" }}
            />
          </div>
          <span
            className="text-pane-text-secondary font-mono mt-1.5 block px-1"
            style={{ fontSize: "var(--pane-font-size-xs)" }}
          >
            one per line — these override observed preferences
          </span>
        </div>

        {/* Appearance */}
        <div className="mb-6">
          <div className="mb-2"><SectionLabel>appearance</SectionLabel></div>
          <div className="bg-pane-bg rounded-2xl ring-1 ring-pane-border/40 px-5 divide-y divide-pane-border/30">
            <SettingRow label="theme">
              <div className="flex gap-1">
                {(["system", "dark", "light", "pure"] as const).map((t) => (
                  <button
                    key={t}
                    onClick={() => setTheme(t)}
                    className={`px-3 py-1 rounded-xl font-mono
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

            <SettingRow label="chat font">
              <FontSizeControl
                value={fontSize}
                onIncrease={() => useWorkspaceStore.getState().increaseFontSize()}
                onDecrease={() => useWorkspaceStore.getState().decreaseFontSize()}
                onReset={() => useWorkspaceStore.getState().resetFontSize()}
              />
            </SettingRow>

            <SettingRow label="editor font">
              <FontSizeControl
                value={editorFontSize}
                onIncrease={() => useWorkspaceStore.getState().increaseEditorFontSize()}
                onDecrease={() => useWorkspaceStore.getState().decreaseEditorFontSize()}
                onReset={() => useWorkspaceStore.getState().resetEditorFontSize()}
              />
            </SettingRow>

            <SettingRow label="panel font">
              <FontSizeControl
                value={panelFontSize}
                onIncrease={() => useWorkspaceStore.getState().increasePanelFontSize()}
                onDecrease={() => useWorkspaceStore.getState().decreasePanelFontSize()}
                onReset={() => useWorkspaceStore.getState().resetPanelFontSize()}
              />
            </SettingRow>

            <SettingRow label="weight">
              <FontSizeControl
                value={fontWeight}
                onIncrease={() => useWorkspaceStore.getState().increaseFontWeight()}
                onDecrease={() => useWorkspaceStore.getState().decreaseFontWeight()}
                onReset={() => useWorkspaceStore.getState().resetFontWeight()}
                unit=""
              />
            </SettingRow>

            <SettingRow label="sound">
              <div className="flex gap-1">
                <select
                  value={completionSound}
                  onChange={(e) => setCompletionSound(e.target.value)}
                  className="px-3 py-1 rounded-xl font-mono bg-transparent text-pane-text outline-none"
                  style={{ fontSize: "var(--pane-font-size-sm)" }}
                >
                  <option value="none">none</option>
                  <option value="Basso">basso</option>
                  <option value="Blow">blow</option>
                  <option value="Bottle">bottle</option>
                  <option value="Frog">frog</option>
                  <option value="Funk">funk</option>
                  <option value="Glass">glass</option>
                  <option value="Hero">hero</option>
                  <option value="Morse">morse</option>
                  <option value="Ping">ping</option>
                  <option value="Pop">pop</option>
                  <option value="Purr">purr</option>
                  <option value="Sosumi">sosumi</option>
                  <option value="Submarine">submarine</option>
                  <option value="Tink">tink</option>
                </select>
                <button
                  onClick={playCompletionSound}
                  disabled={completionSound === "none"}
                  className="px-3 py-1 rounded-xl font-mono text-pane-text-secondary hover:text-pane-text hover:bg-pane-text/[0.04] disabled:opacity-30 disabled:cursor-default"
                  style={{ fontSize: "var(--pane-font-size-sm)" }}
                  title="Test sound"
                >
                  ▶
                </button>
              </div>
            </SettingRow>
          </div>
        </div>

        {/* Shortcuts */}
        <div className="mb-6">
          <KeybindingsSection />
        </div>
      </div>
    </div>
  );
}
