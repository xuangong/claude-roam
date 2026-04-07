import { useState } from 'react'
import type { ContentBlock, DisplayMessage } from '../types/message'
import { highlightText, formatDateTime } from '../utils/format'

// ============================================================================
// Type Navigation - prev/next arrows for navigating same-type messages
// ============================================================================

interface TypeNavProps {
  messageIndex: number
  typeString: string
  typeChar: string
  onScrollToMessage: (index: number) => void
}

function TypeNav({ messageIndex, typeString, typeChar, onScrollToMessage }: TypeNavProps) {
  // Find previous message of same type
  let prevIdx = -1
  for (let i = messageIndex - 1; i >= 0; i--) {
    if (typeString[i] === typeChar) { prevIdx = i; break }
  }
  // Find next message of same type
  let nextIdx = -1
  for (let i = messageIndex + 1; i < typeString.length; i++) {
    if (typeString[i] === typeChar) { nextIdx = i; break }
  }

  return (
    <span className="type-nav">
      {prevIdx >= 0 && (
        <span className="type-nav-btn" onClick={(e) => { e.stopPropagation(); onScrollToMessage(prevIdx) }} title="Previous">&#9650;</span>
      )}
      {nextIdx >= 0 && (
        <span className="type-nav-btn" onClick={(e) => { e.stopPropagation(); onScrollToMessage(nextIdx) }} title="Next">&#9660;</span>
      )}
    </span>
  )
}

// ============================================================================
// Raw JSON Toggle - shows original unparsed message data
// ============================================================================

function RawButton({ active, onClick }: { active: boolean; onClick: () => void }) {
  return (
    <span
      className={`raw-toggle-btn ${active ? 'active' : ''}`}
      onClick={(e) => { e.stopPropagation(); onClick() }}
      title="Show raw JSON"
    >{ '{ }' }</span>
  )
}

function RawJsonBlock({ raw }: { raw: Record<string, unknown> }) {
  return <pre className="raw-json-view">{JSON.stringify(raw, null, 2)}</pre>
}

// ============================================================================
// Tool Call Display - shows what Claude is invoking
// ============================================================================

interface ToolCallDisplayProps {
  name: string
  input: Record<string, unknown>
  searchQuery?: string
  highlightClass?: string
  nav?: { messageIndex: number; typeString: string; onScrollToMessage: (index: number) => void }
  typeChar?: string
  rawData?: Record<string, unknown>
}

export function ToolCallDisplay({ name, input, highlightClass, nav, typeChar, rawData }: ToolCallDisplayProps) {
  const [isExpanded, setIsExpanded] = useState(false)
  const [showRaw, setShowRaw] = useState(false)

  // Custom JSON formatter that displays string values with actual newlines/tabs
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

  return (
    <div className={`tool-call-block${highlightClass || ''}`}>
      <div className="tool-call-header" onClick={() => setIsExpanded(!isExpanded)}>
        <span className="tool-call-arrow">→</span>
        <span className="tool-call-label">Tool Call</span>
        {nav && typeChar && <TypeNav messageIndex={nav.messageIndex} typeString={nav.typeString} typeChar={typeChar} onScrollToMessage={nav.onScrollToMessage} />}
        {rawData && <RawButton active={showRaw} onClick={() => setShowRaw(!showRaw)} />}
        <span className="tool-call-name">{name}</span>
        {!isExpanded && <span className="tool-call-preview">{getInputPreview()}</span>}
        <span className="tool-call-expand">{isExpanded ? '▲' : '▼'}</span>
      </div>
      {isExpanded && <pre className="tool-call-input">{formatInputForDisplay(input)}</pre>}
      {showRaw && rawData && <RawJsonBlock raw={rawData} />}
    </div>
  )
}

// ============================================================================
// Tool Result Display - shows what the tool returned
// ============================================================================

interface ToolResultDisplayProps {
  content: string
  is_error?: boolean
  toolName?: string
  searchQuery?: string
  highlightClass?: string
  nav?: { messageIndex: number; typeString: string; onScrollToMessage: (index: number) => void }
  typeChar?: string
  rawData?: Record<string, unknown>
}

