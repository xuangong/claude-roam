import { useState, useEffect, useRef, useCallback } from 'react'
import { Link, useParams } from 'react-router-dom'
import { getSessionDetail, pullSession, type SessionDetailResponse, type Segment } from '../api'
import { MiniMap, type MiniMapItem } from '../components/MiniMap'

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
type DisplayType = 'human' | 'assistant' | 'tool_call' | 'tool_result' | 'system' | 'tree-separator'

interface DisplayMessage {
  displayType: DisplayType
  blocks: ContentBlock[]
  toolName?: string  // For tool_call and tool_result
  toolId?: string    // To link tool_call with tool_result
  raw?: Record<string, unknown>  // For system/other messages
  // For tree-separator
  treeIndex?: number
  treeSummaryCount?: number
  treeTimestamp?: string
}

// Store tool_use info to link with results
interface ToolUseInfo {
  id: string
  name: string
}

// Raw message from JSONL (for tree building)
interface RawMessage {
  uuid?: string
  parentUuid?: string | null
  type: string
  timestamp?: string
  message?: {
    content: string | ContentItem[]
  }
  summary?: string
  leafUuid?: string
  treeIndex?: number
  treeSummaryCount?: number
  treeMessageCount?: number
}

interface ContentItem {
  type: string
  text?: string
  id?: string
  name?: string
  input?: Record<string, unknown>
  tool_use_id?: string
  content?: string | { text?: string }[]
  is_error?: boolean
}

