import { useState, useRef, useEffect, useCallback } from 'react'

// Roam bundle types
export interface RoamSession {
  id: string
  lineCount: number
  modifiedAt: string
  data: string
}

export interface RoamBundleV1 {
  version: 1
  exportedAt: string
  source: {
    machineId: string
    machineName: string
    originalPath: string
  }
  session: {
    id: string
    lineCount: number
    modifiedAt: string
  }
  data: string
}

export interface RoamBundleV2 {
  version: 2
  exportedAt: string
  source: {
    machineId: string
    machineName: string
    originalPath: string
  }
  sessions: RoamSession[]
}

export type RoamBundle = RoamBundleV1 | RoamBundleV2

// ========== Reuse message parsing and display from SessionDetail ==========
interface TextBlock {
  type: 'text'
  content: string
}

interface ToolUseBlock {
  type: 'tool_use'
  id: string
  name: string
  input: Record<string, unknown>
}

interface ToolResultBlock {
  type: 'tool_result'
  tool_use_id: string
  content: string
  is_error?: boolean
}

type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock
type DisplayType = 'human' | 'assistant' | 'tool_call' | 'tool_result' | 'system'

interface DisplayMessage {
  displayType: DisplayType
  blocks: ContentBlock[]
  toolName?: string
  toolId?: string
  raw?: Record<string, unknown>
}

interface ToolUseInfo {
  id: string
  name: string
}

function parseMessages(data: string): DisplayMessage[] {
  const messages: DisplayMessage[] = []
  const lines = data.split('\n').filter(line => line.trim())
  const toolUseMap = new Map<string, ToolUseInfo>()

  for (const line of lines) {
    try {
      const obj = JSON.parse(line)
      const topType = obj.type as string

      if (topType === 'file-history-snapshot' || topType === 'queue-operation') continue

      if (topType === 'system') {
        messages.push({ displayType: 'system', blocks: [], raw: obj })
        continue
      }

      if (topType === 'summary') {
        messages.push({
          displayType: 'system',
          blocks: [{ type: 'text', content: `Summary: ${obj.summary || ''}` }],
          raw: obj
        })
        continue
      }

      if ((topType === 'user' || topType === 'assistant') && obj.message) {
        const msg = obj.message
        const content = msg.content

        const textBlocks: ContentBlock[] = []
        const toolUseBlocks: ContentBlock[] = []
        const toolResultBlocks: ContentBlock[] = []

        if (typeof content === 'string') {
          if (content.trim()) {
            textBlocks.push({ type: 'text', content })
          }
        } else if (Array.isArray(content)) {
          for (const item of content) {
            if (item.type === 'text' && item.text) {
              textBlocks.push({ type: 'text', content: item.text })
            } else if (item.type === 'tool_use') {
              const toolId = item.id || ''
              const toolName = item.name || 'unknown_tool'
              toolUseMap.set(toolId, { id: toolId, name: toolName })
              toolUseBlocks.push({
                type: 'tool_use',
                id: toolId,
                name: toolName,
                input: item.input || {}
              })
            } else if (item.type === 'tool_result') {
              let resultContent = ''
              if (typeof item.content === 'string') {
                resultContent = item.content
              } else if (Array.isArray(item.content)) {
                resultContent = item.content
                  .map((c: { type?: string; text?: string }) => c.text || '')
                  .join('\n')
              } else if (item.content) {
                resultContent = JSON.stringify(item.content, null, 2)
              }
              toolResultBlocks.push({
                type: 'tool_result',
                tool_use_id: item.tool_use_id || '',
                content: resultContent,
                is_error: item.is_error
              })
            }
          }
        }

        if (topType === 'user' && textBlocks.length > 0) {
          messages.push({ displayType: 'human', blocks: textBlocks })
        }

        if (topType === 'user' && toolResultBlocks.length > 0) {
          for (const block of toolResultBlocks) {
            if (block.type === 'tool_result') {
              const toolInfo = toolUseMap.get(block.tool_use_id)
              messages.push({
                displayType: 'tool_result',
                blocks: [block],
                toolName: toolInfo?.name || 'unknown',
                toolId: block.tool_use_id
              })
            }
          }
        }

        if (topType === 'assistant' && textBlocks.length > 0) {
          messages.push({ displayType: 'assistant', blocks: textBlocks })
        }

        if (topType === 'assistant' && toolUseBlocks.length > 0) {
          for (const block of toolUseBlocks) {
            if (block.type === 'tool_use') {
              messages.push({
                displayType: 'tool_call',
                blocks: [block],
                toolName: block.name,
                toolId: block.id
              })
            }
          }
        }
      }
    } catch {
      // Skip invalid lines
    }
  }

  return messages
}

