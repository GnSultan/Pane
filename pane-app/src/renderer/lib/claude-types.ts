// Content block types from Claude CLI stream-json output

export interface TextBlock {
  type: "text";
  text: string;
}

export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  name?: string;
  content: string;
  is_error?: boolean;
}

export interface ThinkingBlock {
  type: "thinking";
  thinking: string;
  signature?: string;
}

export interface ServerToolUseBlock {
  type: "server_tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface WebSearchResult {
  type: "web_search_result";
  url: string;
  title: string;
  encrypted_content: string;
  page_age?: string | null;
}

export interface WebSearchToolResultError {
  type: "web_search_tool_result_error";
  error_code: string;
}

export interface WebSearchToolResultBlock {
  type: "web_search_tool_result";
  tool_use_id: string;
  content: WebSearchResult[] | WebSearchToolResultError;
}

export interface JsonBlock {
  type: "json";
  json: Record<string, unknown> | Array<unknown>;
  raw?: string;
}

export type ContentBlock =
  | TextBlock
  | ToolUseBlock
  | ToolResultBlock
  | ThinkingBlock
  | ServerToolUseBlock
  | WebSearchToolResultBlock
  | JsonBlock;

// Top-level message types from stream-json

export interface InitMessage {
  type: "system";
  subtype: "init";
  session_id: string;
  tools: string[];
  model: string;
}

export interface AssistantMessage {
  type: "assistant";
  message: {
    content: ContentBlock[];
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
      service_tier?: string;
    };
  };
  model?: string;
}

export interface UserMessage {
  type: "user";
  message: {
    content: ContentBlock[];
  };
}

export interface ResultMessage {
  type: "result";
  subtype: string;
  session_id: string;
  result?: string;
  error?: string;
  total_cost_usd?: number;
  duration_ms?: number;
  duration_api_ms?: number;
  is_error?: boolean;
  num_turns?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
}

export interface StreamEvent {
  type: "stream_event";
  event: {
    type: string;
    index?: number;
    delta?: {
      type: "text_delta" | "thinking_delta" | "partial_json_delta";
      text?: string;
      thinking?: string;
      signature?: string;
      partial_json?: string;
    };
    content_block?: ContentBlock;
  };
}

export type ClaudeStreamMessage =
  | InitMessage
  | AssistantMessage
  | UserMessage
  | ResultMessage
  | StreamEvent;

// Frontend event envelope from Electron IPC

export interface ClaudeEventMessage {
  event: "message";
  data: { parsed?: ClaudeStreamMessage; raw_json?: string };
}

export interface ClaudeEventProcessStarted {
  event: "processStarted";
  data: null;
}

export interface ClaudeEventProcessEnded {
  event: "processEnded";
  data: { exit_code: number | null };
}

export interface PunkEventRouting {
  event: "routing";
  data: {
    intent: string;
    confidence: number;
    reason: string;
    provider: string;
    model: string;
    thinking: boolean;
  };
}

export interface ClaudeEventError {
  event: "error";
  data: { message: string };
}

export interface ClaudeEventCompactionStart {
  event: "compaction_start";
  data: { reason: string; strategy: string };
}

export interface ClaudeEventCompactionComplete {
  event: "compaction_complete";
  data: {
    originalCount: number;
    compactedCount: number;
    tokensSaved: number;
    totalCompactions: number;
  };
}

export interface ClaudeEventTodosUpdated {
  event: "todos_updated";
  data: {
    todos: Todo[];
  };
}

export interface ClaudeEventActiveTaskUpdated {
  event: "activeTask_updated";
  data: {
    activeTask: { description: string };
  };
}

// ── Orchestration Events (Control Inversion) ────────────────────────────

export interface OrchestrationStartEvent {
  event: "orchestration_start";
  data: { prompt: string };
}

export interface OrchestrationPlanEvent {
  event: "orchestration_plan";
  data: {
    summary: string;
    steps: { index: number; action: string; type: string; files: string[] }[];
    totalSteps: number;
  };
}

export interface OrchestrationStepEvent {
  event: "orchestration_step";
  data: {
    phase: string;
    stepIndex?: number;
    totalSteps?: number;
    action?: string;
    type?: string;
    message: string;
    reason?: string;
  };
}

export interface OrchestrationStepCompleteEvent {
  event: "orchestration_step_complete";
  data: {
    stepIndex: number;
    totalSteps: number;
    passed: boolean;
    reason: string;
    action: string;
    scopeViolations?: string[];
    changedFiles?: string[];
    retry?: boolean;
  };
}