export function ToolResultDisplay({
  content,
  is_error,
  toolName,
  searchQuery,
  highlightClass,
  nav,
  typeChar,
  rawData
}: ToolResultDisplayProps) {
  const [isExpanded, setIsExpanded] = useState(false)
  const [showRaw, setShowRaw] = useState(false)
  const lines = content.split('\n')
  const previewLines = lines.slice(0, 3).join('\n')
  const hasMore = lines.length > 3 || content.length > 200

  return (
    <div className={`tool-result-block ${is_error ? 'error' : ''}${highlightClass || ''}`}>
      <div className="tool-result-header" onClick={hasMore ? () => setIsExpanded(!isExpanded) : undefined} style={hasMore ? undefined : { cursor: 'default' }}>
        <span className="tool-result-arrow">←</span>
        <span className="tool-result-label">{is_error ? 'Error' : 'Result'}</span>
        {nav && typeChar && <TypeNav messageIndex={nav.messageIndex} typeString={nav.typeString} typeChar={typeChar} onScrollToMessage={nav.onScrollToMessage} />}
        {rawData && <RawButton active={showRaw} onClick={() => setShowRaw(!showRaw)} />}
        {toolName && <span className="tool-result-from">from {toolName}</span>}
        <span className="tool-result-meta">{lines.length} lines</span>
        <span className="tool-result-icon">{is_error ? '✗' : '✓'}</span>
        {hasMore && <span className="tool-result-expand">{isExpanded ? '▲' : '▼'}</span>}
      </div>
      {isExpanded && (
        <pre className="tool-content">
          {searchQuery ? highlightText(content, searchQuery) : content}
        </pre>
      )}
      {!isExpanded && hasMore && (
        <pre className="tool-content tool-content-preview">
          {searchQuery ? highlightText(previewLines + '...', searchQuery) : previewLines + '...'}
        </pre>
      )}
      {!isExpanded && !hasMore && (
        <pre className="tool-content tool-content-preview">
          {searchQuery ? highlightText(content, searchQuery) : content}
        </pre>
      )}
      {showRaw && rawData && <RawJsonBlock raw={rawData} />}
    </div>
  )
}

// ============================================================================
// System Display - shows system messages (collapsed by default)
// ============================================================================

interface SystemDisplayProps {
  blocks: ContentBlock[]
  searchQuery?: string
  raw?: Record<string, unknown>
}

export function SystemDisplay({ blocks, searchQuery, raw }: SystemDisplayProps) {
  const [isExpanded, setIsExpanded] = useState(false)
  const textContent = blocks.find(b => b.type === 'text')?.content
  const jsonContent = blocks.find(b => b.type === 'json')?.content
  const subtype = (raw?.subtype as string) || (raw?.type as string) || ''
  const hasContent = textContent || jsonContent || raw

  return (
    <div className="system-block">
      <div className="system-block-header" onClick={() => setIsExpanded(!isExpanded)}>
        <span className="system-block-icon">⚙</span>
        <span className="system-block-label">System</span>
        {subtype && <span className="system-block-subtype">{subtype}</span>}
        {hasContent && <span className="system-block-expand">{isExpanded ? '▲' : '▼'}</span>}
      </div>
      {isExpanded && hasContent && (
        <div className="system-block-content">
          {textContent && (
            <div style={{ marginBottom: (jsonContent || raw) ? 'var(--space-2)' : 0 }}>
              {searchQuery ? highlightText(textContent, searchQuery) : textContent}
            </div>
          )}
          {jsonContent && (
            <pre style={{ margin: 0, opacity: 0.7 }}>
              {jsonContent}
            </pre>
          )}
          {!jsonContent && raw && (
            <pre style={{ margin: 0, opacity: 0.7 }}>
              {JSON.stringify(raw, null, 2)}
            </pre>
          )}
        </div>
      )}
    </div>
  )
}

// ============================================================================
// Tree Separator Display - shows conversation tree boundaries
// ============================================================================

interface TreeSeparatorDisplayProps {
  treeIndex?: number
  treeSummaryCount?: number
  treeTimestamp?: string
}

export function TreeSeparatorDisplay({ treeIndex, treeSummaryCount, treeTimestamp }: TreeSeparatorDisplayProps) {
  const ts = treeTimestamp ? formatDateTime(treeTimestamp) : ''
  const summaryInfo = treeSummaryCount ? ` • ${treeSummaryCount} compacted` : ''

  return (
    <div className="tree-separator">
      <div className="tree-separator-line" />
      <div className="tree-separator-label">
        Conversation {treeIndex}{summaryInfo}{ts ? ` • ${ts}` : ''}
      </div>
      <div className="tree-separator-line" />
    </div>
  )
}

// ============================================================================
// Human Message Display
// ============================================================================

interface HumanDisplayProps {
  blocks: ContentBlock[]
  searchQuery?: string
  highlightClass?: string
  nav?: { messageIndex: number; typeString: string; onScrollToMessage: (index: number) => void }
  typeChar?: string
  rawData?: Record<string, unknown>
}

