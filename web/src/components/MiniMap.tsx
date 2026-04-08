import { useState, useRef, useEffect, useCallback, useMemo, useLayoutEffect } from 'react'

export interface MiniMapItem {
  type: string
  index: number
  heightRatio: number
  treeIndex?: number  // For tree-separator items
}

interface MiniMapProps {
  items: MiniMapItem[]
  visibleStart: number
  visibleEnd: number
  onNavigate: (ratio: number) => void
  totalMessages?: number  // For position indicator
  searchResults?: number[]  // Message indices with search matches
  currentSearchIndex?: number  // Currently focused search result
  onSearchResultClick?: (searchIndex: number) => void  // Click handler for search result markers
  activeFilters?: Set<string>  // Which message types are visible
  onToggleFilter?: (type: string) => void  // Toggle a filter
}

const FILTER_TYPES = [
  { type: 'human', color: '#3b82f6', label: 'Human' },
  { type: 'assistant', color: '#8b5cf6', label: 'Assistant' },
  { type: 'tool_call', color: '#d1d5db', label: 'Tool Call' },
  { type: 'tool_result', color: '#e5e7eb', label: 'Tool Result' },
  { type: 'system', color: '#f3f4f6', label: 'System' },
  { type: 'error', color: '#ef4444', label: 'Error' },
]

