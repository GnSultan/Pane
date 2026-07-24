import { useEffect, useState, useCallback } from "react";
import { useLensStore, type PunkStatus, type PunkState } from "../../stores/lens";
import { useProjectsStore } from "../../stores/projects";
import { runSinglePunk, checkPreviousFindings, runReview, listPunks, createPunk, docPunkRun } from "../../lib/tauri-commands";
import type { ReviewFinding } from "../../lib/tauri-commands";

// ─── Icons ───────────────────────────────────────────────────────────────────

/** Deterministic icon for any punk name. Built-in punks get custom icons. */
function punkIcon(name: string): string {
  if (name === "ash") return "◎";
  if (name === "ghost") return "◈";
  if (name === "sage") return "○";
  const n = name.split("").reduce((a, c) => a + c.charCodeAt(0), 0);
  const iconSet = ["▴", "▾", "◉", "○", "□", "◇", "▸", "◄", "✦", "◆"];
  return iconSet[n % iconSet.length] ?? "";
}

// ─── FindingCard ────────────────────────────────────────────────────────────

function FindingCard({
  finding,
  punkColor,
  onDismiss,
  onCheckPrevious,
}: {
  finding: ReviewFinding;
  punkColor: string;
  onDismiss: () => void;
  onCheckPrevious: () => void;
}) {
  const [showRemediation, setShowRemediation] = useState(false);

  let structured: Record<string, unknown> = {};
  try {
    structured = JSON.parse(finding.structured || "{}");
  } catch {
    // structured may be malformed JSON from older findings — default to empty
  }

  const severityColor =
    finding.severity === "critical" ? "#A67272"
    : finding.severity === "warning" ? "#B8A56A"
    : "#A8A59E";

  const scopeLabel: string = String((structured.flow as string | undefined) ?? (structured.boundary as string | undefined) ?? (structured.journey as string | undefined) ?? "");

  return (
    <div className="mb-6 last:mb-0">
      {/* Severity badge + unique identifier */}
      <div className="flex items-center gap-2 mb-2">
        <span
          className="font-mono px-1.5 py-0.5 rounded"
          style={{
            fontSize: "var(--pane-font-size-xs)",
            backgroundColor: `${severityColor}18`,
            color: severityColor,
          }}
        >
          {finding.severity}
        </span>
        {scopeLabel && (
          <span
            className="font-mono text-pane-text-secondary/40 truncate"
            style={{ fontSize: "var(--pane-font-size-xs)" }}
          >
            {scopeLabel}
          </span>
        )}
      </div>

      {/* Finding text */}
      <p
        className="text-pane-text leading-relaxed whitespace-pre-wrap"
        style={{ fontSize: "var(--pane-font-size-sm)" }}
      >
        {String(finding.finding)}
      </p>

      {/* Location */}
      {finding.location && (
        <p
          className="font-mono text-pane-text-secondary/50 mt-2 truncate"
          style={{ fontSize: "var(--pane-font-size-xs)" }}
        >
          {finding.location}
        </p>
      )}

      {/* Remediation (collapsible) */}
      {(structured.remediation as string | undefined) && (
        <div className="mt-2.5">
          <button
            onClick={() => setShowRemediation(!showRemediation)}
            className="font-mono transition-colors btn-press"
            style={{
              fontSize: "var(--pane-font-size-xs)",
              color: punkColor,
              opacity: 0.6,
            }}
          >
            {showRemediation ? "▾ fix" : "▸ fix"}
          </button>
          {showRemediation && (
            <p
              className="text-pane-text-secondary mt-1 leading-relaxed whitespace-pre-wrap"
              style={{ fontSize: "var(--pane-font-size-xs)" }}
            >
              {String(structured.remediation ?? "")}
            </p>
          )}
        </div>
      )}

      {/* Actions */}
      <div className="flex items-center gap-3 mt-3">
        <button
          onClick={onDismiss}
          className="font-mono transition-colors btn-press text-pane-text-secondary/30 hover:text-pane-text-secondary/60"
          style={{ fontSize: "var(--pane-font-size-xs)" }}
        >
          dismiss
        </button>
        <button
          onClick={onCheckPrevious}
          className="font-mono transition-colors btn-press"
          style={{
            fontSize: "var(--pane-font-size-xs)",
            color: punkColor,
            opacity: 0.5,
          }}
        >
          check if fixed
        </button>
      </div>
    </div>
  );
}

// ─── New Punk Form ──────────────────────────────────────────────────────────