export function HumanDisplay({ blocks, searchQuery, highlightClass, nav, typeChar, rawData }: HumanDisplayProps) {
  const [showRaw, setShowRaw] = useState(false)
  return (
    <div className={`message human${highlightClass || ''}`}>
      <div className="message-role">
        <span className="role-icon">❯</span> Human
        {nav && typeChar && <TypeNav messageIndex={nav.messageIndex} typeString={nav.typeString} typeChar={typeChar} onScrollToMessage={nav.onScrollToMessage} />}
        {rawData && <RawButton active={showRaw} onClick={() => setShowRaw(!showRaw)} />}
      </div>
      <div className="message-content">
        {blocks.map((b, j) =>
          b.type === 'text' ? (
            <span key={j}>{searchQuery ? highlightText(b.content, searchQuery) : b.content}</span>
          ) : null
        )}
      </div>
      {showRaw && rawData && <RawJsonBlock raw={rawData} />}
    </div>
  )
}

// ============================================================================
// Assistant Message Display
// ============================================================================

interface AssistantDisplayProps {
  blocks: ContentBlock[]
  searchQuery?: string
  highlightClass?: string
  nav?: { messageIndex: number; typeString: string; onScrollToMessage: (index: number) => void }
  typeChar?: string
  rawData?: Record<string, unknown>
}

export function AssistantDisplay({ blocks, searchQuery, highlightClass, nav, typeChar, rawData }: AssistantDisplayProps) {
  const [showRaw, setShowRaw] = useState(false)
  return (
    <div className={`message assistant${highlightClass || ''}`}>
      <div className="message-role">
        <span className="role-icon">◆</span> Assistant
        {nav && typeChar && <TypeNav messageIndex={nav.messageIndex} typeString={nav.typeString} typeChar={typeChar} onScrollToMessage={nav.onScrollToMessage} />}
        {rawData && <RawButton active={showRaw} onClick={() => setShowRaw(!showRaw)} />}
      </div>
      <div className="message-content">
        {blocks.map((b, j) =>
          b.type === 'text' ? (
            <span key={j}>{searchQuery ? highlightText(b.content, searchQuery) : b.content}</span>
          ) : null
        )}
      </div>
      {showRaw && rawData && <RawJsonBlock raw={rawData} />}
    </div>
  )
}

// ============================================================================
// Unified Message Row Component
// ============================================================================

interface MessageRowProps {
  msg: DisplayMessage | null
  searchQuery?: string
  isSearchMatch?: boolean
  messageIndex?: number
  typeString?: string
  onScrollToMessage?: (index: number) => void
}

export function MessageRow({ msg, searchQuery, isSearchMatch, messageIndex, typeString, onScrollToMessage }: MessageRowProps) {
  if (!msg) {
    return <div className="message loading">Loading...</div>
  }

  const query = searchQuery || ''
  const highlightClass = isSearchMatch ? ' search-match' : ''
  const navProps = (messageIndex !== undefined && typeString && onScrollToMessage)
    ? { messageIndex, typeString, onScrollToMessage }
    : undefined
  const rawData = msg.raw

  switch (msg.displayType) {
    case 'human':
      return <HumanDisplay blocks={msg.blocks} searchQuery={query} highlightClass={highlightClass} nav={navProps} typeChar="h" rawData={rawData} />

    case 'assistant':
      return <AssistantDisplay blocks={msg.blocks} searchQuery={query} highlightClass={highlightClass} nav={navProps} typeChar="a" rawData={rawData} />

    case 'tool_call': {
      const block = msg.blocks[0]
      if (block?.type === 'tool_use') {
        return <ToolCallDisplay name={block.name} input={block.input} highlightClass={highlightClass} nav={navProps} typeChar="c" rawData={rawData} />
      }
      return null
    }

    case 'tool_result': {
      const block = msg.blocks[0]
      if (block?.type === 'tool_result') {
        return (
          <ToolResultDisplay
            content={block.content}
            is_error={block.is_error}
            toolName={msg.toolName}
            searchQuery={query}
            highlightClass={highlightClass}
            nav={navProps}
            typeChar="r"
            rawData={rawData}
          />
        )
      }
      return null
    }

    case 'tree-separator':
      return (
        <TreeSeparatorDisplay
          treeIndex={msg.treeIndex}
          treeSummaryCount={msg.treeSummaryCount}
          treeTimestamp={msg.treeTimestamp}
        />
      )

    case 'system':
      return <SystemDisplay blocks={msg.blocks} searchQuery={query} raw={msg.raw} />

    default:
      return null
  }
}
