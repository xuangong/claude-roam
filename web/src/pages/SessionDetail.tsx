import { useState, useEffect } from 'react'
import { Link, useParams } from 'react-router-dom'
import { getSessionDetail, pullSession, type SessionDetailResponse, type Segment } from '../api'

// Content block types for terminal display
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

// Display types for the terminal - clearer naming for LLM chatbot
type DisplayType = 'human' | 'assistant' | 'tool_call' | 'tool_result' | 'system'

interface DisplayMessage {
  displayType: DisplayType
  blocks: ContentBlock[]
  toolName?: string  // For tool_call and tool_result
  toolId?: string    // To link tool_call with tool_result
  raw?: Record<string, unknown>  // For system/other messages
}

// Store tool_use info to link with results
interface ToolUseInfo {
  id: string
  name: string
}

function parseMessages(data: string): DisplayMessage[] {
  const messages: DisplayMessage[] = []
  const lines = data.split('\n').filter(line => line.trim())

  // Track tool_use IDs to their names for linking with results
  const toolUseMap = new Map<string, ToolUseInfo>()

  for (const line of lines) {
    try {
      const obj = JSON.parse(line)
      const topType = obj.type as string

      // Skip internal types
      if (topType === 'file-history-snapshot' || topType === 'queue-operation') {
        continue
      }

      // Handle system messages (hooks, etc.)
      if (topType === 'system') {
        messages.push({
          displayType: 'system',
          blocks: [],
          raw: obj
        })
        continue
      }

      // Handle summary
      if (topType === 'summary') {
        messages.push({
          displayType: 'system',
          blocks: [{ type: 'text', content: `Summary: ${obj.summary || ''}` }],
          raw: obj
        })
        continue
      }

      // Handle user/assistant messages
      if ((topType === 'user' || topType === 'assistant') && obj.message) {
        const msg = obj.message
        const content = msg.content

        // Parse content blocks
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
              // Store for linking with results
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

        // Create display messages based on content types
        // User + text = Human
        if (topType === 'user' && textBlocks.length > 0) {
          messages.push({
            displayType: 'human',
            blocks: textBlocks
          })
        }

        // User + tool_result = Tool Result (with linked tool name)
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

        // Assistant + text = Assistant
        if (topType === 'assistant' && textBlocks.length > 0) {
          messages.push({
            displayType: 'assistant',
            blocks: textBlocks
          })
        }

        // Assistant + tool_use = Tool Call
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

// Tool call display - shows what Claude is invoking
function ToolCallDisplay({ name, input }: { name: string; input: Record<string, unknown> }) {
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
        // For strings, show the actual content (newlines rendered, not escaped)
        if (value.includes('\n') || value.length > 80) {
          // Multi-line string: show as block
          lines.push(`${keyStr}`)
          lines.push(`${spaces}    \`\`\``)
          lines.push(value)
          lines.push(`${spaces}    \`\`\`${comma}`)
        } else {
          // Short string: show inline
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

  // Get a preview of the most relevant input parameter
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
      <div
        className="tool-call-header"
        onClick={() => setIsExpanded(!isExpanded)}
      >
        <span className="tool-call-arrow">→</span>
        <span className="tool-call-label">Tool Call</span>
        <span className="tool-call-name">{name}</span>
        {preview && !isExpanded && (
          <span className="tool-call-preview">{preview}</span>
        )}
        <span className="tool-call-expand">{isExpanded ? '▲' : '▼'}</span>
      </div>
      {isExpanded && (
        <pre className="tool-call-input">{inputStr}</pre>
      )}
    </div>
  )
}

// Tool result display - shows what the tool returned (collapsed by default)
function ToolResultDisplay({
  content,
  is_error,
  toolName
}: {
  content: string
  is_error?: boolean
  toolName?: string
}) {
  const [isExpanded, setIsExpanded] = useState(false)
  const lines = content.split('\n')
  const previewLines = lines.slice(0, 3).join('\n')
  const hasMore = lines.length > 3 || content.length > 200

  return (
    <div className={`tool-result-block ${is_error ? 'error' : ''}`}>
      <div
        className="tool-result-header"
        onClick={() => setIsExpanded(!isExpanded)}
        style={{ cursor: 'pointer' }}
      >
        <span className="tool-result-arrow">←</span>
        <span className="tool-result-label">
          {is_error ? 'Error' : 'Result'}
        </span>
        {toolName && (
          <span className="tool-result-from">from {toolName}</span>
        )}
        <span className="tool-result-meta">
          {lines.length} lines
        </span>
        <span className="tool-result-icon">{is_error ? '✗' : '✓'}</span>
        <span className="tool-result-expand">{isExpanded ? '▲' : '▼'}</span>
      </div>
      {isExpanded && (
        <pre className="tool-content">{content}</pre>
      )}
      {!isExpanded && hasMore && (
        <pre className="tool-content tool-content-preview">{previewLines}...</pre>
      )}
      {!isExpanded && !hasMore && (
        <pre className="tool-content tool-content-preview">{content}</pre>
      )}
    </div>
  )
}

// System message display (collapsed by default)
function SystemDisplay({ raw }: { raw?: Record<string, unknown> }) {
  const [isExpanded, setIsExpanded] = useState(false)
  const subtype = (raw?.subtype as string) || (raw?.type as string) || 'system'

  return (
    <div className="system-block">
      <div
        className="system-block-header"
        onClick={() => setIsExpanded(!isExpanded)}
      >
        <span className="system-block-icon">⚙</span>
        <span className="system-block-label">System</span>
        <span className="system-block-subtype">{subtype}</span>
        <span className="system-block-expand">{isExpanded ? '▲' : '▼'}</span>
      </div>
      {isExpanded && raw && (
        <pre className="system-block-content">
          {JSON.stringify(raw, null, 2)}
        </pre>
      )}
    </div>
  )
}

function SessionDetail() {
  const { id } = useParams<{ id: string }>()
  const [detail, setDetail] = useState<SessionDetailResponse | null>(null)
  const [messages, setMessages] = useState<DisplayMessage[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!id) return

    async function fetchData() {
      try {
        setLoading(true)
        setError(null)
        const [detailResp, pullResp] = await Promise.all([
          getSessionDetail(id!),
          pullSession(id!)
        ])
        setDetail(detailResp)
        setMessages(parseMessages(pullResp.data))
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load session')
      } finally {
        setLoading(false)
      }
    }

    fetchData()
  }, [id])

  if (loading) {
    return (
      <div className="detail-page">
        <Link to="/" className="back-link">Back to sessions</Link>
        <div className="loading">Loading session</div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="detail-page">
        <Link to="/" className="back-link">Back to sessions</Link>
        <div className="error">ERROR: {error}</div>
      </div>
    )
  }

  if (!detail) {
    return null
  }

  return (
    <div className="detail-page">
      <Link to="/" className="back-link">Back to sessions</Link>

      <div className="detail-header">
        <h1>{detail.session.session_id}</h1>
        <div className="detail-meta">
          <span>{detail.session.total_lines} lines</span>
          <span>Created: {formatDateTime(detail.session.created_at)}</span>
          <span>Updated: {formatDateTime(detail.session.updated_at)}</span>
        </div>
      </div>

      <div className="section">
        <h2>Source History</h2>
        <table className="segments-table">
          <thead>
            <tr>
              <th>Lines</th>
              <th>Machine</th>
              <th>Path</th>
              <th>Pushed</th>
            </tr>
          </thead>
          <tbody>
            {detail.segments.map((seg: Segment) => (
              <tr key={seg.id}>
                <td>{seg.from_line}–{seg.to_line}</td>
                <td>{seg.machine_name || seg.machine_id.slice(0, 8)}</td>
                <td style={{ maxWidth: '300px', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {seg.original_path || '—'}
                </td>
                <td>{formatDateTime(seg.pushed_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="section">
        <h2>Conversation</h2>
        <div className="conversation-flow">
          {messages.length === 0 ? (
            <div className="empty-conversation">
              No conversation data to display
            </div>
          ) : (
            messages.map((msg, i) => {
              // Human message - user input text
              if (msg.displayType === 'human') {
                return (
                  <div key={i} className="message human">
                    <div className="message-role">
                      <span className="role-icon">❯</span> Human
                    </div>
                    <div className="message-content">
                      {msg.blocks.map((b, j) => (
                        b.type === 'text' ? <span key={j}>{b.content}</span> : null
                      ))}
                    </div>
                  </div>
                )
              }

              // Assistant message - Claude's text response
              if (msg.displayType === 'assistant') {
                return (
                  <div key={i} className="message assistant">
                    <div className="message-role">
                      <span className="role-icon">◆</span> Assistant
                    </div>
                    <div className="message-content">
                      {msg.blocks.map((b, j) => (
                        b.type === 'text' ? <span key={j}>{b.content}</span> : null
                      ))}
                    </div>
                  </div>
                )
              }

              // Tool call - Claude invoking a tool
              if (msg.displayType === 'tool_call') {
                const block = msg.blocks[0]
                if (block?.type === 'tool_use') {
                  return <ToolCallDisplay key={i} name={block.name} input={block.input} />
                }
              }

              // Tool result - Result returned from tool
              if (msg.displayType === 'tool_result') {
                const block = msg.blocks[0]
                if (block?.type === 'tool_result') {
                  return (
                    <ToolResultDisplay
                      key={i}
                      content={block.content}
                      is_error={block.is_error}
                      toolName={msg.toolName}
                    />
                  )
                }
              }

              // System messages - collapsed by default
              if (msg.displayType === 'system') {
                return <SystemDisplay key={i} raw={msg.raw} />
              }

              return null
            })
          )}
        </div>
      </div>
    </div>
  )
}

export default SessionDetail
