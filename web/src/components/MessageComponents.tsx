import { useState } from 'react'
import type { ContentBlock, DisplayMessage } from '../types/message'
import { highlightText, formatDateTime } from '../utils/format'

// ============================================================================
// Tool Call Display - shows what Claude is invoking
// ============================================================================

interface ToolCallDisplayProps {
  name: string
  input: Record<string, unknown>
  searchQuery?: string
  highlightClass?: string
}

export function ToolCallDisplay({ name, input, highlightClass }: ToolCallDisplayProps) {
  const [isExpanded, setIsExpanded] = useState(false)

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
        <span className="tool-call-name">{name}</span>
        {!isExpanded && <span className="tool-call-preview">{getInputPreview()}</span>}
        <span className="tool-call-expand">{isExpanded ? '▲' : '▼'}</span>
      </div>
      {isExpanded && <pre className="tool-call-input">{formatInputForDisplay(input)}</pre>}
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
}

export function ToolResultDisplay({
  content,
  is_error,
  toolName,
  searchQuery,
  highlightClass
}: ToolResultDisplayProps) {
  const [isExpanded, setIsExpanded] = useState(false)
  const lines = content.split('\n')
  const previewLines = lines.slice(0, 3).join('\n')
  const hasMore = lines.length > 3 || content.length > 200

  return (
    <div className={`tool-result-block ${is_error ? 'error' : ''}${highlightClass || ''}`}>
      <div className="tool-result-header" onClick={() => setIsExpanded(!isExpanded)}>
        <span className="tool-result-arrow">←</span>
        <span className="tool-result-label">{is_error ? 'Error' : 'Result'}</span>
        {toolName && <span className="tool-result-from">from {toolName}</span>}
        <span className="tool-result-meta">{lines.length} lines</span>
        <span className="tool-result-icon">{is_error ? '✗' : '✓'}</span>
        <span className="tool-result-expand">{isExpanded ? '▲' : '▼'}</span>
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
}

export function HumanDisplay({ blocks, searchQuery, highlightClass }: HumanDisplayProps) {
  return (
    <div className={`message human${highlightClass || ''}`}>
      <div className="message-role">
        <span className="role-icon">❯</span> Human
      </div>
      <div className="message-content">
        {blocks.map((b, j) =>
          b.type === 'text' ? (
            <span key={j}>{searchQuery ? highlightText(b.content, searchQuery) : b.content}</span>
          ) : null
        )}
      </div>
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
}

export function AssistantDisplay({ blocks, searchQuery, highlightClass }: AssistantDisplayProps) {
  return (
    <div className={`message assistant${highlightClass || ''}`}>
      <div className="message-role">
        <span className="role-icon">◆</span> Assistant
      </div>
      <div className="message-content">
        {blocks.map((b, j) =>
          b.type === 'text' ? (
            <span key={j}>{searchQuery ? highlightText(b.content, searchQuery) : b.content}</span>
          ) : null
        )}
      </div>
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
}

export function MessageRow({ msg, searchQuery, isSearchMatch }: MessageRowProps) {
  if (!msg) {
    return <div className="message loading">Loading...</div>
  }

  const query = searchQuery || ''
  const highlightClass = isSearchMatch ? ' search-match' : ''

  switch (msg.displayType) {
    case 'human':
      return <HumanDisplay blocks={msg.blocks} searchQuery={query} highlightClass={highlightClass} />

    case 'assistant':
      return <AssistantDisplay blocks={msg.blocks} searchQuery={query} highlightClass={highlightClass} />

    case 'tool_call': {
      const block = msg.blocks[0]
      if (block?.type === 'tool_use') {
        return <ToolCallDisplay name={block.name} input={block.input} highlightClass={highlightClass} />
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
