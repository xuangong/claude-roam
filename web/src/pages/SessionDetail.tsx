import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useVirtualizer } from '@tanstack/react-virtual'
import { getSessionDetail, pullSession, type SessionDetailResponse, type Segment } from '../api'
import { MiniMap, type MiniMapItem } from '../components/MiniMap'
import { MessageRow } from '../components/MessageComponents'
import { FloatingSearch } from '../components/FloatingSearch'
import type { DisplayMessage, ContentBlock, RawMessage, ToolUseInfo } from '../types/message'
import { formatDateTime } from '../utils/format'

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
      const subtype = obj.subtype as string || ''
      const content = obj.content as string || ''
      let displayContent = ''

      if (subtype === 'compact_boundary') {
        displayContent = '[Compact Boundary] ' + content
      } else if (subtype === 'stop_hook_summary') {
        displayContent = '[Hook] ' + ((obj.stopReason as string) || content || 'hook executed')
      } else if (content) {
        displayContent = content
      }

      messages.push({
        displayType: 'system',
        blocks: displayContent ? [{ type: 'text', content: displayContent }] : [],
        raw: obj as unknown as Record<string, unknown>
      })
      continue
    }

    // Handle summary
    if (topType === 'summary') {
      messages.push({
        displayType: 'system',
        blocks: [{ type: 'text', content: `[Compacted] ${obj.summary || ''}` }],
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

function SessionDetail() {
  const { id } = useParams<{ id: string }>()
  const [detail, setDetail] = useState<SessionDetailResponse | null>(null)
  const [messages, setMessages] = useState<DisplayMessage[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Virtual scroll state
  const parentRef = useRef<HTMLDivElement>(null)
  const [visibleStart, setVisibleStart] = useState(0)
  const [visibleEnd, setVisibleEnd] = useState(1)

  // Search state
  const [searchQuery, setSearchQuery] = useState('')
  const [currentSearchIndex, setCurrentSearchIndex] = useState(-1)
  const [showSearch, setShowSearch] = useState(false)

  // Handle keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
        e.preventDefault()
        setShowSearch(true)
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [])

  // Virtual list setup
  const virtualizer = useVirtualizer({
    count: messages.length,
    getScrollElement: () => parentRef.current,
    estimateSize: useCallback((index: number) => {
      const msg = messages[index]
      if (!msg) return 80
      switch (msg.displayType) {
        case 'tree-separator': return 40
        case 'human': return 100
        case 'assistant': return 150
        case 'tool_call': return 60
        case 'tool_result': return 80
        case 'system': return 50
        default: return 80
      }
    }, [messages]),
    overscan: 10,
  })

  // Update visible range for minimap
  useEffect(() => {
    const range = virtualizer.range
    if (range && messages.length > 0) {
      setVisibleStart(range.startIndex / messages.length)
      setVisibleEnd(Math.min(1, (range.endIndex + 1) / messages.length))
    }
  }, [virtualizer.range, messages.length])

  // Build minimap items from messages
  const minimapItems = useMemo<MiniMapItem[]>(() => {
    if (messages.length === 0) return []

    return messages.map((msg, i) => {
      const item: MiniMapItem = {
        type: msg.displayType,
        index: i,
        heightRatio: 1 / messages.length  // Equal height for simplicity
      }
      if (msg.displayType === 'tree-separator' && msg.treeIndex) {
        item.treeIndex = msg.treeIndex
      }
      return item
    })
  }, [messages])

  // Search results - message indices with matches
  const searchResults = useMemo(() => {
    if (!searchQuery.trim()) return []
    const query = searchQuery.toLowerCase()
    const results: number[] = []
    messages.forEach((msg, index) => {
      const hasMatch = msg.blocks.some(block => {
        if (block.type === 'text' && block.content.toLowerCase().includes(query)) return true
        if (block.type === 'tool_use' && block.name.toLowerCase().includes(query)) return true
        if (block.type === 'tool_result' && block.content.toLowerCase().includes(query)) return true
        return false
      })
      if (hasMatch) results.push(index)
    })
    return results
  }, [messages, searchQuery])

  // Ref to track ongoing search scroll target
  const searchScrollTargetRef = useRef<number | null>(null)

  // Scroll to search result with retry logic for virtual scrolling
  const scrollToSearchResult = useCallback((messageIndex: number) => {
    searchScrollTargetRef.current = messageIndex

    const scrollToTarget = () => {
      if (searchScrollTargetRef.current !== messageIndex) return
      if (!parentRef.current) return

      virtualizer.scrollToIndex(messageIndex, { align: 'center' })

      // Check if we need to keep adjusting
      const range = virtualizer.range
      if (range) {
        const isInView = messageIndex >= range.startIndex && messageIndex <= range.endIndex
        if (!isInView) {
          requestAnimationFrame(scrollToTarget)
        }
      }
    }

    scrollToTarget()
  }, [virtualizer])

  // Navigate search results
  const goToNextResult = useCallback(() => {
    if (searchResults.length === 0) return
    const newIndex = currentSearchIndex >= searchResults.length - 1 ? 0 : currentSearchIndex + 1
    setCurrentSearchIndex(newIndex)
    scrollToSearchResult(searchResults[newIndex])
  }, [searchResults, currentSearchIndex, scrollToSearchResult])

  const goToPrevResult = useCallback(() => {
    if (searchResults.length === 0) return
    const newIndex = currentSearchIndex <= 0 ? searchResults.length - 1 : currentSearchIndex - 1
    setCurrentSearchIndex(newIndex)
    scrollToSearchResult(searchResults[newIndex])
  }, [searchResults, currentSearchIndex, scrollToSearchResult])

  const handleSearchClose = useCallback(() => {
    setShowSearch(false)
    setSearchQuery('')
    setCurrentSearchIndex(-1)
  }, [])

  // Handle click on search result marker in minimap
  const handleSearchResultClick = useCallback((searchIndex: number) => {
    setCurrentSearchIndex(searchIndex)
    scrollToSearchResult(searchResults[searchIndex])
  }, [searchResults, scrollToSearchResult])

  // Reset search index when query changes
  useEffect(() => {
    if (searchResults.length > 0) {
      setCurrentSearchIndex(0)
      scrollToSearchResult(searchResults[0])
    } else {
      setCurrentSearchIndex(-1)
    }
  }, [searchQuery, searchResults, scrollToSearchResult])

  // Navigate via minimap
  const handleMinimapNavigate = useCallback((ratio: number) => {
    const targetIndex = Math.floor(ratio * messages.length)
    virtualizer.scrollToIndex(targetIndex, { align: 'start' })
  }, [messages.length, virtualizer])

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

  const virtualItems = virtualizer.getVirtualItems()

  return (
    <div className="detail-page">
      <Link to="/" className="back-link">Back to sessions</Link>

      <div className="detail-header">
        <h1>{detail.session.session_id}</h1>
        <div className="detail-meta">
          <span>{detail.session.total_lines} lines</span>
          <span>{messages.length} messages</span>
          <span>Created: {formatDateTime(detail.session.created_at)}</span>
          <span>Updated: {formatDateTime(detail.session.updated_at)}</span>
          <button
            onClick={() => setShowSearch(true)}
            style={{
              padding: 'var(--space-1) var(--space-2)',
              fontSize: '12px',
              cursor: 'pointer',
              background: 'var(--bg-tertiary)',
              border: '1px solid var(--border-default)',
              borderRadius: 'var(--radius-sm)',
              color: 'var(--text-secondary)',
            }}
            title="Search (Ctrl+F)"
          >
            🔍 Search
          </button>
        </div>
      </div>

      {/* Floating Search */}
      {showSearch && (
        <FloatingSearch
          totalResults={searchResults.length}
          currentIndex={currentSearchIndex}
          onSearch={setSearchQuery}
          onNext={goToNextResult}
          onPrev={goToPrevResult}
          onClose={handleSearchClose}
        />
      )}

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
          <div
            className="conversation-flow virtual-scroll-container"
            ref={parentRef}
            style={{ height: 'calc(100vh - 350px)', overflow: 'auto' }}
          >
            {messages.length === 0 ? (
              <div className="empty-conversation">
                No conversation data to display
              </div>
            ) : (
              <div
                style={{
                  height: `${virtualizer.getTotalSize()}px`,
                  width: '100%',
                  position: 'relative',
                }}
              >
                {virtualItems.map((virtualRow) => {
                  const msg = messages[virtualRow.index]
                  return (
                    <div
                      key={virtualRow.key}
                      data-index={virtualRow.index}
                      ref={virtualizer.measureElement}
                      style={{
                        position: 'absolute',
                        top: 0,
                        left: 0,
                        width: '100%',
                        transform: `translateY(${virtualRow.start}px)`,
                      }}
                    >
                      <MessageRow
                        msg={msg}
                        searchQuery={searchQuery}
                        isSearchMatch={searchResults.includes(virtualRow.index)}
                      />
                    </div>
                  )
                })}
              </div>
            )}
          </div>
          {messages.length > 0 && (
            <MiniMap
              items={minimapItems}
              visibleStart={visibleStart}
              visibleEnd={visibleEnd}
              onNavigate={handleMinimapNavigate}
              totalMessages={messages.length}
              searchResults={searchResults}
              currentSearchIndex={currentSearchIndex}
              onSearchResultClick={handleSearchResultClick}
            />
          )}
        </div>
      </div>
    </div>
  )
}

export default SessionDetail
