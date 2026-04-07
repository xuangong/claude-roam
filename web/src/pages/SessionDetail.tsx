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
import {
  isTauri,
  getSession,
  getMessagesRange,
  type SessionMeta as TauriSessionMeta,
} from '../utils/tauriStore'

// Props interface for Tauri mode
interface SessionDetailProps {
  sessionId?: string
  useTauri?: boolean
  onExport?: () => void
}

// Estimate message height based on type char (from typeString)
// Overestimate rather than underestimate to prevent content truncation
function estimateHeightByType(typeChar: string): number {
  switch (typeChar) {
    case 'h': return 150   // human
    case 'a': return 300   // assistant
    case 'c': return 80    // tool_call
    case 'r': return 200   // tool_result
    case 's': return 40    // tree-separator
    case 'y': return 60    // system
    default: return 120
  }
}

function SessionDetail({ sessionId: propSessionId, useTauri: propUseTauri, onExport }: SessionDetailProps = {}) {
  const params = useParams<{ id: string }>()
  const id = propSessionId || params.id
  const useTauriMode = propUseTauri ?? isTauri()

  const [detail, setDetail] = useState<SessionDetailResponse | null>(null)
  const [tauriSession, setTauriSession] = useState<TauriSessionMeta | null>(null)
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
  const [showMinimap, setShowMinimap] = useState(() => {
    const saved = localStorage.getItem('minimap-visible')
    return saved !== null ? saved === 'true' : true
  })
  const [minimapFilters, setMinimapFilters] = useState<Set<string>>(() => {
    const saved = localStorage.getItem('minimap-filters')
    if (saved) {
      try { return new Set(JSON.parse(saved)) } catch { /* ignore */ }
    }
    return new Set(['human', 'assistant', 'tool_call', 'tool_result', 'system'])
  })

  const toggleMinimapFilter = useCallback((type: string) => {
    setMinimapFilters(prev => {
      const next = new Set(prev)
      if (next.has(type)) {
        if (next.size > 1) next.delete(type) // keep at least one active
      } else {
        next.add(type)
      }
      localStorage.setItem('minimap-filters', JSON.stringify([...next]))
      return next
    })
  }, [])

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

  // Virtual list setup - estimateSize must be stable (no dependency on visibleMessages)
  // to avoid feedback loops: load messages → height change → scroll shift → reload
  const virtualizer = useVirtualizer({
    count: loading ? 0 : totalMessages,
    getScrollElement: () => parentRef.current,
    estimateSize: (index) => estimateHeightByType(typeString?.[index] || 'a'),
    overscan: 20,
  })

  // Update visible range for minimap (browser mode: from virtualizer)
  useEffect(() => {
    if (useTauriMode) return  // Tauri mode uses scroll events instead
    const range = virtualizer.range
    if (range && totalMessages > 0) {
      setVisibleStart(range.startIndex / totalMessages)
      setVisibleEnd(Math.min(1, (range.endIndex + 1) / totalMessages))
    }
  }, [virtualizer.range, totalMessages, useTauriMode])

  // Update visible range for minimap (Tauri mode: find visible message indices)
  useEffect(() => {
    if (!useTauriMode) return
    const el = parentRef.current
    if (!el) return

    const handleScroll = () => {
      if (totalMessages <= 0) return
      const rect = el.getBoundingClientRect()

      // Find message elements at top and bottom of viewport
      const getIndexAt = (y: number): number => {
        let element = document.elementFromPoint(rect.left + rect.width / 3, y) as Element | null
        while (element && element !== el) {
          const idx = element.getAttribute?.('data-index')
          if (idx !== null && idx !== undefined) return parseInt(idx)
          element = element.parentElement
        }
        return -1
      }

      const firstIdx = getIndexAt(rect.top + 5)
      const lastIdx = getIndexAt(rect.bottom - 5)

      if (firstIdx >= 0 && totalMessages > 0) {
        setVisibleStart(firstIdx / totalMessages)
        setVisibleEnd(Math.min(1, ((lastIdx >= 0 ? lastIdx : firstIdx) + 1) / totalMessages))
      }
    }

    handleScroll()  // Initial
    el.addEventListener('scroll', handleScroll, { passive: true })
    return () => el.removeEventListener('scroll', handleScroll)
  }, [useTauriMode, totalMessages, loading])

  // Track last loaded range to avoid unnecessary updates
  const lastLoadedRangeRef = useRef<{ start: number; end: number } | null>(null)

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
    if (!searchQuery.trim() || totalMessages === 0) {
      setSearchResults([])
      setCurrentSearchIndex(-1)
      return
    }

    const query = searchQuery.toLowerCase()
    const results: number[] = []

    // Search through all messages (Tauri: visibleMessages, Browser: cache)
    for (let i = 0; i < totalMessages; i++) {
      const msg = useTauriMode ? visibleMessages.get(i) : cacheRef.current?.getIfCached(i)
      if (msg) {
        // Search all text content in blocks
        let found = false
        for (const block of msg.blocks) {
          const searchable = [
            block.type === 'text' ? block.content : '',
            block.type === 'tool_use' ? block.name : '',
            block.type === 'tool_result' ? block.content : '',
          ].join(' ')
          if (searchable.toLowerCase().includes(query)) {
            found = true
            break
          }
        }
        // Also search top-level fields (Tauri messages may have content outside blocks)
        if (!found) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const raw = msg as any
          const extras = [
            raw.toolContent, raw.thinkingContent, raw.stdout, raw.stderr
          ].filter(Boolean).join(' ')
          if (extras.toLowerCase().includes(query)) {
            found = true
          }
        }
        if (found) results.push(i)
      }
    }

    setSearchResults(results)
    if (results.length > 0) {
      setCurrentSearchIndex(0)
      if (useTauriMode) {
        // Tauri: scroll to element by data-index
        const el = parentRef.current?.querySelector(`[data-index="${results[0]}"]`) as HTMLElement | null
        el?.scrollIntoView({ block: 'center' })
      } else {
        virtualizer.scrollToIndex(results[0], { align: 'center' })
      }
    } else {
      setCurrentSearchIndex(-1)
    }
  }, [searchQuery, totalMessages, virtualizer, useTauriMode, visibleMessages])

  // Ref to track ongoing search scroll target
  const searchScrollTargetRef = useRef<number | null>(null)

  // Scroll to search result with retry logic for virtual scrolling
  const scrollToSearchResult = useCallback((messageIndex: number) => {
    if (useTauriMode) {
      // Tauri: scroll to element by data-index
      const el = parentRef.current?.querySelector(`[data-index="${messageIndex}"]`) as HTMLElement | null
      el?.scrollIntoView({ block: 'center', behavior: 'smooth' })
      return
    }

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
  }, [virtualizer, totalMessages, useTauriMode])

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

    if (useTauriMode) {
      // Tauri mode: ratio is message index ratio, scroll to that message
      const targetIndex = Math.floor(ratio * totalMessages)
      const el = parentRef.current.querySelector(`[data-index="${targetIndex}"]`) as HTMLElement | null
      if (el) el.scrollIntoView({ block: 'start' })
      return
    }

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
  }, [totalMessages, virtualizer, useTauriMode])

  // Clear cache and refresh
  const handleRefreshCache = useCallback(async () => {
    if (!id) return
    await clearSession(id)
    cacheRef.current?.clear()
    setRefreshKey(k => k + 1)
  }, [id])

  // Scroll to a specific message by index (for type navigation)
  const scrollToMessage = useCallback((index: number) => {
    if (useTauriMode) {
      const el = parentRef.current?.querySelector(`[data-index="${index}"]`) as HTMLElement | null
      el?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    } else {
      virtualizer.scrollToIndex(index, { align: 'center' })
    }
  }, [useTauriMode, virtualizer])

  // Fetch session data and parse with Web Worker
  useEffect(() => {
    if (!id) return

    let cancelled = false
    let worker: Worker | null = null

    // Tauri mode: load from native backend
    async function fetchTauriData() {
      try {
        setLoading(true)
        setError(null)

        const session = await getSession(id!)
        if (cancelled || !session) {
          if (!cancelled && !session) {
            setError('Session not found')
          }
          setLoading(false)
          return
        }

        setTauriSession(session)
        setTotalMessages(session.messageCount)
        setTypeString(session.typeString || '')

        // Load ALL messages at once - no virtual scrolling needed for local data
        const allMessages = await getMessagesRange(id!, 0, session.messageCount)
        const allVisible = new Map<number, DisplayMessage>()
        allMessages.forEach((msg, i) => allVisible.set(i, msg))
        setVisibleMessages(allVisible)

        setLoading(false)
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load session')
          setLoading(false)
        }
      }
    }

    // Browser mode: fetch from API and parse with Web Worker
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

    // Choose mode based on environment
    if (useTauriMode) {
      fetchTauriData()
    } else {
      fetchAndParse(refreshKey > 0)
    }

    return () => {
      cancelled = true
      worker?.terminate()
      cacheRef.current?.clear()
    }
  }, [id, refreshKey, useTauriMode])

  // Browser mode only: load visible messages on scroll
  useEffect(() => {
    if (useTauriMode || loading || totalMessages === 0 || isParsingData || !cacheRef.current) return

    const range = virtualizer.range
    if (!range) return

    const start = Math.max(0, range.startIndex - 50)
    const end = Math.min(totalMessages - 1, range.endIndex + 50)

    const lastRange = lastLoadedRangeRef.current
    if (lastRange && start >= lastRange.start && end <= lastRange.end) {
      return
    }

    cacheRef.current.prefetch(Math.floor((start + end) / 2), totalMessages).then(() => {
      const newVisible = new Map<number, DisplayMessage>()
      for (let i = start; i <= end; i++) {
        const msg = cacheRef.current?.getIfCached(i)
        if (msg) newVisible.set(i, msg)
      }
      lastLoadedRangeRef.current = { start, end }
      setVisibleMessages(newVisible)
    })
  }, [useTauriMode, virtualizer.range, isParsingData, totalMessages, loading])

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

  // In browser mode, detail is required. In Tauri mode, tauriSession is used.
  if (!useTauriMode && !detail) {
    return null
  }
  if (useTauriMode && !tauriSession) {
    return null
  }

  const virtualItems = virtualizer.getVirtualItems()
  const totalSize = virtualizer.getTotalSize()

  // Get session info from appropriate source
  const sessionId = useTauriMode ? tauriSession!.id : detail!.session.session_id
  const sessionCreatedAt = useTauriMode
    ? (tauriSession!.createdAt || new Date(tauriSession!.lastModified).toISOString())
    : detail!.session.created_at
  const sessionUpdatedAt = useTauriMode
    ? (tauriSession!.updatedAt || new Date(tauriSession!.lastModified).toISOString())
    : detail!.session.updated_at

  return (
    <div className="detail-page">
      <Link to="/" className="back-link">Back to sessions</Link>

      <div className="detail-header">
        <h1>{sessionId}</h1>
        <div className="detail-meta">
          {!useTauriMode && <span>{detail!.session.total_lines} lines</span>}
          <span>{totalMessages} messages</span>
          <span>Created: {formatDateTime(sessionCreatedAt)}</span>
          <span>Updated: {formatDateTime(sessionUpdatedAt)}</span>
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
          <button
            onClick={() => {
              const next = !showMinimap
              setShowMinimap(next)
              localStorage.setItem('minimap-visible', String(next))
            }}
            style={{
              padding: 'var(--space-1) var(--space-2)',
              fontSize: '12px',
              cursor: 'pointer',
              background: showMinimap ? 'var(--bg-tertiary)' : 'var(--bg-hover)',
              border: '1px solid var(--border-default)',
              borderRadius: 'var(--radius-sm)',
              color: 'var(--text-secondary)',
            }}
            title={showMinimap ? 'Hide minimap' : 'Show minimap'}
          >
            {showMinimap ? '▮ Map' : '▯ Map'}
          </button>
          {onExport && (
            <button
              onClick={onExport}
              style={{
                padding: 'var(--space-1) var(--space-2)',
                fontSize: '12px',
                cursor: 'pointer',
                background: 'var(--bg-tertiary)',
                border: '1px solid var(--border-default)',
                borderRadius: 'var(--radius-sm)',
                color: 'var(--text-secondary)',
              }}
              title="Export this session to .roam file"
            >
              ⬇ Export
            </button>
          )}
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

      {/* Source History - only shown in browser mode */}
      {!useTauriMode && detail && (
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
      )}

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
            ) : useTauriMode ? (
              /* Tauri mode: render all messages directly, no virtual scrolling */
              <div style={{ width: '100%' }}>
                {Array.from({ length: totalMessages }, (_, i) => {
                  const msg = visibleMessages.get(i) || null
                  return (
                    <div key={i} data-index={i}>
                      <MessageRow
                        msg={msg}
                        searchQuery={searchQuery}
                        isSearchMatch={searchResults.includes(i)}
                        messageIndex={i}
                        typeString={typeString}
                        onScrollToMessage={scrollToMessage}
                      />
                    </div>
                  )
                })}
              </div>
            ) : (
              /* Browser mode: virtual scrolling */
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
                        messageIndex={virtualRow.index}
                        typeString={typeString}
                        onScrollToMessage={scrollToMessage}
                      />
                    </div>
                  )
                })}
              </div>
            )}
          </div>
          {showMinimap && totalMessages > 0 && (
            <MiniMap
              items={minimapItems}
              visibleStart={visibleStart}
              visibleEnd={visibleEnd}
              onNavigate={handleMinimapNavigate}
              totalMessages={totalMessages}
              searchResults={searchResults}
              currentSearchIndex={currentSearchIndex}
              onSearchResultClick={handleSearchResultClick}
              activeFilters={minimapFilters}
              onToggleFilter={toggleMinimapFilter}
            />
          )}
        </div>
      </div>
    </div>
  )
}

export default SessionDetail
