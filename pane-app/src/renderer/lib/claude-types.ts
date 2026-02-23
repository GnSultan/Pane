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
  content: string;
  is_error?: boolean;
}

export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock;

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
  };
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
  total_cost_usd?: number;
  duration_ms?: number;
  duration_api_ms?: number;
  is_error?: boolean;
  num_turns?: number;
}

export interface StreamEvent {
  type: "stream_event";
  event: {
    type: string;
    index?: number;
    delta?: {
      type: string;
      text?: string;
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

// Frontend event envelope from Rust backend (Tauri Channel)

export interface ClaudeEventMessage {
  event: "message";
  data: { raw_json: string };
}

export interface ClaudeEventProcessStarted {
  event: "processStarted";
  data: null;
}

export interface ClaudeEventProcessEnded {
  event: "processEnded";
  data: { exit_code: number | null };
}

export interface ClaudeEventError {
  event: "error";
  data: { message: string };
}

export type ClaudeStreamEvent =
  | ClaudeEventMessage
  | ClaudeEventProcessStarted
  | ClaudeEventProcessEnded
  | ClaudeEventError;

// Parsed conversation message for the UI

export interface ConversationMessage {
  id: string;
  type: "user" | "assistant" | "system" | "result";
  content: ContentBlock[];
  timestamp: number;
  isStreaming: boolean;
  costUsd?: number;
  durationMs?: number;
}

export interface Todo {
  content: string;
  status: "pending" | "in_progress" | "completed";
  activeForm: string;
}

export interface ConversationState {
  messages: ConversationMessage[];
  sessionId: string | null;
  isProcessing: boolean;
  error: string | null;
  todos: Todo[];
  pendingPlanApproval: boolean;
}

export function createEmptyConversation(): ConversationState {
  return {
    messages: [],
    sessionId: null,
    isProcessing: false,
    error: null,
    todos: [],
    pendingPlanApproval: false,
  };
}
