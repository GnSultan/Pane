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

export type ContentBlock =
  | TextBlock
  | ToolUseBlock
  | ToolResultBlock
  | ThinkingBlock
  | ServerToolUseBlock
  | WebSearchToolResultBlock;

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
      type: string;
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
  inputTokens?: number;
  outputTokens?: number;
  numTurns?: number;
}

export interface Todo {
  content: string;
  status: "pending" | "in_progress" | "completed";
  activeForm: string;
}

export interface ConversationState {
  messages: ConversationMessage[];
  sessionId: string | null;
  model: string | null;
  serviceTier: string | null;
  isProcessing: boolean;
  isPlanning: boolean;
  isReady: boolean;
  error: string | null;
  todos: Todo[];
  pendingPlanApproval: boolean;
  // Session lifecycle
  isProcessActive: boolean;  // Is the Claude CLI child process currently running?
  lastActivity: number;       // Timestamp of last user interaction with this project
}

export function createEmptyConversation(): ConversationState {
  return {
    messages: [],
    sessionId: null,
    model: null,
    serviceTier: null,
    isProcessing: false,
    isPlanning: false,
    isReady: false,  // Will be set to true by warmup after initial message completes
    error: null,
    todos: [],
    pendingPlanApproval: false,
    isProcessActive: false,
    lastActivity: Date.now(),
  };
}
