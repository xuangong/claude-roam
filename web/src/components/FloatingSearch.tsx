import { useState, useEffect, useCallback, useRef } from 'react'

interface FloatingSearchProps {
  totalResults: number
  currentIndex: number
  onSearch: (query: string) => void
  onNext: () => void
  onPrev: () => void
  onClose: () => void
}

export function FloatingSearch({
  totalResults,
  currentIndex,
  onSearch,
  onNext,
  onPrev,
  onClose
}: FloatingSearchProps) {
  const [query, setQuery] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  // Focus input on mount
  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  // Handle keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose()
      } else if (e.key === 'Enter') {
        if (e.shiftKey) {
          onPrev()
        } else {
          onNext()
        }
      } else if (e.key === 'F3' || (e.ctrlKey && e.key === 'g')) {
        e.preventDefault()
        if (e.shiftKey) {
          onPrev()
        } else {
          onNext()
        }
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose, onNext, onPrev])

  const handleChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value
    setQuery(value)
    onSearch(value)
  }, [onSearch])

  return (
    <div className="floating-search">
      <div className="floating-search-icon">🔍</div>
      <input
        ref={inputRef}
        type="text"
        value={query}
        onChange={handleChange}
        placeholder="Search in conversation..."
        className="floating-search-input"
      />
      {totalResults > 0 && (
        <span className="floating-search-count">
          {currentIndex + 1} / {totalResults}
        </span>
      )}
      {totalResults === 0 && query.trim() && (
        <span className="floating-search-no-results">No results</span>
      )}
      <div className="floating-search-nav">
        <button
          onClick={onPrev}
          disabled={totalResults === 0}
          className="floating-search-btn"
          title="Previous (Shift+Enter)"
        >
          ↑
        </button>
        <button
          onClick={onNext}
          disabled={totalResults === 0}
          className="floating-search-btn"
          title="Next (Enter)"
        >
          ↓
        </button>
      </div>
      <button onClick={onClose} className="floating-search-close" title="Close (Esc)">
        ✕
      </button>
    </div>
  )
}
