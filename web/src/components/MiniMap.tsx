import { useState, useRef, useEffect, useCallback, useMemo } from 'react'

export interface MiniMapItem {
  type: string
  index: number
  heightRatio: number
  treeIndex?: number  // For tree-separator items
}

export interface SeparatorPosition {
  ratio: number
  index: number
}

interface MiniMapProps {
  items: MiniMapItem[]
  visibleStart: number
  visibleEnd: number
  onNavigate: (ratio: number) => void
  totalMessages?: number  // For position indicator
  separatorPositions?: SeparatorPosition[]  // Pre-calculated separator positions
  searchResults?: number[]  // Message indices with search matches
  currentSearchIndex?: number  // Currently focused search result
}

export function MiniMap({
  items,
  visibleStart,
  visibleEnd,
  onNavigate,
  totalMessages = 0,
  searchResults = [],
  currentSearchIndex = -1
}: MiniMapProps) {
  const minimapRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const isDragging = useRef(false)
  const isResizing = useRef(false)
  const isMoving = useRef(false)
  const dragOffset = useRef({ x: 0, y: 0 })
  const [, forceUpdate] = useState(0)
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
      setIsDraggingState(false)
      setHoverRatio(null)
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
  }, [onNavigate])

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

  const handleRulerClick = useCallback((ratio: number) => {
    onNavigate(ratio)
  }, [onNavigate])

  // Calculate viewport position relative to ruler
  const rulerViewportTop = visibleStart * contentRect.height
  const rulerViewportHeight = (visibleEnd - visibleStart) * contentRect.height

  // Current message index based on ratio (for position indicator)
  const currentMessageIndex = hoverRatio !== null
    ? Math.floor(hoverRatio * totalMessages) + 1
    : Math.floor(visibleStart * totalMessages) + 1
  const showIndicator = isDraggingState && totalMessages > 0

  return (
    <div
      className="minimap"
      ref={minimapRef}
      style={{ top: `${position.top}px`, right: `${position.right}px`, height: `${height}px`, maxHeight: 'none' }}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
    >
      <div className="minimap-move-handle" title="Drag to move">⋮⋮</div>
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
          style={{ top: `${rulerViewportTop}px`, height: `${Math.max(rulerViewportHeight, 4)}px` }}
        />
        {visibleSeparatorPositions.map((pos, i) => (
          <div
            key={i}
            className="minimap-ruler-tick"
            style={{ top: `${pos.ratio * contentRect.height}px` }}
            onClick={(e) => { e.stopPropagation(); handleRulerClick(pos.ratio) }}
            title={`Conversation ${pos.index}`}
          >
            <span className="minimap-ruler-label">{pos.index}</span>
          </div>
        ))}
      </div>
      <div className="minimap-content" ref={contentRef}>
        {items.map((item, i) => (
          <div key={i} className={`minimap-item minimap-${item.type}`} style={{ flex: `${item.heightRatio} 0 0` }} />
        ))}
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
                onClick={(e) => { e.stopPropagation(); onNavigate(ratio) }}
                title={`Search result ${i + 1}`}
              />
            )
          })}
        </div>
      )}
      <div className="minimap-viewport" style={{ top: `${viewportTop}px`, height: `${viewportHeight}px` }} />
      <div className="minimap-resize-handle" title="Drag to resize">═</div>
    </div>
  )
}
