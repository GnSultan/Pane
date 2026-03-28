import { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import { useMindChat } from '../../hooks/useMindChat'
import { MessageBubble } from './MessageBubble'
import type { ToolResultBlock } from '../../lib/punk-types'
import { measureCaretPos } from '../../lib/measure-caret'

interface MindChatProps {
  entryId: string
  entryContent?: string
  workingDir: string
  onClose: () => void
  isFreeform?: boolean
}

export function MindChat({
  entryId,
  entryContent,
  workingDir,
  onClose,
  isFreeform = false,
}: MindChatProps) {
  const { messages, isProcessing, error, sendMessage, abortMessage } = useMindChat(
    entryId,
    workingDir,
    entryContent || ""
  )

  const [draft, setDraft] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const caretContainerRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const [textareaFocused, setTextareaFocused] = useState(false)
  const [caretPos, setCaretPos] = useState<{ top: number; left: number; lineHeight: number } | null>(null)

  // Build toolResultMap from system messages
  const toolResultMap = useMemo(() => {
    const map = new Map<string, ToolResultBlock>()
    for (const msg of messages) {
      if (msg.type === 'system') {
        for (const block of msg.content) {
          if (block.type === 'tool_result') {
            map.set((block as ToolResultBlock).tool_use_id, block as ToolResultBlock)
          }
        }
      }
    }
    return map
  }, [messages])

  // Reset scroll to top when switching entries — prevents stale scroll position
  // from previous thread making the new thread appear mid-conversation
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0
    followRef.current = true
  }, [entryId])

  // Follow scroll while streaming — rAF loop with double-rAF to ensure scroll
  // runs after React's paint, not before (prevents empty-space on fast scroll).
  const followRef = useRef(true)
  const rafRef = useRef(0)
  useEffect(() => {
    if (!isProcessing) {
      cancelAnimationFrame(rafRef.current)
      return
    }
    const tick = () => {
      if (followRef.current && scrollRef.current) {
        scrollRef.current.scrollTop = scrollRef.current.scrollHeight
      }
      rafRef.current = requestAnimationFrame(() => requestAnimationFrame(tick))
    }
    rafRef.current = requestAnimationFrame(() => requestAnimationFrame(tick))
    return () => cancelAnimationFrame(rafRef.current)
  }, [isProcessing])

  const handleScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    followRef.current = atBottom
  }, [])

  // Textarea auto-resize
  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, window.innerHeight * 0.35) + 'px'
  }, [draft])

  // Caret position
  const updateCaret = useCallback(() => {
    const el = textareaRef.current
    const container = caretContainerRef.current
    if (!el || !container || document.activeElement !== el) {
      setCaretPos(null)
      return
    }
    setCaretPos(measureCaretPos(el, container))
  }, [])

  const handleSubmit = useCallback(() => {
    if (draft.trim() && !isProcessing) {
      followRef.current = true
      sendMessage(draft.trim())
      setDraft('')
    }
  }, [draft, isProcessing, sendMessage])

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSubmit()
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    }
  }, [handleSubmit, onClose])

  const visibleMessages = messages.filter((m) => m.type !== 'system')
  const showThinking = isProcessing && !messages.some((m) => m.type === 'assistant' && m.isStreaming)

  return (
    <div className="relative h-full bg-pane-bg">

      {/* Title bar — shows chat context */}
      <div className="absolute top-0 left-0 right-0 z-20 px-10 py-4 border-b border-pane-border/20 bg-pane-bg/50 backdrop-blur-sm">
        <div className="flex items-center justify-between">
          <span className="font-mono text-pane-text-secondary/60" style={{ fontSize: 'var(--pane-font-size-sm)' }}>
            {isFreeform ? 'chat' : entryContent ? entryContent.split('\n')[0]?.slice(0, 50) || '' : ''}
          </span>
          <button
            onClick={onClose}
            className="font-mono text-pane-text-secondary/40 hover:text-pane-text-secondary/60 transition-colors"
            style={{ fontSize: 'var(--pane-font-size-xs)' }}
            title="Close (Esc)"
          >
            esc
          </button>
        </div>
      </div>

      {/* Scroll area — mirrors Conversation layout exactly */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="absolute inset-0 overflow-x-hidden overflow-y-auto px-10 pb-48 pt-24 custom-scrollbar [overflow-anchor:none]"
      >
        {/* Empty state while first response loads */}
        {visibleMessages.length === 0 && !showThinking && (
          <div className="flex items-center justify-center h-full select-none">
            <span
              className="text-pane-text-secondary/25 font-mono tracking-[0.25em] uppercase"
              style={{ fontSize: 'var(--pane-font-size-sm)' }}
            >
              thinking
            </span>
          </div>
        )}

        {visibleMessages.map((msg) => (
          <div key={msg.id}>
            {msg.punkType && (
              <p
                className="font-mono mb-1 select-none"
                style={{ fontSize: 'var(--pane-font-size-xs)', color: 'var(--pane-terminal)', opacity: 0.7 }}
              >
                {msg.punkType === 'bug' ? 'bug analysis'
                  : msg.punkType === 'reflection' ? 'reflection'
                  : msg.punkType === 'sentinel' ? 'sentinel'
                  : msg.punkType}
              </p>
            )}
            <MessageBubble
              message={msg}
              toolResults={toolResultMap}
              projectId={isFreeform ? 'mind:freeform' : 'mind:' + entryId}
            />
          </div>
        ))}

        {/* Thinking dots — processing but no streamed response yet */}
        {showThinking && (
          <div className="flex items-center gap-1.5 py-3 mb-4">
            <span className="w-1 h-1 rounded-full bg-pane-terminal/50 animate-pulse" style={{ animationDelay: '0ms' }} />
            <span className="w-1 h-1 rounded-full bg-pane-terminal/50 animate-pulse" style={{ animationDelay: '150ms' }} />
            <span className="w-1 h-1 rounded-full bg-pane-terminal/50 animate-pulse" style={{ animationDelay: '300ms' }} />
          </div>
        )}
      </div>

      {/* Error — floating toast, same pattern as Conversation */}
      {error && (
        <div className="absolute bottom-36 left-1/2 -translate-x-1/2 z-40 w-[min(480px,80%)] pointer-events-none">
          <div className="font-mono text-pane-error bg-pane-bg/90 backdrop-blur-md ring-1 ring-pane-border/40 px-3 py-2 rounded-lg leading-[1.6]"
            style={{ fontSize: '10px' }}>
            {error}
          </div>
        </div>
      )}

      {/* Input — pinned to bottom, edge-to-edge, same as Conversation's InputBar */}
      <div className="absolute bottom-0 left-0 right-0 z-30">
        <div className="bg-pane-bg rounded-xl ring-1 ring-pane-border/40 relative">
          <div ref={caretContainerRef} className="relative overflow-hidden">
            <textarea
              ref={textareaRef}
              value={draft}
              onChange={(e) => { setDraft(e.target.value); updateCaret() }}
              onKeyDown={handleKeyDown}
              onFocus={() => { setTextareaFocused(true); updateCaret() }}
              onBlur={() => { setTextareaFocused(false); setCaretPos(null) }}
              onSelect={updateCaret}
              onMouseUp={updateCaret}
              placeholder={isProcessing ? '' : 'follow up...'}
              className="w-full bg-transparent text-pane-text font-mono resize-none outline-none placeholder:text-pane-text-secondary leading-[1.75] px-5 pt-4 overflow-y-auto overflow-x-hidden"
              style={{
                fontSize: 'var(--pane-font-size)',
                caretColor: 'transparent',
                minHeight: '120px',
                maxHeight: '40vh',
                height: '120px',
                paddingBottom: '44px',
              }}
            />
            {textareaFocused && caretPos && (
              <div
                aria-hidden
                style={{
                  position: 'absolute',
                  top: caretPos.top,
                  left: caretPos.left,
                  width: 2,
                  height: caretPos.lineHeight,
                  background: 'var(--pane-editor-cursor)',
                  pointerEvents: 'none',
                }}
              />
            )}
          </div>

          {/* Send — top right, identical to InputBar */}
          {draft.trim().length > 0 && (
            <button
              onClick={handleSubmit}
              className="absolute top-1.5 right-1.5 z-10 w-9 h-9 flex items-center justify-center rounded-lg text-pane-text-secondary hover:text-pane-text hover:bg-pane-text/[0.06] transition-all duration-150 btn-press ring-1 ring-pane-border/40"
              title="Send (Enter)"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="m5 9 7-7 7 7" /><path d="M12 16V2" /><circle cx="12" cy="21" r="1" />
              </svg>
            </button>
          )}

          {/* Bottom bar — same pattern as InputBar */}
          <div
            className="absolute bottom-0 left-0 right-0 flex items-center gap-2 p-1.5 font-mono pointer-events-none"
            style={{ fontSize: 'var(--pane-font-size-xs)' }}
          >
            {isProcessing ? (
              <button
                onClick={abortMessage}
                className="pointer-events-auto text-pane-error font-mono hover:text-pane-error/80 btn-press"
                style={{ fontSize: 'var(--pane-font-size-sm)' }}
              >
                stop
              </button>
            ) : (
              <button
                onClick={onClose}
                className="pointer-events-auto inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-pane-bg/70 backdrop-blur-sm ring-1 ring-pane-border/25 text-pane-text-secondary/50 hover:text-pane-text-secondary btn-press transition-colors"
              >
                back
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