function formatDateTime(dateStr: string): string {
  const date = new Date(dateStr)
  return date.toLocaleString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  })
}

// ========== Tool display components (same as SessionDetail) ==========
function ToolCallDisplay({ name, input }: { name: string; input: Record<string, unknown> }) {
  const [isExpanded, setIsExpanded] = useState(false)

  const formatInputForDisplay = (obj: Record<string, unknown>, indent = 0): string => {
    const spaces = '  '.repeat(indent)
    const lines: string[] = ['{']
    const entries = Object.entries(obj)

    entries.forEach(([key, value], idx) => {
      const comma = idx < entries.length - 1 ? ',' : ''
      const keyStr = `${spaces}  "${key}": `

      if (typeof value === 'string') {
        if (value.includes('\n') || value.length > 80) {
          lines.push(`${keyStr}`)
          lines.push(`${spaces}    \`\`\``)
          lines.push(value)
          lines.push(`${spaces}    \`\`\`${comma}`)
        } else {
          lines.push(`${keyStr}"${value}"${comma}`)
        }
      } else if (value === null) {
        lines.push(`${keyStr}null${comma}`)
      } else if (typeof value === 'boolean' || typeof value === 'number') {
        lines.push(`${keyStr}${value}${comma}`)
      } else if (Array.isArray(value)) {
        lines.push(`${keyStr}${JSON.stringify(value, null, 2).split('\n').join('\n' + spaces + '  ')}${comma}`)
      } else if (typeof value === 'object') {
        lines.push(`${keyStr}${JSON.stringify(value, null, 2).split('\n').join('\n' + spaces + '  ')}${comma}`)
      } else {
        lines.push(`${keyStr}${JSON.stringify(value)}${comma}`)
      }
    })

    lines.push(`${spaces}}`)
    return lines.join('\n')
  }

  const inputStr = formatInputForDisplay(input)

  const getInputPreview = () => {
    if (input.command) return String(input.command).slice(0, 60).replace(/\n/g, ' ')
    if (input.file_path) return String(input.file_path)
    if (input.pattern) return `pattern: ${input.pattern}`
    if (input.query) return String(input.query).slice(0, 60).replace(/\n/g, ' ')
    if (input.content) return `${String(input.content).slice(0, 40).replace(/\n/g, ' ')}...`
    if (input.prompt) return String(input.prompt).slice(0, 60).replace(/\n/g, ' ')
    const firstKey = Object.keys(input)[0]
    if (firstKey) {
      const val = String(input[firstKey]).slice(0, 50).replace(/\n/g, ' ')
      return `${firstKey}: ${val}`
    }
    return ''
  }

  const preview = getInputPreview()

  return (
    <div className="tool-call-block">
      <div className="tool-call-header" onClick={() => setIsExpanded(!isExpanded)}>
        <span className="tool-call-arrow">→</span>
        <span className="tool-call-label">Tool Call</span>
        <span className="tool-call-name">{name}</span>
        {preview && !isExpanded && <span className="tool-call-preview">{preview}</span>}
        <span className="tool-call-expand">{isExpanded ? '▲' : '▼'}</span>
      </div>
      {isExpanded && <pre className="tool-call-input">{inputStr}</pre>}
    </div>
  )
}