export function MiniMap({
  items,
  visibleStart,
  visibleEnd,
  onNavigate,
  totalMessages = 0,
  searchResults = [],
  currentSearchIndex = -1,
  onSearchResultClick,
  activeFilters,
  onToggleFilter
}: MiniMapProps) {
  const minimapRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const viewportRef = useRef<HTMLDivElement>(null)
  const rulerViewportRef = useRef<HTMLDivElement>(null)
  const isDragging = useRef(false)
  const isResizing = useRef(false)
  const isResizingTop = useRef(false)
  const isMoving = useRef(false)
  const dragOffset = useRef({ x: 0, y: 0 })
  const resizeTopStart = useRef({ y: 0, top: 0, height: 0 })
  const [hoverRatio, setHoverRatio] = useState<number | null>(null)
  const [isDraggingState, setIsDraggingState] = useState(false)

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
    if (target.classList.contains('minimap-resize-top-handle')) {
      isResizingTop.current = true
      resizeTopStart.current = {
        y: e.clientY,
        top: minimapRef.current?.offsetTop ?? 0,
        height: minimapRef.current?.offsetHeight ?? height
      }
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
    setIsDraggingState(true)
    handleNavigateClick(e)
  }, [])

  const handleNavigateClick = useCallback((e: React.MouseEvent) => {
    if (!contentRef.current) return
    const rect = contentRef.current.getBoundingClientRect()
    const y = e.clientY - rect.top
    const ratio = Math.max(0, Math.min(1, y / rect.height))
    setHoverRatio(ratio)
    onNavigate(ratio)
  }, [onNavigate])

  // Get the offset parent bounds for position calculation (supports absolute positioning in Tauri)
  const getContainerBounds = useCallback(() => {
    const parent = minimapRef.current?.offsetParent as HTMLElement | null
    if (parent && getComputedStyle(minimapRef.current!).position === 'absolute') {
      const rect = parent.getBoundingClientRect()
      return { width: rect.width, height: rect.height, left: rect.left, top: rect.top }
    }
    return { width: window.innerWidth, height: window.innerHeight, left: 0, top: 0 }
  }, [])

  useEffect(() => {
    const handleGlobalMouseUp = () => {
      isDragging.current = false
      isResizing.current = false
      isResizingTop.current = false
      isMoving.current = false
      setIsDraggingState(false)
      setHoverRatio(null)
    }
    const handleGlobalMouseMove = (e: MouseEvent) => {
      if (isResizing.current && minimapRef.current) {
        const rect = minimapRef.current.getBoundingClientRect()
        const newHeight = Math.max(100, Math.min(window.innerHeight - 50, e.clientY - rect.top))
        setHeight(newHeight)
      }
      if (isResizingTop.current) {
        const delta = e.clientY - resizeTopStart.current.y
        const bottom = resizeTopStart.current.top + resizeTopStart.current.height
        const clampedTop = Math.max(0, resizeTopStart.current.top + delta)
        const newHeight = Math.max(100, bottom - clampedTop)
        setHeight(newHeight)
        setPosition((prev: { top: number; right: number }) => ({ ...prev, top: clampedTop }))
      }
      if (isMoving.current) {
        const container = getContainerBounds()
        const h = minimapRef.current?.offsetHeight || height
        const newTop = e.clientY - container.top - dragOffset.current.y
        const newRight = container.width - (e.clientX - container.left) - (60 - dragOffset.current.x)
        setPosition({
          top: Math.max(0, Math.min(container.height - h, newTop)),
          right: Math.max(0, Math.min(container.width - 100, newRight))
        })
      }
      // Handle dragging navigation globally
      if (isDragging.current && contentRef.current) {
        const rect = contentRef.current.getBoundingClientRect()
        const y = e.clientY - rect.top
        const ratio = Math.max(0, Math.min(1, y / rect.height))
        setHoverRatio(ratio)
        onNavigate(ratio)
      }
    }
    window.addEventListener('mouseup', handleGlobalMouseUp)
    window.addEventListener('mousemove', handleGlobalMouseMove)
    return () => {
      window.removeEventListener('mouseup', handleGlobalMouseUp)
      window.removeEventListener('mousemove', handleGlobalMouseMove)
    }
  }, [onNavigate, getContainerBounds])

  const [contentRect, setContentRect] = useState({ top: 56, height: height - 76 })

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

  // Adjust height ratios so every item gets at least 1px from flex allocation
  // Strategy: small items get fixed 1px, large items share remaining space proportionally
  // Set flex-grow = desired pixel height (sum = containerHeight), so flex gives exact sizes
  const adjustedItems = useMemo(() => {
    if (contentRect.height <= 0 || items.length === 0) return items

    const H = contentRect.height
    const totalRatio = items.reduce((sum, item) => sum + item.heightRatio, 0)
    if (totalRatio === 0) return items

    // Raw pixel heights from proportional distribution
    const rawHeights = items.map(item => item.heightRatio / totalRatio * H)
    const needsAdjust = rawHeights.some(h => h < 1)
    if (!needsAdjust) return items

    // Count small items and sum large item ratios
    let smallCount = 0
    let largeRatioSum = 0
    for (let i = 0; i < items.length; i++) {
      if (rawHeights[i] < 1) {
        smallCount++
      } else {
        largeRatioSum += items[i].heightRatio
      }
    }

    const remainingH = H - smallCount
    if (remainingH <= 0 || largeRatioSum === 0) return items

    // flex-grow values = desired pixel heights, sum to H → exact pixel allocation
    return items.map((item, i) => ({
      ...item,
      heightRatio: rawHeights[i] < 1 ? 1 : (item.heightRatio / largeRatioSum * remainingH)
    }))
  }, [items, contentRect.height])

  // DOM-measured viewport positioning
  // Reads actual flex child positions so minHeight doesn't cause drift
  useLayoutEffect(() => {
    if (!contentRef.current || !viewportRef.current || items.length === 0 || !totalMessages) return

    const children = contentRef.current.children
    if (children.length === 0) return

    const startMsgIdx = visibleStart * totalMessages
    const endMsgIdx = visibleEnd * totalMessages

    let cumMsg = 0
    let pxTop = 0
    const lastChild = children[children.length - 1] as HTMLElement
    let pxBot = lastChild.offsetTop + lastChild.offsetHeight
    let foundStart = false

    for (let i = 0; i < items.length && i < children.length; i++) {
      const msgCount = Math.round(items[i].heightRatio * totalMessages)
      const child = children[i] as HTMLElement

      if (!foundStart && cumMsg + msgCount > startMsgIdx) {
        const f = msgCount > 0 ? (startMsgIdx - cumMsg) / msgCount : 0
        pxTop = child.offsetTop + f * child.offsetHeight
        foundStart = true
      }

      if (foundStart && cumMsg + msgCount >= endMsgIdx) {
        const f = msgCount > 0 ? (endMsgIdx - cumMsg) / msgCount : 1
        pxBot = child.offsetTop + f * child.offsetHeight
        break
      }

      cumMsg += msgCount
    }

    const top = contentRect.top + pxTop
    const h = Math.max(pxBot - pxTop, 4)

    viewportRef.current.style.top = `${top}px`
    viewportRef.current.style.height = `${h}px`

    if (rulerViewportRef.current) {
      rulerViewportRef.current.style.top = `${pxTop}px`
      rulerViewportRef.current.style.height = `${h}px`
    }
  }, [items, visibleStart, visibleEnd, totalMessages, contentRect])

  // Calculate positions of tree separators for the ruler
  // Always calculate from items to ensure alignment with minimap content
  const separatorPositions = useMemo(() => {
    const positions: { ratio: number; index: number }[] = []
    let cumulative = 0
    const totalRatio = items.reduce((sum, item) => sum + item.heightRatio, 0)

    items.forEach((item) => {
      if (item.type === 'tree-separator') {
        // Position at the CENTER of this item (matching the ::after top: 50%)
        const centerRatio = totalRatio > 0 ? (cumulative + item.heightRatio / 2) / totalRatio : 0
        positions.push({
          ratio: centerRatio,
          index: item.treeIndex || positions.length + 1
        })
      }
      cumulative += item.heightRatio
    })
    return positions
  }, [items])

  // Filter separator positions to avoid overlapping labels
  const visibleSeparatorPositions = useMemo(() => {
    if (separatorPositions.length <= 1) return separatorPositions

    const minPixelGap = 16 // Minimum pixels between labels
    const rulerHeight = contentRect.height

    // Convert ratios to pixel positions
    const withPixels = separatorPositions.map(pos => ({
      ...pos,
      pixel: pos.ratio * rulerHeight
    }))

    // Greedy algorithm: always show first, then show next only if far enough
    const visible: typeof withPixels = []

    for (let i = 0; i < withPixels.length; i++) {
      const current = withPixels[i]
      const isFirst = i === 0
      const isLast = i === withPixels.length - 1

      if (isFirst || isLast) {
        // Always show first and last
        visible.push(current)
      } else {
        // Check distance from last visible
        const lastVisible = visible[visible.length - 1]
        const distFromLast = current.pixel - lastVisible.pixel

        // Check distance to next that will definitely be shown (last one)
        const lastPos = withPixels[withPixels.length - 1]
        const distToLast = lastPos.pixel - current.pixel

        // Show if far enough from both last visible and the end
        if (distFromLast >= minPixelGap && distToLast >= minPixelGap) {
          visible.push(current)
        }
      }
    }

    return visible
  }, [separatorPositions, contentRect.height])

  // Current message index based on ratio (for position indicator)
  const currentMessageIndex = hoverRatio !== null
    ? Math.floor(hoverRatio * totalMessages) + 1
    : Math.floor(visibleStart * totalMessages) + 1
  const showIndicator = isDraggingState && totalMessages > 0

  // Forward wheel events to the scroll container underneath
  const handleWheel = useCallback((e: React.WheelEvent) => {
    const scrollContainer = minimapRef.current
      ?.closest('.conversation-container')
      ?.querySelector('.virtual-scroll-container') as HTMLElement | null
    if (scrollContainer) {
      scrollContainer.scrollTop += e.deltaY
    }
  }, [])

  return (
    <div
      className="minimap"
      ref={minimapRef}
      style={{ top: `${position.top}px`, right: `${position.right}px`, height: `${height}px`, maxHeight: 'none' }}
      onMouseDown={handleMouseDown}
      onWheel={handleWheel}
    >
      <div className="minimap-resize-top-handle" title="Drag to resize">═</div>
      <div className="minimap-move-handle" title="Drag to move">⋮⋮</div>
      {/* Filter bar */}
      {activeFilters && onToggleFilter && (
        <div className="minimap-filter-bar" onMouseDown={e => e.stopPropagation()}>
          {FILTER_TYPES.map(f => {
            const active = activeFilters.has(f.type)
            return (
              <div
                key={f.type}
                className={`minimap-filter-item ${active ? 'active' : ''}`}
                onClick={() => onToggleFilter(f.type)}
                title={f.label}
              >
                <span className="minimap-filter-dot" style={{ background: active ? f.color : 'transparent', borderColor: f.color }} />
              </div>
            )
          })}
        </div>
      )}
      {/* Position indicator during drag */}
      {showIndicator && (
        <div
          className="minimap-position-indicator"
          style={{ top: `${(hoverRatio ?? visibleStart) * contentRect.height + contentRect.top - 10}px` }}
        >
          {currentMessageIndex} / {totalMessages}
        </div>
      )}
      {/* Left ruler with conversation markers and viewport indicator */}
      <div className="minimap-ruler">
        {/* Viewport indicator on ruler */}
        <div
          className="minimap-ruler-viewport"
          ref={rulerViewportRef}
        />
        {visibleSeparatorPositions.map((pos, i) => (
          <div
            key={i}
            className="minimap-ruler-tick"
            style={{ top: `${pos.ratio * contentRect.height}px` }}
            onClick={(e) => { e.stopPropagation(); onNavigate(pos.ratio) }}
            title={`Conversation ${pos.index}`}
          >
            <span className="minimap-ruler-label">{pos.index}</span>
          </div>
        ))}
      </div>
      <div className="minimap-content" ref={contentRef}>
        {adjustedItems.map((item, i) => {
          const filtered = activeFilters && !activeFilters.has(item.type) && item.type !== 'tree-separator'
          const msgCount = Math.round(items[i].heightRatio * totalMessages)
          const label = FILTER_TYPES.find(f => f.type === item.type)?.label || item.type
          const tooltip = item.type === 'tree-separator'
            ? `Conversation ${item.treeIndex}`
            : `${label} × ${msgCount}`
          return (
            <div
              key={i}
              className={`minimap-item minimap-${item.type}`}
              style={{ flex: `${item.heightRatio} 0 0`, opacity: filtered ? 0.08 : 1 }}
              data-tooltip={tooltip}
            />
          )
        })}
      </div>
      {/* Search result markers */}
      {searchResults.length > 0 && totalMessages > 0 && (
        <div className="minimap-search-markers">
          {searchResults.map((msgIndex, i) => {
            const ratio = msgIndex / totalMessages
            const isCurrent = searchResults[currentSearchIndex] === msgIndex
            return (
              <div
                key={i}
                className={`minimap-search-marker ${isCurrent ? 'current' : ''}`}
                style={{ top: `${ratio * contentRect.height}px` }}
                onClick={(e) => {
                  e.stopPropagation()
                  if (onSearchResultClick) {
                    onSearchResultClick(i)
                  } else {
                    onNavigate(ratio)
                  }
                }}
                title={`Search result ${i + 1} of ${searchResults.length}`}
              />
            )
          })}
        </div>
      )}
      <div className="minimap-viewport" ref={viewportRef} />
      <div className="minimap-resize-handle" title="Drag to resize">═</div>
    </div>
  )
}