export interface OrchestrationCompleteEvent {
  event: "orchestration_complete";
  data: {
    summary: string;
    totalSteps: number;
    completedSteps: number;
    allPassed: boolean;
    typeCheckPassed: boolean;
    typeCheckOutput: string | null;
    touchedFiles: string[];
    results: {
      index: number;
      action: string;
      passed: boolean;
      reason: string;
      scopeViolations: string[];
      changedFiles: string[];
    }[];
  };
}

export interface OrchestrationTypecheckEvent {
  event: "orchestration_typecheck";
  data: {
    passed: boolean;
    output: string;
  };
}

export interface OrchestrationErrorEvent {
  event: "orchestration_error";
  data: { message: string };
}

export type ClaudeStreamEvent =
  | ClaudeEventMessage
  | ClaudeEventProcessStarted
  | ClaudeEventProcessEnded
  | PunkEventRouting
  | ClaudeEventError
  | ClaudeEventCompactionStart
  | ClaudeEventCompactionComplete
  | ClaudeEventTodosUpdated
  | ClaudeEventActiveTaskUpdated
  | OrchestrationStartEvent
  | OrchestrationPlanEvent
  | OrchestrationStepEvent
  | OrchestrationStepCompleteEvent
  | OrchestrationCompleteEvent
  | OrchestrationTypecheckEvent
  | OrchestrationErrorEvent;

// Plan message types — the blueprint Pane produces before execution

export interface PlanStep {
  index: number;
  type: "read" | "write" | "verify" | "plan";
  action: string;
  files: string[];
}

export interface PlanData {
  id: string;
  task: string;
  steps: PlanStep[];
  planningModel?: string | null;
  executionModel?: string | null;
}

// Parsed conversation message for the UI

export interface ConversationMessage {
  id: string;
  type: "user" | "assistant" | "system" | "result" | "plan";
  content: ContentBlock[];
  timestamp: number;
  isStreaming: boolean;
  costUsd?: number;
  durationMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  numTurns?: number;
  checkpointId?: string;
  // Present when type === "plan"
  planData?: PlanData;
}

// File checkpoint types

export interface CheckpointMeta {
  id: string;
  timestamp: number;
  messageId: string;
  fileCount: number;
}

export interface Todo {
  content: string;
  status: "pending" | "in_progress" | "completed";
  activeForm: string;
}

export type ContextPressure = "none" | "building" | "high";

export interface ConversationState {
  messages: ConversationMessage[];
  sessionId: string | null;
  model: string | null;
  routedModel: string | null; // Model chosen by smart router for current request
  serviceTier: string | null;
  isProcessing: boolean;
  isPlanning: boolean;

  isRestored: boolean; // true once loaded from disk at startup
  error: string | null;
  todos: Todo[];
  pendingPlanApproval: boolean;
  // Session lifecycle
  isProcessActive: boolean; // Is the Claude CLI child process currently running?
  lastActivity: number; // Timestamp of last user interaction with this project
  // Context pressure tracking
  contextTokens: number; // Latest input_tokens from usage
  contextPressure: ContextPressure;
  // Cached brief from last generateBrief — used for enhanced continuation
  cachedBrief: string;
  statusMessage: string | null;
  // Context compaction status
  isCompacting: boolean;
  lastCompactionAt: number | null;
  compactionCount: number;
  tokensSaved: number;
}

// Memory event types for automatic extraction
export interface MemoryEvent {
  type:
    | "file_edit"
    | "error"
    | "error_fix"
    | "decision"
    | "command"
    | "summary"
    | "lesson"
    | "pattern";
  content: string;
  timestamp: number;
  source?: "auto" | "claude";
  metadata?: Record<string, string>;
}

export function createEmptyConversation(): ConversationState {
  return {
    messages: [],
    sessionId: null,
    model: null,
    routedModel: null,
    serviceTier: null,
    isProcessing: false,
    isPlanning: false,
    isRestored: false,
    error: null,
    todos: [],
    pendingPlanApproval: false,
    isProcessActive: false,
    lastActivity: Date.now(),
    contextTokens: 0,
    contextPressure: "none",
    cachedBrief: "",
    statusMessage: null,
    isCompacting: false,
    lastCompactionAt: null,
    compactionCount: 0,
    tokensSaved: 0,
  };
}