// Build conversation tree and extract all conversation chains
function buildConversationTree(data: string): RawMessage[] {
  const lines = data.split('\n').filter(line => line.trim())
  const messageMap = new Map<string, RawMessage>()
  const summaries: RawMessage[] = []
  const childrenMap = new Map<string, string[]>()

  // Map from file-history-snapshot messageId to its inner snapshot.messageId
  // This is used to repair broken chains where parentUuid points to a snapshot
  const snapshotIdMap = new Map<string, string>()

  // First pass: parse all lines, collect snapshots and messages
  const parsedLines: Array<{ type: string; obj: Record<string, unknown> }> = []
  for (const line of lines) {
    try {
      const obj = JSON.parse(line) as Record<string, unknown>
      const type = obj.type as string

      // Collect file-history-snapshot mappings
      if (type === 'file-history-snapshot') {
        const messageId = obj.messageId as string
        const snapshot = obj.snapshot as { messageId?: string } | undefined
        if (messageId && snapshot?.messageId) {
          snapshotIdMap.set(messageId, snapshot.messageId)
        }
      }

      parsedLines.push({ type, obj })
    } catch {
      // Skip invalid lines
    }
  }

  // Second pass: build message map with repaired parentUuid
  for (const { type, obj } of parsedLines) {
    if (type === 'summary') {
      summaries.push(obj as unknown as RawMessage)
      continue
    }

    const uuid = obj.uuid as string | undefined
    if (uuid) {
      // Repair parentUuid if it points to a snapshot
      let parentUuid = obj.parentUuid as string | null | undefined
      if (parentUuid && snapshotIdMap.has(parentUuid)) {
        // Replace snapshot messageId with its inner messageId
        parentUuid = snapshotIdMap.get(parentUuid)!
        obj.parentUuid = parentUuid
      }

      messageMap.set(uuid, obj as unknown as RawMessage)

      // Track parent-child relationships
      const parentId = parentUuid || 'ROOT'
      if (!childrenMap.has(parentId)) {
        childrenMap.set(parentId, [])
      }
      childrenMap.get(parentId)!.push(uuid)
    }
  }

  // Helper: find root of a message (or the earliest reachable ancestor if chain is broken)
  const getRoot = (uuid: string): string | null => {
    let current = uuid
    let lastValid: string | null = null
    while (current && messageMap.has(current)) {
      lastValid = current
      const msg = messageMap.get(current)!
      if (!msg.parentUuid) return current
      // Check if parent exists in map - if not, this is effectively a root
      if (!messageMap.has(msg.parentUuid)) {
        return current
      }
      current = msg.parentUuid
    }
    return lastValid
  }

  // Helper: build chain from root to leaf
  const buildChain = (leafUuid: string): RawMessage[] => {
    const chain: RawMessage[] = []
    let current: string | null = leafUuid
    while (current) {
      const msg = messageMap.get(current)
      if (msg) {
        chain.unshift(msg)
        current = msg.parentUuid || null
      } else {
        break
      }
    }
    return chain
  }

  // Find all root nodes (messages with no parent)
  const rootUuids = childrenMap.get('ROOT') || []

  if (rootUuids.length === 0) {
    if (summaries.length > 0) {
      return summaries
    }
    return Array.from(messageMap.values())
  }

  // Find all leaf nodes (nodes with no children)
  const allUuids = new Set(messageMap.keys())
  const parentUuids = new Set<string>()
  for (const msg of messageMap.values()) {
    if (msg.parentUuid) {
      parentUuids.add(msg.parentUuid)
    }
  }
  const leafUuids = new Set<string>()
  for (const uuid of allUuids) {
    if (!parentUuids.has(uuid)) {
      leafUuids.add(uuid)
    }
  }

  // Group leaves by their root
  const leavesByRoot = new Map<string, string[]>()
  for (const leaf of leafUuids) {
    const root = getRoot(leaf)
    if (root) {
      if (!leavesByRoot.has(root)) {
        leavesByRoot.set(root, [])
      }
      leavesByRoot.get(root)!.push(leaf)
    }
  }

  // Group summaries by the root of their leafUuid
  const summariesByRoot = new Map<string, RawMessage[]>()
  const orphanedSummaries: RawMessage[] = []
  for (const summary of summaries) {
    if (summary.leafUuid) {
      const root = getRoot(summary.leafUuid)
      if (root) {
        if (!summariesByRoot.has(root)) {
          summariesByRoot.set(root, [])
        }
        summariesByRoot.get(root)!.push(summary)
      } else {
        orphanedSummaries.push(summary)
      }
    } else {
      orphanedSummaries.push(summary)
    }
  }

  // Collect all effective roots: both true roots (no parent) AND broken chain roots
  // (messages whose parent doesn't exist in the map)
  const allEffectiveRoots = new Set<string>(rootUuids)
  for (const root of leavesByRoot.keys()) {
    if (!allEffectiveRoots.has(root)) {
      allEffectiveRoots.add(root)
    }
  }

  // Sort roots by the timestamp of their most recent leaf
  const rootsWithLatestTime: [string, string][] = []
  for (const root of allEffectiveRoots) {
    const leaves = leavesByRoot.get(root) || []
    let latestTime = ''
    for (const leaf of leaves) {
      const msg = messageMap.get(leaf)
      if (msg?.timestamp && msg.timestamp > latestTime) {
        latestTime = msg.timestamp
      }
    }
    rootsWithLatestTime.push([root, latestTime])
  }
  rootsWithLatestTime.sort((a, b) => a[1].localeCompare(b[1]))

  // Build result
  const result: RawMessage[] = []
  const processedChainUuids = new Set<string>()
  let treeIndex = 0

  // First, add orphaned summaries
  if (orphanedSummaries.length > 0) {
    treeIndex++
    const separator: RawMessage = {
      type: 'tree-separator',
      treeIndex,
      treeSummaryCount: orphanedSummaries.length,
      treeMessageCount: 0,
      timestamp: ''
    }
    result.push(separator)
    for (const summary of orphanedSummaries) {
      result.push(summary)
    }
  }

  for (const [root] of rootsWithLatestTime) {
    const leaves = leavesByRoot.get(root) || []
    const treeSummaries = summariesByRoot.get(root) || []

    // Find the most recent leaf in this tree
    let currentLeaf: string | null = null
    let latestTimestamp = ''
    for (const leaf of leaves) {
      const msg = messageMap.get(leaf)
      if (msg?.timestamp && msg.timestamp > latestTimestamp) {
        latestTimestamp = msg.timestamp
        currentLeaf = leaf
      }
    }

    if (!currentLeaf) continue

    // Build the main chain
    const chain = buildChain(currentLeaf)
    const chainUuids = new Set(chain.map(m => m.uuid).filter(Boolean) as string[])

    // Count summaries not in main chain
    const branchSummaries = treeSummaries.filter(s => s.leafUuid && !chainUuids.has(s.leafUuid))

    // Add tree separator
    treeIndex++
    if (treeIndex > 1 || branchSummaries.length > 0 || rootsWithLatestTime.length > 1) {
      const separator: RawMessage = {
        type: 'tree-separator',
        treeIndex,
        treeSummaryCount: branchSummaries.length,
        treeMessageCount: chain.length,
        timestamp: latestTimestamp
      }
      result.push(separator)
    }

    // Add summaries for branches NOT in the main chain
    for (const summary of branchSummaries) {
      result.push(summary)
    }

    // Add the main chain
    for (const msg of chain) {
      if (msg.uuid && !processedChainUuids.has(msg.uuid)) {
        processedChainUuids.add(msg.uuid)
        result.push(msg)
      }
    }
  }

  return result
}

