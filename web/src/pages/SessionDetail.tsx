import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useVirtualizer } from '@tanstack/react-virtual'
import { getSessionDetail, pullSession, type SessionDetailResponse, type Segment } from '../api'
import { MiniMap, type MiniMapItem } from '../components/MiniMap'
import { MessageRow } from '../components/MessageComponents'
import { FloatingSearch } from '../components/FloatingSearch'
import type { DisplayMessage } from '../types/message'
import { formatDateTime } from '../utils/format'
import {
  getSessionMeta,
  clearSession,
  MessageCache
} from '../utils/messageStore'
import { createParserWorker } from '../utils/parserWorker'

// Estimate message height based on type char (from typeString)
function estimateHeightByType(typeChar: string): number {
  switch (typeChar) {
    case 'h': return 80   // human
    case 'a': return 150  // assistant
    case 'c': return 50   // tool_call
    case 'r': return 80   // tool_result
    case 's': return 40   // tree-separator
    case 'y': return 40   // system
    default: return 60
  }
}

// Estimate message height from actual message content
function estimateMessageHeight(msg: DisplayMessage | null, typeChar?: string): number {
  if (!msg) {
    return typeChar ? estimateHeightByType(typeChar) : 60
  }
  switch (msg.displayType) {
    case 'human': {
      const textLen = msg.blocks.reduce((acc, b) => acc + (b.type === 'text' ? b.content.length : 0), 0)
      return Math.max(60, Math.min(400, 60 + Math.floor(textLen / 80) * 20))
    }
    case 'assistant': {
      const textLen = msg.blocks.reduce((acc, b) => acc + (b.type === 'text' ? b.content.length : 0), 0)
      return Math.max(60, Math.min(600, 60 + Math.floor(textLen / 80) * 20))
    }
    case 'tool_call': return 50
    case 'tool_result': return 80
    case 'tree-separator': return 40
    case 'system': return 40
    default: return 60
  }
}