function ToolResultDisplay({ content, is_error, toolName }: { content: string; is_error?: boolean; toolName?: string }) {
  const [isExpanded, setIsExpanded] = useState(false)
  const lines = content.split('\n')
  const previewLines = lines.slice(0, 3).join('\n')
  const hasMore = lines.length > 3 || content.length > 200

  return (
    <div className={`tool-result-block ${is_error ? 'error' : ''}`}>
      <div className="tool-result-header" onClick={() => setIsExpanded(!isExpanded)} style={{ cursor: 'pointer' }}>
        <span className="tool-result-arrow">←</span>
        <span className="tool-result-label">{is_error ? 'Error' : 'Result'}</span>
        {toolName && <span className="tool-result-from">from {toolName}</span>}
        <span className="tool-result-meta">{lines.length} lines</span>
        <span className="tool-result-icon">{is_error ? '✗' : '✓'}</span>
        <span className="tool-result-expand">{isExpanded ? '▲' : '▼'}</span>
      </div>
      {isExpanded && <pre className="tool-content">{content}</pre>}
      {!isExpanded && hasMore && <pre className="tool-content tool-content-preview">{previewLines}...</pre>}
      {!isExpanded && !hasMore && <pre className="tool-content tool-content-preview">{content}</pre>}
    </div>
  )
}

function SystemDisplay({ raw }: { raw?: Record<string, unknown> }) {
  const [isExpanded, setIsExpanded] = useState(false)
  const subtype = (raw?.subtype as string) || (raw?.type as string) || 'system'

  return (
    <div className="system-block">
      <div className="system-block-header" onClick={() => setIsExpanded(!isExpanded)}>
        <span className="system-block-icon">⚙</span>
        <span className="system-block-label">System</span>
        <span className="system-block-subtype">{subtype}</span>
        <span className="system-block-expand">{isExpanded ? '▲' : '▼'}</span>
      </div>
      {isExpanded && raw && <pre className="system-block-content">{JSON.stringify(raw, null, 2)}</pre>}
    </div>
  )
}

// ========== MiniMap component (same as SessionDetail) ==========
interface MiniMapItem {
  type: DisplayType
  index: number
  heightRatio: number
}

