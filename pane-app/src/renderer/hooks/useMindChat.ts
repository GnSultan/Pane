import { useState, useRef, useEffect, useCallback } from 'react';
import type { ConversationMessage, TextBlock, ToolUseBlock, ToolResultBlock, MemoryEvent } from '../lib/punk-types';
import type { PunkStreamEvent, PunkStreamMessage } from '../lib/punk-types';
import {
  mindThreadGet,
  mindThreadCreate,
  mindThreadAddTurn,
  mindThreadSetSession,
  sendToMind,
  abortPunk,
  extractPreferencesFromTurn,
  brainIndexEvents,
  recordMemoryEvents,
} from '../lib/tauri-commands';
import { useWorkspaceStore } from '../stores/workspace';

function nextId(): string {
  // crypto.randomUUID() is immune to HMR counter resets and never duplicates,
  // even when called inside React state updaters (StrictMode double-invocation safe)
  return 'mind-' + crypto.randomUUID();
}

// ─── rAF-batched text flush (mirrors usePunk.ts flushTextDelta) ────────────

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

export function useMindChat(
  entryId: string | null,
  workingDir: string,
  entryContent: string
): {
  messages: ConversationMessage[];
  isProcessing: boolean;
  error: string | null;
  sendMessage: (prompt: string) => Promise<void>;
  abortMessage: () => void;
} {
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // threadLoaded as state so the auto-send effect can react to it
  const [threadLoaded, setThreadLoaded] = useState(false);

  const threadIdRef = useRef<string | null>(null);
  const autoSentRef = useRef(false);

  // Stable stream-state key per render cycle — cleared on entry change
  const streamKey = useRef('mind-stream-' + Math.random().toString(36).slice(2));

  // Reset everything on entryId change
  useEffect(() => {
    const key = streamKey.current;
    const s = streamStates.get(key);
    if (s?.raf) { cancelAnimationFrame(s.raf); }
    deleteStreamState(key);
    streamKey.current = 'mind-stream-' + Math.random().toString(36).slice(2);

    setIsProcessing(false);
    setError(null);
    setThreadLoaded(false);
    threadIdRef.current = null;
    autoSentRef.current = false;

    if (!entryId) {
      setMessages([]);
      return;
    }

    let cancelled = false;

    mindThreadGet(entryId)
      .then((result) => {
        if (cancelled) return;
        const thread = result?.thread ?? null;
        const turns = result?.turns ?? [];

        if (thread?.id) {
          threadIdRef.current = thread.id;

          const loaded: ConversationMessage[] = turns
            .map((turn) => {
              try { return JSON.parse(turn.content_json) as ConversationMessage; }
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

          setMessages(loaded); // atomic swap — no blank frame
        } else {
          setMessages([]);
        }
        setThreadLoaded(true);
      })
      .catch(() => {
        if (!cancelled) {
          setMessages([]);
          setThreadLoaded(true);
        }
      });

    return () => { cancelled = true; };
  }, [entryId]);

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
      if (!entryId) return;

      // Ensure thread exists
      if (!threadIdRef.current) {
        let createResult: Awaited<ReturnType<typeof mindThreadCreate>>;
        try {
          createResult = await mindThreadCreate(entryId);
        } catch (err) {
          setError(err instanceof Error ? err.message : 'Failed to create thread');
          return;
        }
        if (!createResult?.thread?.id) {
          setError('Failed to create thread — no thread returned');
          return;
        }
        threadIdRef.current = createResult.thread.id;
      }

      const threadId = threadIdRef.current!;
      const key = streamKey.current;

      // Include the last punk analysis as context when messages exist
      let effectivePrompt = prompt;
      if (messages.length > 0) {
        const lastPunkMsg = [...messages].reverse().find(
          (m) => m.type === 'assistant' && m.punkType
        );
        if (lastPunkMsg) {
          const punkText = lastPunkMsg.content
            .filter((b): b is TextBlock => b.type === 'text')
            .map((b) => b.text)
            .join('\n');
          if (punkText) {
            effectivePrompt = `Previous analysis by Pane (${lastPunkMsg.punkType}):\n${punkText}\n\nFollow-up:\n${prompt}`;
          }
        }
      }

      // Append user message
      const userMsg: ConversationMessage = {
        id: nextId(),
        type: 'user',
        content: [{ type: 'text', text: prompt } as TextBlock],
        timestamp: Date.now(),
        isStreaming: false,
      };
      setMessages((prev) => [...prev, userMsg]);
      mindThreadAddTurn(threadId, 'user', JSON.stringify(userMsg)).catch(() => {});

      setIsProcessing(true);
      setError(null);

      // Track whether an assistant message is being streamed in this turn
      let assistantMsgId = '';
      // Track turn text for memory extraction on processEnded
      const turnUserText = prompt;
      let turnAssistantText = '';

      // rAF text flush — appends full buffered text to the last assistant message.
      // Flushes the entire pending buffer in one shot per frame; no char-drip throttle.
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

      // Flush all remaining pending text synchronously
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
            // data.parsed is the raw SDK message object
            const parsed = (event as any).data?.parsed as PunkStreamMessage | undefined;
            if (!parsed) break;

            // ── system:init — capture session ID ──────────────────────────
            if (parsed.type === 'system') {
              const p = parsed as any;
              if (p.subtype === 'init' && p.session_id && threadIdRef.current) {
                mindThreadSetSession(threadIdRef.current, p.session_id).catch(() => {});
              }
              break;
            }

            // ── stream_event — real-time text streaming ────────────────────
            // The SDK fires stream_events BEFORE the assembled "assistant" message.
            // msg.event is the raw Anthropic streaming event object.
            if (parsed.type === 'stream_event') {
              const evt = (parsed as any).event as {
                type: string;
                delta?: { type: string; text?: string };
                content_block?: { type: string; id?: string; name?: string };
                index?: number;
              };
              if (!evt) break;

              if (
                evt.type === 'content_block_delta' &&
                evt.delta?.type === 'text_delta' &&
                evt.delta.text
              ) {
                const text = evt.delta.text;

                turnAssistantText += text; // accumulate for memory extraction

                if (!assistantMsgId) {
                  // First delta — create placeholder (same pattern as usePunk.ts)
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
                  // Subsequent deltas — buffer through rAF
                  const state = getStreamState(key);
                  state.pending += text;
                  if (!state.raf) {
                    state.raf = requestAnimationFrame(flushText);
                  }
                }
              }
              break;
            }

            // ── assistant — SDK assembled message (arrives after streaming) ─
            // This is the authoritative final content for this turn.
            // Content lives at msg.message.content (SDK structure).
            if (parsed.type === 'assistant') {
              flushAll();
              const p = parsed as any;
              // SDK structure: { type: "assistant", message: { content: [...] } }
              const finalContent = (p.message?.content || p.content || []) as (TextBlock | ToolUseBlock)[];
              const hasText = finalContent.some((b) => b.type === 'text');

              // Generate the fallback ID OUTSIDE the updater — nextId() must
              // never be called inside a setMessages callback because React
              // StrictMode invokes updaters twice to detect side effects, which
              // would create two different IDs and corrupt assistantMsgId.
              const fallbackId = !assistantMsgId && hasText ? nextId() : '';

              setMessages((prev) => {
                const last = prev[prev.length - 1];
                if (last && last.id === assistantMsgId) {
                  // Merge: prefer streamed text if final SDK message dropped it
                  const streamedText = last.content.filter((b) => b.type === 'text');
                  let merged: (TextBlock | ToolUseBlock)[];
                  if (!hasText && streamedText.length > 0) {
                    // Insert streamed text blocks before tool_use (like usePunk does)
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
                  // Only persist turns with visible text
                  if (merged.some((b) => b.type === 'text')) {
                    mindThreadAddTurn(threadId, 'assistant', JSON.stringify(updated)).catch(() => {});
                  }
                  return [...prev.slice(0, -1), updated];
                } else if (hasText && fallbackId) {
                  // No streaming happened — add final message directly
                  const msg: ConversationMessage = {
                    id: fallbackId,
                    type: 'assistant',
                    content: finalContent as ConversationMessage['content'],
                    timestamp: Date.now(),
                    isStreaming: false,
                  };
                  mindThreadAddTurn(threadId, 'assistant', JSON.stringify(msg)).catch(() => {});
                  return [...prev, msg];
                }
                return prev;
              });
              // Sync assistantMsgId after the updater — safe to mutate here
              if (!assistantMsgId && fallbackId) assistantMsgId = fallbackId;
              break;
            }

            // ── user — tool results (hide from UI, keep for context) ───────
            if (parsed.type === 'user') {
              const p = parsed as any;
              const content = (p.message?.content || p.content || []) as ToolResultBlock[];
              if (content.some((b) => b.type === 'tool_result')) {
                // Reset assistantMsgId — next assistant message is a new turn
                assistantMsgId = '';
              }
              break;
            }

            // ── result — session metadata, not content ─────────────────────
            if (parsed.type === 'result') {
              flushAll();
              // Mark last assistant message as done if somehow still streaming
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

            // ── Memory pipeline ───────────────────────────────────────────
            // Mirror what usePunk.ts does after processEnded:
            // extract preferences + index decisions/lessons into the brain.
            // Mind chat is cross-project so we use "mind" as the projectId.
            const turnText = `User: ${turnUserText.slice(0, 600)}\n\nAssistant: ${turnAssistantText.slice(0, 600)}`;
            if (turnText.length > 100) {
              extractPreferencesFromTurn(turnText).catch(() => {});
            }

            if (turnAssistantText.length > 20) {
              const now = Date.now();
              const memEvents: MemoryEvent[] = [];

              const decisionPatterns = [
                /(?:I'll|I will|Let's|Going to|chose|choosing|decided|using|switched to)\s+(.{10,150})/gi,
                /(?:instead of|rather than|over)\s+(.{10,100})/gi,
              ];
              const lessonPatterns = [
                /(?:the (?:issue|problem|bug|root cause) (?:was|is)[:\s]+)(.{10,200})/gi,
                /(?:the (?:key )?(?:insight|fix|solution|answer) (?:was|is)[:\s]+)(.{10,200})/gi,
                /(?:(?:discovered|realized|found out|learned|turns out)[:\s]+)(.{10,200})/gi,
                /(?:important(?:ly)?[:\s]+|note[:\s]+)(.{10,200})/gi,
              ];

              const seenDecisions = new Set<string>();
              for (const pattern of decisionPatterns) {
                pattern.lastIndex = 0;
                let match;
                while ((match = pattern.exec(turnAssistantText)) !== null) {
                  const d = match[1]?.trim();
                  if (d && d.length >= 10 && !seenDecisions.has(d)) {
                    seenDecisions.add(d);
                    memEvents.push({ type: 'decision', content: d.slice(0, 150), timestamp: now, source: 'auto' });
                  }
                  if (seenDecisions.size >= 3) break;
                }
                if (seenDecisions.size >= 3) break;
              }

              const seenLessons = new Set<string>();
              for (const pattern of lessonPatterns) {
                pattern.lastIndex = 0;
                let match;
                while ((match = pattern.exec(turnAssistantText)) !== null) {
                  const l = match[1]?.trim();
                  if (l && l.length >= 10 && !seenLessons.has(l.slice(0, 40).toLowerCase())) {
                    seenLessons.add(l.slice(0, 40).toLowerCase());
                    memEvents.push({ type: 'lesson', content: l.slice(0, 200), timestamp: now, source: 'auto' });
                  }
                  if (seenLessons.size >= 3) break;
                }
                if (seenLessons.size >= 3) break;
              }

              if (memEvents.length > 0) {
                recordMemoryEvents('mind', memEvents).catch(() => {});
                brainIndexEvents('mind', memEvents).catch(() => {});
              }
            }
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
        await sendToMind(
          threadId,
          effectivePrompt,
          workingDir,
          selectedModel,
          selectedModelProvider,
          selectedModelThinking,
          entryContent || '(no thought content)',
          handleEvent
        );
      } catch (err) {
        console.error('[mind] sendToMind failed:', err);
        setError(err instanceof Error ? err.message : 'Failed to send message');
        setIsProcessing(false);
      }
    },
    [entryId, workingDir, entryContent]
  );

  // Auto-send when first opening a fresh thread — fires after threadLoaded
  // transitions to true. Include entryContent directly in the message so the
  // model definitely sees the thought, regardless of system prompt timing.
  useEffect(() => {
    if (!entryId || !threadLoaded) return;
    if (messages.length > 0) return;
    if (autoSentRef.current) return;
    if (!entryContent?.trim()) return; // wait until content is available
    autoSentRef.current = true;
    const prompt = `Here is my thought:\n\n${entryContent.trim()}\n\nHelp me think through it — explore its implications, surface anything I might be missing, and be direct.`;
    sendMessage(prompt).catch((err) => {
      setError(err instanceof Error ? err.message : 'Failed to start');
    });
  // sendMessage is a stable useCallback per entryId
  }, [entryId, threadLoaded, entryContent, sendMessage]);

  const abortMessage = useCallback(() => {
    if (threadIdRef.current) {
      abortPunk('mind:' + threadIdRef.current).catch(() => {});
    }
  }, []);

  return { messages, isProcessing, error, sendMessage, abortMessage };
}