function SessionDetail() {
  const { id } = useParams<{ id: string }>()
  const [detail, setDetail] = useState<SessionDetailResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Web Worker parsing state
  const [isParsingData, setIsParsingData] = useState(false)
  const [parsingProgress, setParsingProgress] = useState('')
  const [totalMessages, setTotalMessages] = useState(0)
  const [typeString, setTypeString] = useState('')  // For minimap colors
  const [visibleMessages, setVisibleMessages] = useState<Map<number, DisplayMessage>>(new Map())
  const cacheRef = useRef<MessageCache | null>(null)
  const [refreshKey, setRefreshKey] = useState(0)  // For forcing re-parse

  // Virtual scroll state
  const parentRef = useRef<HTMLDivElement>(null)
  const [visibleStart, setVisibleStart] = useState(0)
  const [visibleEnd, setVisibleEnd] = useState(1)

  // Search state
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<number[]>([])
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
    count: totalMessages,
    getScrollElement: () => parentRef.current,
    estimateSize: (index) => estimateMessageHeight(visibleMessages.get(index) || null, typeString[index]),
    overscan: 20,
  })

  // Update visible range for minimap
  useEffect(() => {
    const range = virtualizer.range
    if (range && totalMessages > 0) {
      setVisibleStart(range.startIndex / totalMessages)
      setVisibleEnd(Math.min(1, (range.endIndex + 1) / totalMessages))
    }
  }, [virtualizer.range, totalMessages])

  // Track last loaded range to avoid unnecessary updates
  const lastLoadedRangeRef = useRef<{ start: number; end: number } | null>(null)

  // Load visible messages from IndexedDB
  useEffect(() => {
    if (isParsingData || totalMessages === 0 || !cacheRef.current) return

    const range = virtualizer.range
    if (!range) return

    const start = Math.max(0, range.startIndex - 50)
    const end = Math.min(totalMessages - 1, range.endIndex + 50)

    // Skip if we've already loaded this range
    const lastRange = lastLoadedRangeRef.current
    if (lastRange && start >= lastRange.start && end <= lastRange.end) {
      return
    }

    // Prefetch and update visible messages
    cacheRef.current.prefetch(Math.floor((start + end) / 2), totalMessages).then(() => {
      const newVisible = new Map<number, DisplayMessage>()
      for (let i = start; i <= end; i++) {
        const msg = cacheRef.current?.getIfCached(i)
        if (msg) newVisible.set(i, msg)
      }
      lastLoadedRangeRef.current = { start, end }
      setVisibleMessages(newVisible)
    })
  }, [virtualizer.range, isParsingData, totalMessages])

  // Build minimap items - merge adjacent same-type messages
  const minimapItems = useMemo<MiniMapItem[]>(() => {
    if (totalMessages === 0 || !typeString) return []

    const charToType: Record<string, string> = {
      'h': 'human',
      'a': 'assistant',
      'c': 'tool_call',
      'r': 'tool_result',
      's': 'tree-separator',
      'y': 'system'
    }

    const items: MiniMapItem[] = []
    let treeIdx = 0
    let currentType: string | null = null
    let currentStart = 0
    let currentCount = 0

    const pushCurrentBlock = () => {
      if (currentType && currentCount > 0) {
        items.push({
          type: currentType,
          index: currentStart,
          heightRatio: currentCount / totalMessages,
          treeIndex: currentType === 'tree-separator' ? treeIdx : undefined
        })
      }
    }

    for (let i = 0; i < totalMessages; i++) {
      const typeChar = typeString[i] || 'a'
      const displayType = charToType[typeChar] || 'assistant'

      if (displayType === 'tree-separator') {
        pushCurrentBlock()
        treeIdx++
        items.push({
          type: 'tree-separator',
          index: i,
          heightRatio: 1 / totalMessages,
          treeIndex: treeIdx
        })
        currentType = null
        currentCount = 0
      } else if (displayType === currentType) {
        currentCount++
      } else {
        pushCurrentBlock()
        currentType = displayType
        currentStart = i
        currentCount = 1
      }
    }
    pushCurrentBlock()

    return items
  }, [totalMessages, typeString])

  // Search effect - search through all cached messages when query changes
  useEffect(() => {
    if (!searchQuery.trim() || !cacheRef.current || totalMessages === 0) {
      setSearchResults([])
      setCurrentSearchIndex(-1)
      return
    }

    const query = searchQuery.toLowerCase()
    const results: number[] = []

    // Search through all cached messages
    for (let i = 0; i < totalMessages; i++) {
      const msg = cacheRef.current.getIfCached(i)
      if (msg) {
        for (const block of msg.blocks) {
          if (block.type === 'text' && block.content.toLowerCase().includes(query)) {
            results.push(i)
            break
          } else if (block.type === 'tool_use' && block.name.toLowerCase().includes(query)) {
            results.push(i)
            break
          } else if (block.type === 'tool_result' && block.content.toLowerCase().includes(query)) {
            results.push(i)
            break
          }
        }
      }
    }

    setSearchResults(results)
    if (results.length > 0) {
      setCurrentSearchIndex(0)
      virtualizer.scrollToIndex(results[0], { align: 'center' })
    } else {
      setCurrentSearchIndex(-1)
    }
  }, [searchQuery, totalMessages, virtualizer])

  // Ref to track ongoing search scroll target
  const searchScrollTargetRef = useRef<number | null>(null)

  // Scroll to search result with retry logic for virtual scrolling
  const scrollToSearchResult = useCallback((messageIndex: number) => {
    searchScrollTargetRef.current = messageIndex

    const scrollToTarget = () => {
      if (searchScrollTargetRef.current !== messageIndex) return
      if (!parentRef.current) return

      virtualizer.scrollToIndex(messageIndex, { align: 'center' })

      const range = virtualizer.range
      if (range) {
        const isInView = messageIndex >= range.startIndex && messageIndex <= range.endIndex
        if (!isInView) {
          requestAnimationFrame(scrollToTarget)
        }
      }
    }

    scrollToTarget()

    // Prefetch messages around target
    if (cacheRef.current) {
      cacheRef.current.prefetch(messageIndex, totalMessages)
    }
  }, [virtualizer, totalMessages])

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
    setSearchResults([])
    setCurrentSearchIndex(-1)
  }, [])

  // Handle click on search result marker in minimap
  const handleSearchResultClick = useCallback((searchIndex: number) => {
    setCurrentSearchIndex(searchIndex)
    scrollToSearchResult(searchResults[searchIndex])
  }, [searchResults, scrollToSearchResult])

  // Ref to track ongoing scroll target
  const scrollTargetRef = useRef<number | null>(null)

  // Navigate via minimap
  const handleMinimapNavigate = useCallback((ratio: number) => {
    if (!parentRef.current || totalMessages === 0) return

    const targetIndex = Math.floor(ratio * totalMessages)
    scrollTargetRef.current = ratio

    const scrollToTarget = () => {
      if (scrollTargetRef.current !== ratio) return
      if (!parentRef.current) return

      virtualizer.scrollToIndex(targetIndex, { align: 'start' })

      const range = virtualizer.range
      if (range && Math.abs(range.startIndex - targetIndex) > 2) {
        requestAnimationFrame(scrollToTarget)
      }
    }

    scrollToTarget()

    // Prefetch messages around target
    if (cacheRef.current) {
      cacheRef.current.prefetch(targetIndex, totalMessages)
    }
  }, [totalMessages, virtualizer])

  // Clear cache and refresh
  const handleRefreshCache = useCallback(async () => {
    if (!id) return
    await clearSession(id)
    cacheRef.current?.clear()
    setRefreshKey(k => k + 1)
  }, [id])

  // Fetch session data and parse with Web Worker
  useEffect(() => {
    if (!id) return

    let cancelled = false
    let worker: Worker | null = null

    async function fetchAndParse(forceReparse = false) {
      try {
        setLoading(true)
        setError(null)

        // First, fetch session detail (lightweight request)
        const detailResp = await getSessionDetail(id!)
        if (cancelled) return
        setDetail(detailResp)

        const sessionId = id!
        // Use updated_at as cache key - if session hasn't changed, skip download
        const cacheKey = detailResp.session.updated_at

        setIsParsingData(true)
        setParsingProgress('Checking cache...')

        // Check if already cached using updated_at
        if (!forceReparse) {
          const meta = await getSessionMeta(sessionId)
          if (meta && !cancelled) {
            const cachedKey = (meta as { dataHash?: string }).dataHash
            const ts = (meta as { typeString?: string }).typeString || ''
            // If cache key matches and typeString exists, use cache
            if (cachedKey === cacheKey && ts.length > 0) {
              setTotalMessages(meta.totalMessages)
              setTypeString(ts)
              cacheRef.current = new MessageCache(sessionId)
              setParsingProgress('Loading messages...')
              await cacheRef.current.prefetch(Math.floor(meta.totalMessages / 2), meta.totalMessages)
              setIsParsingData(false)
              setLoading(false)
              return
            }
          }
        }

        // Cache miss or stale - need to download and parse
        setParsingProgress('Downloading data...')
        const pullResp = await pullSession(id!)
        if (cancelled) return

        // Parse with worker
        setParsingProgress('Starting parser...')
        worker = createParserWorker()

        worker.onmessage = async (e) => {
          if (cancelled) return

          const { type, message, totalMessages: total, typeString: ts } = e.data
          if (type === 'progress') {
            setParsingProgress(message)
          } else if (type === 'done') {
            worker?.terminate()
            worker = null
            setTotalMessages(total)
            setTypeString(ts || '')
            cacheRef.current = new MessageCache(sessionId)
            setParsingProgress('Loading messages...')
            await cacheRef.current.prefetch(Math.floor(total / 2), total)
            setIsParsingData(false)
            setLoading(false)
          } else if (type === 'error') {
            worker?.terminate()
            worker = null
            setError(message)
            setIsParsingData(false)
            setLoading(false)
          }
        }

        worker.onerror = (err) => {
          worker?.terminate()
          worker = null
          setError('Worker error: ' + err.message)
          setIsParsingData(false)
          setLoading(false)
        }

        // Use updated_at as dataHash for cache validation
        worker.postMessage({ data: pullResp.data, sessionId, dataHash: cacheKey })

      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load session')
          setLoading(false)
          setIsParsingData(false)
        }
      }
    }

    fetchAndParse(refreshKey > 0)

    return () => {
      cancelled = true
      worker?.terminate()
      cacheRef.current?.clear()
    }
  }, [id, refreshKey])

  if (loading || isParsingData) {
    return (
      <div className="detail-page">
        <Link to="/" className="back-link">Back to sessions</Link>
        <div className="loading-container" style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '60px 20px',
          color: 'var(--text-secondary)'
        }}>
          <div className="loading-spinner" style={{
            width: '40px',
            height: '40px',
            border: '3px solid var(--border)',
            borderTopColor: 'var(--accent)',
            borderRadius: '50%',
            animation: 'spin 1s linear infinite',
            marginBottom: '16px'
          }} />
          <div style={{ fontSize: '14px' }}>{isParsingData ? parsingProgress : 'Loading session...'}</div>
          <style>{`
            @keyframes spin {
              to { transform: rotate(360deg); }
            }
          `}</style>
        </div>
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
  const totalSize = virtualizer.getTotalSize()

  return (
    <div className="detail-page">
      <Link to="/" className="back-link">Back to sessions</Link>

      <div className="detail-header">
        <h1>{detail.session.session_id}</h1>
        <div className="detail-meta">
          <span>{detail.session.total_lines} lines</span>
          <span>{totalMessages} messages</span>
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
          <button
            onClick={handleRefreshCache}
            style={{
              padding: 'var(--space-1) var(--space-2)',
              fontSize: '12px',
              cursor: 'pointer',
              background: 'var(--bg-tertiary)',
              border: '1px solid var(--border-default)',
              borderRadius: 'var(--radius-sm)',
              color: 'var(--text-secondary)',
            }}
            title="Clear cache and re-parse messages"
          >
            ↻ Refresh
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

      <div className="section conversation-section conversation-section-immersive">
        <h2>Conversation</h2>
        <div className="conversation-container">
          <div
            className="conversation-flow virtual-scroll-container"
            ref={parentRef}
          >
            {totalMessages === 0 ? (
              <div className="empty-conversation">
                No conversation data to display
              </div>
            ) : (
              <div
                style={{
                  height: `${totalSize}px`,
                  width: '100%',
                  position: 'relative',
                }}
              >
                {virtualItems.map((virtualRow) => {
                  const msg = visibleMessages.get(virtualRow.index) || null
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
          {totalMessages > 0 && (
            <MiniMap
              items={minimapItems}
              visibleStart={visibleStart}
              visibleEnd={visibleEnd}
              onNavigate={handleMinimapNavigate}
              totalMessages={totalMessages}
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
