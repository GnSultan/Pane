import { useState, useRef, useEffect, useCallback } from 'react';
import type { ConversationMessage, TextBlock, ToolUseBlock, ToolResultBlock } from '../lib/punk-types';
import type { PunkStreamEvent, PunkStreamMessage } from '../lib/punk-types';
import {
  lensCommentsList,
  lensCommentAdd,
  lensCommentSetSession,
  sendToLens,
  abortLens,
} from '../lib/tauri-commands';
import { useWorkspaceStore } from '../stores/workspace';

function nextId(): string {
  return 'lens-' + crypto.randomUUID();
}

// ─── rAF-batched text flush ────────────────────────────────────────────────

interface StreamState {
  pending: string;
  raf: number;
}

const streamStates = new Map<string, StreamState>();

function getStreamState(id: string): StreamState {
  let s = streamStates.get(id);
  if (!s) { s = { pending: '', raf: 0 }; streamStates.set(id, s); }
  return s;
}

function deleteStreamState(id: string) {
  streamStates.delete(id);
}

// ─── Hook ──────────────────────────────────────────────────────────────────

export function useLensChat(
  postId: string | null,
  workingDir: string,
  postContent: string
): {
  messages: ConversationMessage[];
  isProcessing: boolean;
  error: string | null;
  sendMessage: (prompt: string) => Promise<void>;
  appendMessage: (msg: ConversationMessage) => void;
  abort: () => void;
} {
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Stable stream-state key per render cycle — cleared on postId change
  const streamKey = useRef('lens-stream-' + Math.random().toString(36).slice(2));

  // Reset and load existing comments on postId change
  useEffect(() => {
    const key = streamKey.current;
    const s = streamStates.get(key);
    if (s?.raf) { cancelAnimationFrame(s.raf); }
    deleteStreamState(key);
    streamKey.current = 'lens-stream-' + Math.random().toString(36).slice(2);

    setIsProcessing(false);
    setError(null);

    if (!postId) {
      setMessages([]);
      return;
    }

    let cancelled = false;

    lensCommentsList(postId)
      .then((comments) => {
        if (cancelled) return;
        const loaded: ConversationMessage[] = comments
          .map((c) => {
            try { return JSON.parse(c.content) as ConversationMessage; }
            catch { return null; }
          })
          .filter((m): m is ConversationMessage => {
            if (!m) return false;
            if (m.type === 'assistant') {
              return m.content.some(
                (b) => b.type === 'text' && (b as TextBlock).text?.length > 0
              );
            }
            return m.type === 'user';
          });
        setMessages(loaded);
      })
      .catch(() => {
        if (!cancelled) setMessages([]);
      });

    return () => { cancelled = true; };
  }, [postId]);

  // Cleanup stream state on unmount
  useEffect(() => {
    return () => {
      const key = streamKey.current;
      const s = streamStates.get(key);
      if (s?.raf) cancelAnimationFrame(s.raf);
      deleteStreamState(key);
    };
  }, []);

  const sendMessage = useCallback(
    async (prompt: string) => {
      if (!postId) return;

      const key = streamKey.current;

      // Append user message
      const userMsg: ConversationMessage = {
        id: nextId(),
        type: 'user',
        content: [{ type: 'text', text: prompt } as TextBlock],
        timestamp: Date.now(),
        isStreaming: false,
      };
      setMessages((prev) => [...prev, userMsg]);
      lensCommentAdd(postId, 'user', JSON.stringify(userMsg)).catch(() => {});

      setIsProcessing(true);
      setError(null);

      let assistantMsgId = '';

      // rAF text flush
      const flushText = () => {
        const state = streamStates.get(key);
        if (!state) return;
        if (!state.pending) { state.raf = 0; return; }

        const chunk = state.pending;
        state.pending = '';

        setMessages((prev) => {
          if (!prev.length) return prev;
          const last = prev[prev.length - 1];
          if (!last || last.type !== 'assistant') return prev;
          const content = [...last.content];
          let found = false;
          for (let i = content.length - 1; i >= 0; i--) {
            const b = content[i];
            if (b && b.type === 'text') {
              content[i] = { ...(b as TextBlock), text: (b as TextBlock).text + chunk };
              found = true;
              break;
            }
          }
          if (!found) content.push({ type: 'text', text: chunk } as TextBlock);
          return [...prev.slice(0, -1), { ...last, content }] as ConversationMessage[];
        });

        state.raf = 0;
      };

      const flushAll = () => {
        const state = streamStates.get(key);
        if (!state) return;
        if (state.raf) { cancelAnimationFrame(state.raf); state.raf = 0; }
        if (!state.pending) return;
        const remaining = state.pending;
        state.pending = '';
        setMessages((prev) => {
          if (!prev.length) return prev;
          const last = prev[prev.length - 1];
          if (!last || last.type !== 'assistant') return prev;
          const content = [...last.content];
          let found = false;
          for (let i = content.length - 1; i >= 0; i--) {
            const b = content[i];
            if (b && b.type === 'text') {
              content[i] = { ...(b as TextBlock), text: (b as TextBlock).text + remaining };
              found = true;
              break;
            }
          }
          if (!found) content.push({ type: 'text', text: remaining } as TextBlock);
          return [...prev.slice(0, -1), { ...last, content }] as ConversationMessage[];
        });
      };

      const handleEvent = (event: PunkStreamEvent) => {
        switch (event.event) {
          case 'processStarted':
            break;

          case 'message': {
            const msgEvent = event as { event: string; data?: { parsed?: PunkStreamMessage; raw_json?: string } };
            const parsed = msgEvent.data?.parsed;
            if (!parsed) break;

            // ── system:init — capture session ID ──────────────────────────
            if (parsed.type === 'system') {
              const initMsg = parsed as { type: "system"; subtype: string; session_id: string };
              if (initMsg.subtype === 'init' && initMsg.session_id) {
                lensCommentSetSession(postId, initMsg.session_id).catch(() => {});
              }
              break;
            }

            // ── stream_event — real-time text streaming ────────────────────
            if (parsed.type === 'stream_event') {
              const streamMsg = parsed as { type: "stream_event"; event: { type: string; delta?: { type: string; text?: string }; content_block?: { type: string; id?: string; name?: string }; index?: number } };
              const evt = streamMsg.event;
              if (!evt) break;

              if (
                evt.type === 'content_block_delta' &&
                evt.delta?.type === 'text_delta' &&
                evt.delta.text
              ) {
                const text = evt.delta.text;

                if (!assistantMsgId) {
                  assistantMsgId = nextId();
                  setMessages((prev) => [
                    ...prev,
                    {
                      id: assistantMsgId,
                      type: 'assistant',
                      content: [{ type: 'text', text } as TextBlock],
                      timestamp: Date.now(),
                      isStreaming: true,
                    },
                  ]);
                } else {
                  const state = getStreamState(key);
                  state.pending += text;
                  if (!state.raf) {
                    state.raf = requestAnimationFrame(flushText);
                  }
                }
              }
              break;
            }

            // ── assistant — SDK assembled message ──────────────────────────
            if (parsed.type === 'assistant') {
              flushAll();
              const assistantMsg = parsed as { message?: { content?: (TextBlock | ToolUseBlock)[] }; content?: (TextBlock | ToolUseBlock)[] };
              const finalContent = (assistantMsg.message?.content || assistantMsg.content || []) as (TextBlock | ToolUseBlock)[];
              const hasText = finalContent.some((b) => b.type === 'text');

              const fallbackId = !assistantMsgId && hasText ? nextId() : '';

              setMessages((prev) => {
                const last = prev[prev.length - 1];
                if (last && last.id === assistantMsgId) {
                  const streamedText = last.content.filter((b) => b.type === 'text');
                  let merged: (TextBlock | ToolUseBlock)[];
                  if (!hasText && streamedText.length > 0) {
                    const firstNonText = finalContent.findIndex((b) => b.type !== 'text');
                    const insertAt = firstNonText === -1 ? finalContent.length : firstNonText;
                    merged = [
                      ...finalContent.slice(0, insertAt),
                      ...(streamedText as TextBlock[]),
                      ...finalContent.slice(insertAt),
                    ] as (TextBlock | ToolUseBlock)[];
                  } else {
                    merged = finalContent;
                  }
                  const updated = { ...last, content: merged as ConversationMessage['content'], isStreaming: false };
                  if (merged.some((b) => b.type === 'text')) {
                    lensCommentAdd(postId, 'assistant', JSON.stringify(updated)).catch(() => {});
                  }
                  return [...prev.slice(0, -1), updated];
                } else if (hasText && fallbackId) {
                  const msg: ConversationMessage = {
                    id: fallbackId,
                    type: 'assistant',
                    content: finalContent as ConversationMessage['content'],
                    timestamp: Date.now(),
                    isStreaming: false,
                  };
                  lensCommentAdd(postId, 'assistant', JSON.stringify(msg)).catch(() => {});
                  return [...prev, msg];
                }
                return prev;
              });
              if (!assistantMsgId && fallbackId) assistantMsgId = fallbackId;
              break;
            }

            // ── user — tool results ────────────────────────────────────────
            if (parsed.type === 'user') {
              const userMsg = parsed as { message?: { content?: ToolResultBlock[] }; content?: ToolResultBlock[] };
              const content = (userMsg.message?.content || userMsg.content || []);
              if (content.some((b) => b.type === 'tool_result')) {
                assistantMsgId = '';
              }
              break;
            }

            // ── result — session metadata ──────────────────────────────────
            if (parsed.type === 'result') {
              flushAll();
              setMessages((prev) => {
                const last = prev[prev.length - 1];
                if (last?.type === 'assistant' && last.isStreaming) {
                  return [...prev.slice(0, -1), { ...last, isStreaming: false }];
                }
                return prev;
              });
              break;
            }
            break;
          }

          case 'processEnded': {
            flushAll();
            setIsProcessing(false);
            break;
          }

          case 'error': {
            const errData = (event as { event: string; data?: { message?: string } }).data;
            setError(errData?.message || 'Unknown error');
            setIsProcessing(false);
            break;
          }

          default:
            break;
        }
      };

      const selectedModel = useWorkspaceStore.getState().selectedModel;
      const selectedModelProvider = useWorkspaceStore.getState().selectedModelProvider;
      const selectedModelThinking = useWorkspaceStore.getState().selectedModelThinking ?? false;

      try {
        await sendToLens(
          postId,
          prompt,
          workingDir,
          selectedModel,
          selectedModelProvider,
          selectedModelThinking,
          postContent || '(no observation content)',
          handleEvent
        );
      } catch (err) {
        console.error('[lens] sendToLens failed:', err);
        setError(err instanceof Error ? err.message : 'Failed to send message');
        setIsProcessing(false);
      }
    },
    [postId, workingDir, postContent]
  );

  const abort = useCallback(() => {
    if (postId) {
      abortLens(postId).catch(() => {});
    }
  }, [postId]);

  const appendMessage = useCallback((msg: ConversationMessage) => {
    setMessages((prev) => prev.some((m) => m.id === msg.id) ? prev : [...prev, msg]);
  }, []);

  return { messages, isProcessing, error, sendMessage, appendMessage, abort };
}