function MiniMap({
  items,
  visibleStart,
  visibleEnd,
  onNavigate
}: {
  items: MiniMapItem[]
  visibleStart: number
  visibleEnd: number
  onNavigate: (ratio: number) => void
}) {
  const minimapRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const isDragging = useRef(false)
  const isResizing = useRef(false)
  const isMoving = useRef(false)
  const dragOffset = useRef({ x: 0, y: 0 })
  const [, forceUpdate] = useState(0)

  const [position, setPosition] = useState(() => {
    const saved = localStorage.getItem('minimap-position')
    return saved ? JSON.parse(saved) : { top: 200, right: 24 }
  })
  const [height, setHeight] = useState(() => {
    const saved = localStorage.getItem('minimap-height')
    return saved ? parseInt(saved) : 500
  })

  useEffect(() => {
    localStorage.setItem('minimap-position', JSON.stringify(position))
  }, [position])

  useEffect(() => {
    localStorage.setItem('minimap-height', String(height))
  }, [height])

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    const target = e.target as HTMLElement
    if (target.classList.contains('minimap-resize-handle')) {
      isResizing.current = true
      e.preventDefault()
      return
    }
    if (target.classList.contains('minimap-move-handle')) {
      isMoving.current = true
      if (minimapRef.current) {
        const rect = minimapRef.current.getBoundingClientRect()
        dragOffset.current = { x: e.clientX - rect.left, y: e.clientY - rect.top }
      }
      e.preventDefault()
      return
    }
    isDragging.current = true
    handleNavigateClick(e)
  }, [])

  const handleNavigateClick = useCallback((e: React.MouseEvent) => {
    if (!contentRef.current) return
    const rect = contentRef.current.getBoundingClientRect()
    const y = e.clientY - rect.top
    const ratio = Math.max(0, Math.min(1, y / rect.height))
    onNavigate(ratio)
  }, [onNavigate])

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (isResizing.current) {
      if (!minimapRef.current) return
      const rect = minimapRef.current.getBoundingClientRect()
      const newHeight = Math.max(100, Math.min(window.innerHeight - 50, e.clientY - rect.top))
      setHeight(newHeight)
      return
    }
    if (isMoving.current) {
      const newTop = e.clientY - dragOffset.current.y
      const newRight = window.innerWidth - e.clientX - (60 - dragOffset.current.x)
      setPosition({
        top: Math.max(50, Math.min(window.innerHeight - 200, newTop)),
        right: Math.max(10, Math.min(window.innerWidth - 100, newRight))
      })
      return
    }
    if (isDragging.current) {
      handleNavigateClick(e)
    }
  }, [handleNavigateClick])

  useEffect(() => {
    const handleGlobalMouseUp = () => {
      isDragging.current = false
      isResizing.current = false
      isMoving.current = false
    }
    const handleGlobalMouseMove = (e: MouseEvent) => {
      if (isResizing.current && minimapRef.current) {
        const rect = minimapRef.current.getBoundingClientRect()
        const newHeight = Math.max(100, Math.min(window.innerHeight - 50, e.clientY - rect.top))
        setHeight(newHeight)
      }
      if (isMoving.current) {
        const newTop = e.clientY - dragOffset.current.y
        const newRight = window.innerWidth - e.clientX - (60 - dragOffset.current.x)
        setPosition({
          top: Math.max(50, Math.min(window.innerHeight - 200, newTop)),
          right: Math.max(10, Math.min(window.innerWidth - 100, newRight))
        })
      }
    }
    window.addEventListener('mouseup', handleGlobalMouseUp)
    window.addEventListener('mousemove', handleGlobalMouseMove)
    return () => {
      window.removeEventListener('mouseup', handleGlobalMouseUp)
      window.removeEventListener('mousemove', handleGlobalMouseMove)
    }
  }, [])

  useEffect(() => {
    forceUpdate(n => n + 1)
  }, [height])

  const [contentRect, setContentRect] = useState({ top: 20, height: height - 40 })

  useEffect(() => {
    if (contentRef.current) {
      const updateRect = () => {
        const rect = contentRef.current?.getBoundingClientRect()
        const parentRect = minimapRef.current?.getBoundingClientRect()
        if (rect && parentRect) {
          setContentRect({ top: rect.top - parentRect.top, height: rect.height })
        }
      }
      updateRect()
      const observer = new ResizeObserver(updateRect)
      observer.observe(contentRef.current)
      return () => observer.disconnect()
    }
  }, [height, items])

  const viewportTop = contentRect.top + visibleStart * contentRect.height
  const viewportHeight = (visibleEnd - visibleStart) * contentRect.height

  return (
    <div
      className="minimap"
      ref={minimapRef}
      style={{ top: `${position.top}px`, right: `${position.right}px`, height: `${height}px`, maxHeight: 'none' }}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
    >
      <div className="minimap-move-handle" title="Drag to move">⋮⋮</div>
      <div className="minimap-content" ref={contentRef}>
        {items.map((item, i) => (
          <div key={i} className={`minimap-item minimap-${item.type}`} style={{ flex: `${item.heightRatio} 0 0` }} />
        ))}
      </div>
      <div className="minimap-viewport" style={{ top: `${viewportTop}px`, height: `${viewportHeight}px` }} />
      <div className="minimap-resize-handle" title="Drag to resize">═</div>
    </div>
  )
}