function NewPunkForm({ onCreated }: { onCreated: (name: string) => void }) {
  const [name, setName] = useState("");
  const [persona, setPersona] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const handleSubmit = useCallback(async () => {
    const trimmedName = name.trim().toLowerCase().replace(/\s+/g, "-");
    const trimmedPersona = persona.trim();

    if (!trimmedName) { setError("Name is required"); return; }
    if (!/^[a-z][a-z0-9-]*[a-z0-9]$/.test(trimmedName)) {
      setError("Name must be kebab-case (letters, numbers, hyphens)");
      return;
    }
    if (trimmedPersona.length < 20) {
      setError("Persona needs more content — include Identity, Methodology, and Principles");
      return;
    }

    setCreating(true);
    setError(null);

    try {
      const displayName = trimmedName.charAt(0).toUpperCase() + trimmedName.slice(1);
      const result = await createPunk(trimmedName, `# ${displayName}\n\n${trimmedPersona}`);
      if (result.success) {
        const store = useLensStore.getState();
        store.addPunk(trimmedName, displayName, "custom analyst");
        setName("");
        setPersona("");
        onCreated(trimmedName);
      } else {
        setError(result.error ?? "Failed to create punk");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create punk");
    } finally {
      setCreating(false);
    }
  }, [name, persona, onCreated]);

  return (
    <div className="border-t border-pane-border/10 pt-6 mt-6">
      <h2
        className="font-mono text-pane-text-secondary/50 mb-4"
        style={{ fontSize: "var(--pane-font-size-sm)" }}
      >
        New Punk
      </h2>

      <input
        type="text"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="name (kebab-case, e.g. 'api-auditor')"
        className="w-full bg-transparent font-mono text-pane-text border-b border-pane-border/20 outline-none pb-1 mb-4 transition-colors focus:border-pane-border/60"
        style={{ fontSize: "var(--pane-font-size-xs)" }}
        disabled={creating}
      />

      <textarea
        value={persona}
        onChange={(e) => setPersona(e.target.value)}
        placeholder={`## Identity

What is this punk? What does it analyze?

## Methodology

1. First principle...
2. Second principle...

## Principles

- A guiding rule
- Another one`}
        className="w-full bg-transparent font-mono text-pane-text border border-pane-border/20 rounded-md outline-none p-3 resize-none transition-colors focus:border-pane-border/60"
        style={{ fontSize: "var(--pane-font-size-xs)", minHeight: "120px" }}
        disabled={creating}
      />

      {error && (
        <p
          className="font-mono text-pane-error mt-2"
          style={{ fontSize: "var(--pane-font-size-xs)" }}
        >
          {error}
        </p>
      )}

      <div className="flex items-center gap-3 mt-3">
        <button
          onClick={handleSubmit}
          disabled={creating}
          className="font-mono transition-colors btn-press disabled:opacity-30 text-pane-accent hover:text-pane-accent/80"
          style={{ fontSize: "var(--pane-font-size-xs)" }}
        >
          {creating ? "creating..." : "create & run"}
        </button>
      </div>
    </div>
  );
}

// ─── PunkSection ────────────────────────────────────────────────────────────

function PunkSection({
  punk,
  punkState,
  onRun,
  onCheckPrevious,
}: {
  punk: { name: string; displayName: string; role: string; color: string };
  punkState: PunkState;
  onRun: (name: string, scope?: string) => void;
  onCheckPrevious: (name: string) => void;
}) {
  const setScope = useLensStore((s) => s.setPunkScope);
  const dismissFinding = useLensStore((s) => s.dismissFinding);
  const [showScope, setShowScope] = useState(false);

  const statusLabel: React.ReactNode =
    punkState.status === "running" ? "running..."
    : punkState.status === "failed" ? "failed"
    : punkState.status === "completed" ? (
      punkState.findings.length > 0
        ? `${punkState.findings.length} finding${punkState.findings.length > 1 ? "s" : ""}`
        : "nothing found"
    )
    : punkState.lastRan
    ? (() => {
        const diff = Date.now() - punkState.lastRan;
        if (diff < 60000) return "just now";
        if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
        if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
        return `${Math.floor(diff / 86400000)}d ago`;
      })()
    : null;

  const handleRun = () => {
    const scope = punkState.scope.trim() || undefined;
    onRun(punk.name, scope);
  };

  return (
    <div className="mb-8 last:mb-0">
      {/* Header row */}
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <span style={{ color: punk.color }} className="text-sm">
            {punkIcon(punk.name)}
          </span>
          <span
            className="font-mono"
            style={{
              fontSize: "var(--pane-font-size-sm)",
              color: punk.color,
            }}
          >
            {punk.displayName}
          </span>
          <span
            className="font-mono text-pane-text-secondary/30"
            style={{ fontSize: "var(--pane-font-size-xs)" }}
          >
            {punk.role}
          </span>
          {/* Status */}
          {punkState.status === "running" && (
            <span
              className="font-mono text-pane-accent"
              style={{ fontSize: "var(--pane-font-size-xs)" }}
            >
              · running...
            </span>
          )}
          {punkState.status === "failed" && (
            <span
              className="font-mono text-pane-error"
              style={{ fontSize: "var(--pane-font-size-xs)" }}
            >
              · failed
            </span>
          )}
          {punkState.status === "completed" && (
            <span
              className="font-mono text-pane-text-secondary/60"
              style={{ fontSize: "var(--pane-font-size-xs)" }}
            >
              · {statusLabel}
            </span>
          )}
          {punkState.status === "idle" && punkState.lastRan && (
            <span
              className="font-mono text-pane-text-secondary/30"
              style={{ fontSize: "var(--pane-font-size-xs)" }}
            >
              · {statusLabel}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {/* Scope toggle */}
          <button
            onClick={() => setShowScope(!showScope)}
            className="font-mono transition-colors btn-press text-pane-text-secondary/30 hover:text-pane-text-secondary/60"
            style={{ fontSize: "var(--pane-font-size-xs)" }}
          >
            {showScope ? "—" : "+"}
          </button>
          {/* Run button */}
          <button
            onClick={handleRun}
            disabled={punkState.status === "running"}
            className="font-mono transition-colors btn-press disabled:opacity-30"
            style={{
              fontSize: "var(--pane-font-size-xs)",
              color: punkState.status === "running" ? "var(--pane-text-secondary)" : punk.color,
            }}
          >
            {punkState.status === "running" ? "running..." : "run"}
          </button>
          {/* Check previous */}
          {punkState.findings.length > 0 && punkState.status !== "running" && (
            <button
              onClick={() => onCheckPrevious(punk.name)}
              className="font-mono transition-colors btn-press text-pane-text-secondary/25 hover:text-pane-text-secondary/50"
              style={{ fontSize: "var(--pane-font-size-xs)" }}
            >
              recheck
            </button>
          )}
        </div>
      </div>

      {/* Scope input (expandable) */}
      {showScope && (
        <div className="mb-3">
          <input
            type="text"
            value={punkState.scope}
            onChange={(e) => setScope(punk.name, e.target.value)}
            placeholder={`e.g., focus on ${punk.role ? punk.role : "your area of interest"}`}
            className="w-full bg-transparent font-mono text-pane-text border-b border-pane-border/20 outline-none pb-1 transition-colors focus:border-pane-border/60"
            style={{
              fontSize: "var(--pane-font-size-xs)",
              color: punk.color,
            }}
          />
        </div>
      )}

      {/* Error message */}
      {punkState.error && (
        <p
          className="font-mono text-pane-error mb-2"
          style={{ fontSize: "var(--pane-font-size-xs)" }}
        >
          {punkState.error}
        </p>
      )}

      {/* Findings */}
      {punkState.findings.length > 0 && (
        <div className="pl-5 border-l border-pane-border/10">
          {punkState.findings.map((finding: ReviewFinding) => (
            <FindingCard
              key={finding.id}
              finding={finding}
              punkColor={punk.color}
              onDismiss={() => dismissFinding(punk.name, finding.id)}
              onCheckPrevious={() => onCheckPrevious(punk.name)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Main Lens Component ──────────────────────────────────────────────────────

export function Lens({ projectId }: { projectId: string }) {
  const punks = useLensStore((s) => s.punks);
  const init = useLensStore((s) => s.init);
  const addPunk = useLensStore((s) => s.addPunk);
  const addPunkFindings = useLensStore((s) => s.addPunkFindings);
  const setPunkStatus = useLensStore((s) => s.setPunkStatus);
  const workingDir = useProjectsStore((s) => s.projects.get(projectId)?.root ?? "");
  const [showNewForm, setShowNewForm] = useState(false);

  // Load existing findings + discover punks on mount
  useEffect(() => {
    if (!projectId) return;
    init(projectId);

    listPunks().then((discovered) => {
      const store = useLensStore.getState();
      for (const p of discovered) {
        store.addPunk(p.name, p.displayName || p.name, p.role);
      }
    }).catch(() => {});
  }, [projectId, init, addPunk]);

  // Listen for punk progress/completion events
  useEffect(() => {
    type ElectronWindow = Window & typeof globalThis & {
      electronAPI: {
        on: (channel: string, cb: (...args: unknown[]) => void) => () => void;
      };
    };
    const electronAPI = (window as unknown as ElectronWindow).electronAPI;
    if (!electronAPI) return;

    const unlistenProgress = electronAPI.on("pane://punk-progress", (event: unknown) => {
      const ev = event as Record<string, unknown>;
      const punk = ev.punk as string | undefined;
      const status = ev.status as string | undefined;
      const error = ev.error as string | undefined;
      if (!punk) return;
      setPunkStatus(punk, status as PunkStatus, error);
    });

    const unlistenComplete = electronAPI.on("pane://punk-complete", (event: unknown) => {
      const ev = event as Record<string, unknown>;
      const punk = ev.punk as string | undefined;
      const findings = ev.findings as ReviewFinding[] | undefined;
      const checkPrevious = ev.checkPrevious as boolean | undefined;
      if (!punk) return;
      if (findings) {
        addPunkFindings(punk, findings, !!checkPrevious);
      }
      setPunkStatus(punk, "completed");
    });

    return () => {
      unlistenProgress();
      unlistenComplete();
    };
  }, [projectId, setPunkStatus, addPunkFindings]);

  // Handle run single punk
  const handleRun = useCallback(
    (name: string, scope?: string) => {
      if (!projectId || !workingDir) return;
      setPunkStatus(name, "running");
      runSinglePunk(name, projectId, workingDir, scope).catch((err) => {
        setPunkStatus(name, "failed", err.message);
      });
    },
    [projectId, workingDir, setPunkStatus],
  );

  // Handle check previous findings
  const handleCheckPrevious = useCallback(
    (name: string) => {
      if (!projectId || !workingDir) return;
      setPunkStatus(name, "running");
      checkPreviousFindings(name, projectId, workingDir).catch((err) => {
        setPunkStatus(name, "failed", err.message);
      });
    },
    [projectId, workingDir, setPunkStatus],
  );

  // Handle run all
  const handleRunAll = useCallback(() => {
    if (!projectId || !workingDir) return;
    const names = Object.keys(punks);
    for (const name of names) {
      setPunkStatus(name, "running");
    }
    runReview(projectId, workingDir).catch((err) => {
      for (const name of names) {
        setPunkStatus(name, "failed", err.message);
      }
    });
  }, [projectId, workingDir, punks, setPunkStatus]);

  // Handle doc punk (scribe)
  const [docPunkRunning, setDocPunkRunning] = useState(false);
  const handleDocPunk = useCallback(() => {
    if (!projectId || !workingDir || docPunkRunning) return;
    setDocPunkRunning(true);
    docPunkRun(projectId, workingDir, true).finally(() => {
      setTimeout(() => setDocPunkRunning(false), 5000); // debounce re-trigger
    });
  }, [projectId, workingDir, docPunkRunning]);

  const isAnyRunning = Object.values(punks).some((p) => p.status === "running");

  return (
    <div className="h-full overflow-y-auto px-6 py-8">
      {/* Header */}
      <div className="flex items-center justify-between mb-8">
        <h1
          className="font-mono text-pane-text"
          style={{ fontSize: "var(--pane-font-size-lg)" }}
        >
          Lens
        </h1>
        <div className="flex items-center gap-3">
          <button
            onClick={handleDocPunk}
            disabled={docPunkRunning}
            className="font-mono transition-colors btn-press disabled:opacity-30 text-pane-text-secondary/40 hover:text-pane-text-secondary/70"
            style={{ fontSize: "var(--pane-font-size-xs)" }}
            title="Draft documentation from recent conversation"
          >
            {docPunkRunning ? "scribing..." : "scribe"}
          </button>
          <button
            onClick={() => setShowNewForm(!showNewForm)}
            className="font-mono transition-colors btn-press text-pane-text-secondary/40 hover:text-pane-text-secondary/70"
            style={{ fontSize: "var(--pane-font-size-xs)" }}
          >
            {showNewForm ? "cancel" : "new"}
          </button>
          <button
            onClick={handleRunAll}
            disabled={isAnyRunning}
            className="font-mono transition-colors btn-press disabled:opacity-30 text-pane-text-secondary/40 hover:text-pane-text-secondary/70"
            style={{ fontSize: "var(--pane-font-size-xs)" }}
          >
            {isAnyRunning ? "running..." : "run all"}
          </button>
        </div>
      </div>

      {/* Punk sections */}
      {Object.entries(punks).map(([name, state]) => (
        <PunkSection
          key={name}
          punk={{
            name,
            displayName: state.displayName || name,
            role: state.role,
            color: state.color,
          }}
          punkState={state}
          onRun={handleRun}
          onCheckPrevious={handleCheckPrevious}
        />
      ))}

      {/* New Punk Form */}
      {showNewForm && (
        <NewPunkForm onCreated={(newName) => {
          setShowNewForm(false);
          handleRun(newName);
        }} />
      )}

      {/* Empty state */}
      {!isAnyRunning &&
        !showNewForm &&
        Object.values(punks).every((p) => p.findings.length === 0) && (
        <div
          className="text-center font-mono text-pane-text-secondary/20 mt-12"
          style={{ fontSize: "var(--pane-font-size-sm)" }}
        >
          Three experts are watching your codebase. Or create your own.
          <br />
          Run one to get started.
        </div>
      )}
    </div>
  );
}