function parseMessages(data: string): DisplayMessage[] {
  const messages: DisplayMessage[] = []

  // Use tree building to get the correct conversation chain
  const rawMessages = buildConversationTree(data)

  // Track tool_use IDs to their names for linking with results
  const toolUseMap = new Map<string, ToolUseInfo>()

  for (const obj of rawMessages) {
    const topType = obj.type as string

    // Skip internal types
    if (topType === 'file-history-snapshot' || topType === 'queue-operation') {
      continue
    }

    // Handle tree-separator
    if (topType === 'tree-separator') {
      messages.push({
        displayType: 'tree-separator',
        blocks: [],
        treeIndex: obj.treeIndex,
        treeSummaryCount: obj.treeSummaryCount,
        treeTimestamp: obj.timestamp
      })
      continue
    }

    // Handle system messages (hooks, etc.)
    if (topType === 'system') {
      messages.push({
        displayType: 'system',
        blocks: [],
        raw: obj as unknown as Record<string, unknown>
      })
      continue
    }

    // Handle summary
    if (topType === 'summary') {
      messages.push({
        displayType: 'system',
        blocks: [{ type: 'text', content: `Summary: ${obj.summary || ''}` }],
        raw: obj as unknown as Record<string, unknown>
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

  // MiniMap state - track conversation area visibility
  const conversationRef = useRef<HTMLDivElement>(null)
  const [visibleStart, setVisibleStart] = useState(0) // 0-1, portion of conversation above viewport
  const [visibleEnd, setVisibleEnd] = useState(1)     // 0-1, portion of conversation visible end
  const [minimapItems, setMinimapItems] = useState<MiniMapItem[]>([])

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
      let sumRatio = 0
      for (let i = 0; i < children.length && i < messages.length; i++) {
        const child = children[i] as HTMLElement
        const childRect = child.getBoundingClientRect()
        const childTop = childRect.top + window.scrollY - containerTop

        // Calculate the ratio including the gap space after this element
        const nextChildTop = i < children.length - 1
          ? (children[i + 1] as HTMLElement).getBoundingClientRect().top + window.scrollY - containerTop
          : totalHeight
        const heightWithGap = nextChildTop - childTop
        const ratio = heightWithGap / totalHeight
        sumRatio += ratio

        const item: MiniMapItem = {
          type: messages[i].displayType,
          index: i,
          heightRatio: ratio
        }
        // Pass treeIndex for tree-separator items
        if (messages[i].displayType === 'tree-separator' && messages[i].treeIndex) {
          item.treeIndex = messages[i].treeIndex
        }
        items.push(item)
      }
      setMinimapItems(items)
    }

    // Measure after DOM settles
    const timer = setTimeout(measureHeights, 100)

    // Re-measure on resize
    const resizeObserver = new ResizeObserver(measureHeights)
    resizeObserver.observe(conversationRef.current)

    return () => {
      clearTimeout(timer)
      resizeObserver.disconnect()
    }
  }, [messages])

  // Handle scroll - calculate which portion of conversation is visible
  const handleScroll = useCallback(() => {
    if (!conversationRef.current) return

    const rect = conversationRef.current.getBoundingClientRect()
    // Use scrollHeight to match minimap item measurement
    const conversationHeight = conversationRef.current.scrollHeight
    const viewportHeight = window.innerHeight

    if (conversationHeight <= 0) return

    // rect.top: distance from viewport top to conversation top
    // When conversation top is above viewport: rect.top < 0
    // When conversation top is below viewport: rect.top > 0

    // visibleTop: how much of conversation is above the viewport (hidden at top)
    const visibleTop = Math.max(0, -rect.top)

    // visibleBottom: how far into conversation the viewport bottom reaches
    // viewportHeight - rect.top = distance from conversation top to viewport bottom
    const visibleBottom = Math.min(conversationHeight, Math.max(0, viewportHeight - rect.top))

    // Convert to ratios (0-1)
    const startRatio = visibleTop / conversationHeight
    const endRatio = visibleBottom / conversationHeight

    setVisibleStart(Math.max(0, Math.min(1, startRatio)))
    setVisibleEnd(Math.max(0, Math.min(1, endRatio)))
  }, [])

  // Navigate via minimap - scroll to show that portion of conversation
  const handleMinimapNavigate = useCallback((ratio: number) => {
    if (!conversationRef.current) return

    const rect = conversationRef.current.getBoundingClientRect()
    const conversationHeight = conversationRef.current.scrollHeight
    const targetOffset = ratio * conversationHeight

    // Calculate where to scroll the page
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

      <div className="section conversation-section">
        <h2>Conversation</h2>
        <div className="conversation-container">
          <div className="conversation-flow" ref={conversationRef}>
            {messages.length === 0 ? (
              <div className="empty-conversation">
                No conversation data to display
              </div>
            ) : (
              messages.map((msg, i) => {
                // Tree separator - shows conversation tree index
                if (msg.displayType === 'tree-separator') {
                  return (
                    <div key={i} className="tree-separator">
                      <div className="tree-separator-line" />
                      <div className="tree-separator-label">
                        Conversation {msg.treeIndex}
                        {msg.treeSummaryCount ? ` (${msg.treeSummaryCount} summarized branches)` : ''}
                      </div>
                      <div className="tree-separator-line" />
                    </div>
                  )
                }

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
    </div>
  )
}

export default SessionDetail