// ========== Session List View (similar to SessionList) ==========
function SessionListView({
  sessions,
  source,
  minLines,
  onMinLinesChange,
  onSelectSession
}: {
  sessions: RoamSession[]
  source: { machineName: string; originalPath: string }
  minLines: number
  onMinLinesChange: (n: number) => void
  onSelectSession: (s: RoamSession) => void
}) {
  const filteredSessions = sessions.filter(s => s.lineCount >= minLines)

  return (
    <>
      <div className="detail-header">
        <h1>Roam Preview</h1>
        <div className="detail-meta">
          <span>Source: {source.machineName}:{source.originalPath}</span>
          <span>{filteredSessions.length} of {sessions.length} sessions</span>
        </div>
      </div>

      <div className="section">
        <div className="filter-box" style={{ marginBottom: 'var(--space-4)' }}>
          <label htmlFor="minLines">Min lines:</label>
          <input
            id="minLines"
            type="number"
            min="0"
            value={minLines || ''}
            onChange={e => onMinLinesChange(parseInt(e.target.value) || 0)}
            placeholder="0"
          />
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
          {filteredSessions.map((s) => (
            <div
              key={s.id}
              className="session-card"
              onClick={() => onSelectSession(s)}
              style={{ cursor: 'pointer' }}
            >
              <div style={{ flex: 1 }}>
                <div className="session-id">{s.id}</div>
                <div className="session-meta">
                  <span>{s.lineCount} lines</span>
                  <span>{formatDateTime(s.modifiedAt)}</span>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </>
  )
}

// ========== Session Detail View (same rendering as SessionDetail) ==========
function SessionDetailView({
  session,
  source,
  onBack
}: {
  session: RoamSession
  source: { machineName: string; originalPath: string }
  onBack: () => void
}) {
  const [messages, setMessages] = useState<DisplayMessage[]>([])
  const conversationRef = useRef<HTMLDivElement>(null)
  const [visibleStart, setVisibleStart] = useState(0)
  const [visibleEnd, setVisibleEnd] = useState(1)
  const [minimapItems, setMinimapItems] = useState<MiniMapItem[]>([])

  useEffect(() => {
    setMessages(parseMessages(session.data))
  }, [session])

  // Measure actual message heights after render
  useEffect(() => {
    if (!conversationRef.current || messages.length === 0) return

    const measureHeights = () => {
      if (!conversationRef.current) return

      const container = conversationRef.current
      const children = container.children
      const containerTop = container.getBoundingClientRect().top + window.scrollY
      const totalHeight = container.scrollHeight

      if (totalHeight <= 0 || children.length === 0) return

      const items: MiniMapItem[] = []
      for (let i = 0; i < children.length && i < messages.length; i++) {
        const child = children[i] as HTMLElement
        const childRect = child.getBoundingClientRect()
        const childTop = childRect.top + window.scrollY - containerTop
        const nextChildTop = i < children.length - 1
          ? (children[i + 1] as HTMLElement).getBoundingClientRect().top + window.scrollY - containerTop
          : totalHeight
        const heightWithGap = nextChildTop - childTop
        const ratio = heightWithGap / totalHeight

        items.push({ type: messages[i].displayType, index: i, heightRatio: ratio })
      }
      setMinimapItems(items)
    }

    const timer = setTimeout(measureHeights, 100)
    const resizeObserver = new ResizeObserver(measureHeights)
    resizeObserver.observe(conversationRef.current)

    return () => {
      clearTimeout(timer)
      resizeObserver.disconnect()
    }
  }, [messages])

  const handleScroll = useCallback(() => {
    if (!conversationRef.current) return

    const rect = conversationRef.current.getBoundingClientRect()
    const conversationHeight = conversationRef.current.scrollHeight
    const viewportHeight = window.innerHeight

    if (conversationHeight <= 0) return

    const visibleTop = Math.max(0, -rect.top)
    const visibleBottom = Math.min(conversationHeight, Math.max(0, viewportHeight - rect.top))
    const startRatio = visibleTop / conversationHeight
    const endRatio = visibleBottom / conversationHeight

    setVisibleStart(Math.max(0, Math.min(1, startRatio)))
    setVisibleEnd(Math.max(0, Math.min(1, endRatio)))
  }, [])

  const handleMinimapNavigate = useCallback((ratio: number) => {
    if (!conversationRef.current) return

    const rect = conversationRef.current.getBoundingClientRect()
    const conversationHeight = conversationRef.current.scrollHeight
    const targetOffset = ratio * conversationHeight
    const currentTop = window.scrollY + rect.top
    const targetScroll = currentTop + targetOffset - window.innerHeight / 3

    window.scrollTo({ top: Math.max(0, targetScroll), behavior: 'auto' })
  }, [])

  useEffect(() => {
    window.addEventListener('scroll', handleScroll)
    window.addEventListener('resize', handleScroll)
    handleScroll()
    return () => {
      window.removeEventListener('scroll', handleScroll)
      window.removeEventListener('resize', handleScroll)
    }
  }, [handleScroll, messages])

  return (
    <>
      <button onClick={onBack} className="back-link" style={{ background: 'none', border: 'none', padding: 0 }}>
        Back to session list
      </button>

      <div className="detail-header">
        <h1>{session.id}</h1>
        <div className="detail-meta">
          <span>{session.lineCount} lines</span>
          <span>Modified: {formatDateTime(session.modifiedAt)}</span>
          <span>Source: {source.machineName}</span>
        </div>
      </div>

      <div className="section conversation-section">
        <h2>Conversation</h2>
        <div className="conversation-container">
          <div className="conversation-flow" ref={conversationRef}>
            {messages.length === 0 ? (
              <div className="empty-conversation">No conversation data to display</div>
            ) : (
              messages.map((msg, i) => {
                if (msg.displayType === 'human') {
                  return (
                    <div key={i} className="message human">
                      <div className="message-role"><span className="role-icon">❯</span> Human</div>
                      <div className="message-content">
                        {msg.blocks.map((b, j) => b.type === 'text' ? <span key={j}>{b.content}</span> : null)}
                      </div>
                    </div>
                  )
                }
                if (msg.displayType === 'assistant') {
                  return (
                    <div key={i} className="message assistant">
                      <div className="message-role"><span className="role-icon">◆</span> Assistant</div>
                      <div className="message-content">
                        {msg.blocks.map((b, j) => b.type === 'text' ? <span key={j}>{b.content}</span> : null)}
                      </div>
                    </div>
                  )
                }
                if (msg.displayType === 'tool_call') {
                  const block = msg.blocks[0]
                  if (block?.type === 'tool_use') {
                    return <ToolCallDisplay key={i} name={block.name} input={block.input} />
                  }
                }
                if (msg.displayType === 'tool_result') {
                  const block = msg.blocks[0]
                  if (block?.type === 'tool_result') {
                    return <ToolResultDisplay key={i} content={block.content} is_error={block.is_error} toolName={msg.toolName} />
                  }
                }
                if (msg.displayType === 'system') {
                  return <SystemDisplay key={i} raw={msg.raw} />
                }
                return null
              })
            )}
          </div>
          {messages.length > 0 && (
            <MiniMap
              items={minimapItems}
              visibleStart={visibleStart}
              visibleEnd={visibleEnd}
              onNavigate={handleMinimapNavigate}
            />
          )}
        </div>
      </div>
    </>
  )
}

// ========== Main RoamPreviewCore component ==========
interface RoamPreviewCoreProps {
  bundle: RoamBundle
  sessions: RoamSession[]
}

function RoamPreviewCore({ bundle, sessions }: RoamPreviewCoreProps) {
  const [selectedSession, setSelectedSession] = useState<RoamSession | null>(null)
  const [minLines, setMinLines] = useState(() => {
    const saved = localStorage.getItem('minLines')
    return saved ? parseInt(saved) : 0
  })

  useEffect(() => {
    localStorage.setItem('minLines', String(minLines))
  }, [minLines])

  // Viewing a specific session
  if (selectedSession) {
    return (
      <div className="detail-page">
        <SessionDetailView
          session={selectedSession}
          source={bundle.source}
          onBack={() => setSelectedSession(null)}
        />
      </div>
    )
  }

  // Session list view
  return (
    <div className="detail-page">
      <SessionListView
        sessions={sessions}
        source={bundle.source}
        minLines={minLines}
        onMinLinesChange={setMinLines}
        onSelectSession={setSelectedSession}
      />
    </div>
  )
}

export default RoamPreviewCore
