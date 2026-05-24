import { useState } from "react";
import type { PlanBrief, PlanData } from "../../lib/punk-types";
import { MicroIndicator } from "../shared";

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-2">
      <div
        className="font-mono uppercase tracking-widest"
        style={{ fontSize: "9px", color: "var(--pane-terminal)", opacity: 0.7 }}
      >
        {label}
      </div>
      {children}
    </div>
  );
}

function Prose({ children }: { children: React.ReactNode }) {
  return (
    <p
      className="text-pane-text leading-relaxed"
      style={{ fontSize: "var(--pane-font-size-sm)" }}
    >
      {children}
    </p>
  );
}

function FileList({ items }: { items: { file: string; detail: string }[] }) {
  return (
    <ul className="space-y-3">
      {items.map((item, i) => (
        <li key={i} className="grid gap-0.5" style={{ gridTemplateColumns: "1fr" }}>
          <span
            className="font-mono truncate"
            style={{ fontSize: "var(--pane-font-size-sm)", color: "var(--pane-terminal)" }}
          >
            {item.file.includes("/") ? item.file.split("/").pop() : item.file}
            {item.file.includes("/") && (
              <span className="text-pane-text-secondary/30 ml-1">
                {item.file.substring(0, item.file.lastIndexOf("/") + 1)}
              </span>
            )}
          </span>
          <span
            className="text-pane-text-secondary/60 leading-snug"
            style={{ fontSize: "var(--pane-font-size-sm)" }}
          >
            {item.detail}
          </span>
        </li>
      ))}
    </ul>
  );
}

function PlanBriefView({ brief }: { brief: PlanBrief }) {
  return (
    <div className="space-y-6">
      <Section label="what">
        <Prose>{brief.what}</Prose>
      </Section>

      <Section label="architecture">
        <Prose>{brief.architecture}</Prose>
      </Section>

      {brief.created.length > 0 && (
        <Section label="creating">
          <FileList items={brief.created.map(c => ({ file: c.file, detail: c.purpose }))} />
        </Section>
      )}

      {brief.modified.length > 0 && (
        <Section label="modifying">
          <FileList items={brief.modified.map(m => ({ file: m.file, detail: m.change }))} />
        </Section>
      )}

      {brief.result && (
        <Section label="result">
          <p
            className="text-pane-text-secondary/70 leading-relaxed"
            style={{ fontSize: "var(--pane-font-size-sm)" }}
          >
            {brief.result}
          </p>
        </Section>
      )}
    </div>
  );
}

interface PlanBlockProps {
  planData: PlanData;
}

export function PlanBlock({ planData }: PlanBlockProps) {
  const [expanded, setExpanded] = useState(false);

  const summary = planData.task.length > 72
    ? planData.task.slice(0, 72) + "…"
    : planData.task;

  return (
    <div
      className={`rounded-md border transition-all duration-200 ${
        expanded
          ? "border-[var(--pane-border-soft)] bg-[var(--pane-bg)] mb-2"
          : "border-transparent hover:border-[var(--pane-border-soft)] mb-0.5"
      }`}
    >
      <button
        onClick={() => setExpanded((e) => !e)}
        className="flex items-center gap-2.5 text-pane-text-secondary font-mono
                   hover:text-pane-text w-full text-left
                   h-10 leading-none px-4 group"
        style={{ fontSize: "var(--pane-font-size-sm)", minHeight: "2.5rem" }}
      >
        <MicroIndicator variant="subtle" size={5} ariaLabel="plan ready" />
        <span className="shrink-0 opacity-70" style={{ color: "var(--pane-terminal)" }}>
          plan
        </span>
        <span className="truncate">{summary}</span>
        {planData.planningModel && (
          <span className="shrink-0 text-pane-text-secondary/30 ml-1">
            {planData.planningModel.split("/").pop()}
          </span>
        )}
        <span
          className="ml-auto shrink-0 opacity-0 group-hover:opacity-100 transition-opacity text-pane-text-secondary/20 font-mono"
          style={{ fontSize: "var(--pane-font-size-sm)" }}
        >
          {expanded ? "collapse" : "expand"}
        </span>
      </button>

      {expanded && (
        <div className="border-t border-pane-text-secondary/10 px-5 pt-5 pb-6">
          {planData.brief && typeof planData.brief === "object" ? (
            <PlanBriefView brief={planData.brief} />
          ) : planData.brief && typeof planData.brief === "string" ? (
            <p
              className="text-pane-text-secondary/70 leading-relaxed"
              style={{ fontSize: "var(--pane-font-size-sm)" }}
            >
              {planData.brief}
            </p>
          ) : (
            <p
              className="text-pane-text-secondary/50 leading-relaxed"
              style={{ fontSize: "var(--pane-font-size-sm)" }}
            >
              {planData.task}
            </p>
          )}

          {planData.executionModel && (
            <p
              className="mt-6 font-mono text-pane-text-secondary/25"
              style={{ fontSize: "10px" }}
            >
              executing with {planData.executionModel}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
