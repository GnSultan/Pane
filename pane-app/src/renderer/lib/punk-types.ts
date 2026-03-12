// Punk agent types — thin aliases over the existing stream-json protocol.
// This keeps the renderer semantics but lets us speak in Pane's own language.

export type {
  TextBlock,
  ToolUseBlock,
  ToolResultBlock,
  ThinkingBlock,
  ServerToolUseBlock,
  WebSearchResult,
  WebSearchToolResultBlock,
  ContentBlock,
  InitMessage,
  AssistantMessage,
  UserMessage,
  ResultMessage,
  StreamEvent,
  ClaudeStreamMessage as PunkStreamMessage,
  ClaudeEventMessage as PunkEventMessage,
  ClaudeEventProcessStarted as PunkEventProcessStarted,
  ClaudeEventProcessEnded as PunkEventProcessEnded,
  ClaudeEventError as PunkEventError,
  ClaudeStreamEvent as PunkStreamEvent,
  ConversationMessage as PunkConversationMessage,
  CheckpointMeta,
  Todo,
  ContextPressure,
  ConversationState,
  MemoryEvent,
} from "./claude-types";

