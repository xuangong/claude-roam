/**
 * TauriApp - Entry point for Tauri desktop application
 * Provides a native desktop experience with file watching and SQLite storage
 */

import { useState, useEffect, useCallback, useMemo } from 'react'
import {
  isTauri,
  listSessions,
  scanSessions,
  onSessionChanged,
  exportRoam,
  importRoam,
  type SessionMeta,
  type ScanResult,
} from './utils/tauriStore'
import SessionDetail from './pages/SessionDetail'
import './App.css'

type Theme = 'light' | 'dark'
type SortKey = 'time' | 'size' | 'messages'
type SortDir = 'asc' | 'desc'

// Session list component for Tauri
function TauriSessionList({
  sessions,
  selectedId,
  onSelect,
  onRefresh,
  onToggleTheme,
  onImport,
  theme,
}: {
  sessions: SessionMeta[]
  selectedId: string | null
  onSelect: (id: string) => void
  onRefresh: () => void
  onToggleTheme: () => void
  onImport: () => void
  theme: Theme
}) {
  const [sortKey, setSortKey] = useState<SortKey>('time')
  const [sortDir, setSortDir] = useState<SortDir>('desc')
  const [filterText, setFilterText] = useState('')

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir(d => d === 'desc' ? 'asc' : 'desc')
    } else {
      setSortKey(key)
      setSortDir('desc')
    }
  }

  const sortedSessions = useMemo(() => {
    let filtered = sessions
    if (filterText.trim()) {
      const q = filterText.toLowerCase()
      filtered = sessions.filter(s =>
        (s.firstHumanMessage || '').toLowerCase().includes(q) ||
        s.directory.toLowerCase().includes(q) ||
        s.id.toLowerCase().includes(q)
      )
    }

    const sorted = [...filtered].sort((a, b) => {
      let cmp = 0
      switch (sortKey) {
        case 'time': cmp = a.lastModified - b.lastModified; break
        case 'size': cmp = a.fileSize - b.fileSize; break
        case 'messages': cmp = a.messageCount - b.messageCount; break
      }
      return sortDir === 'desc' ? -cmp : cmp
    })
    return sorted
  }, [sessions, sortKey, sortDir, filterText])
  const formatDate = (timestamp: number) => {
    const date = new Date(timestamp * 1000)
    return date.toLocaleDateString() + ' ' + date.toLocaleTimeString()
  }

  const formatSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  }

  return (
    <div className="session-list">
      <div className="session-list-header">
        <h2>Sessions</h2>
        <div style={{ display: 'flex', gap: '4px' }}>
          <button className="refresh-btn" onClick={onImport} title="Load .roam file">
            📂
          </button>
          <button className="refresh-btn" onClick={onToggleTheme} title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}>
            {theme === 'dark' ? '☀️' : '🌙'}
          </button>
          <button className="refresh-btn" onClick={onRefresh} title="Refresh sessions">
            ↻
          </button>
        </div>
      </div>
      <div className="session-list-toolbar">
        <input
          className="session-filter-input"
          type="text"
          placeholder="Filter..."
          value={filterText}
          onChange={e => setFilterText(e.target.value)}
        />
        <div className="session-sort-btns">
          <button
            className={`sort-btn ${sortKey === 'time' ? 'active' : ''}`}
            onClick={() => toggleSort('time')}
            title="Sort by time"
          >
            🕐{sortKey === 'time' ? (sortDir === 'desc' ? '↓' : '↑') : ''}
          </button>
          <button
            className={`sort-btn ${sortKey === 'size' ? 'active' : ''}`}
            onClick={() => toggleSort('size')}
            title="Sort by file size"
          >
            📦{sortKey === 'size' ? (sortDir === 'desc' ? '↓' : '↑') : ''}
          </button>
          <button
            className={`sort-btn ${sortKey === 'messages' ? 'active' : ''}`}
            onClick={() => toggleSort('messages')}
            title="Sort by message count"
          >
            💬{sortKey === 'messages' ? (sortDir === 'desc' ? '↓' : '↑') : ''}
          </button>
        </div>
      </div>
      <div className="session-list-content">
        {sortedSessions.length === 0 ? (
          <div className="empty-state">
            <p>{filterText ? 'No matching sessions' : 'No sessions found'}</p>
            <p className="hint">{filterText ? 'Try a different search' : 'Claude Code sessions will appear here'}</p>
          </div>
        ) : (
          sortedSessions.map((session) => (
            <div
              key={session.id}
              className={`session-item ${selectedId === session.id ? 'selected' : ''}`}
              onClick={() => onSelect(session.id)}
            >
              <div className="session-item-title">
                {session.firstHumanMessage || session.id}
              </div>
              <div className="session-item-meta">
                <span className="session-dir" title={session.directory}>
                  {session.directory.split('/').slice(-2).join('/')}
                </span>
                <span className="session-stats">
                  {session.messageCount} msgs • {formatSize(session.fileSize)}
                </span>
                <span className="session-date">
                  {formatDate(session.lastModified)}
                </span>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  )
}

// Loading screen
function LoadingScreen({ message }: { message: string }) {
  return (
    <div className="loading-container">
      <div className="loading-spinner" />
      <p>{message}</p>
    </div>
  )
}

// Scan progress indicator
function ScanProgress({ result }: { result: ScanResult | null }) {
  if (!result) return null

  return (
    <div className="scan-progress">
      <div className="scan-stats">
        <span>Total: {result.totalSessions}</span>
        <span>New: {result.newSessions}</span>
        <span>Updated: {result.updatedSessions}</span>
        <span>Time: {result.duration_ms}ms</span>
      </div>
    </div>
  )
}

// Main TauriApp component
export function TauriApp() {
  const [theme, setTheme] = useState<Theme>(() => {
    const saved = localStorage.getItem('theme') as Theme
    if (saved) return saved
    if (window.matchMedia('(prefers-color-scheme: light)').matches) {
      return 'light'
    }
    return 'dark'
  })

  const [sessions, setSessions] = useState<SessionMeta[]>([])
  const [selectedSession, setSelectedSession] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [scanning, setScanning] = useState(false)
  const [scanResult, setScanResult] = useState<ScanResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Apply theme
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
    localStorage.setItem('theme', theme)
  }, [theme])

  // Initial scan and load
  useEffect(() => {
    const init = async () => {
      try {
        setLoading(true)
        setError(null)
        console.log('[TauriApp] Starting initialization...')

        // First, try to load from existing database (fast)
        console.log('[TauriApp] Loading sessions from database...')
        const list = await listSessions({ limit: 100 })
        console.log('[TauriApp] Loaded sessions:', list.length)
        setSessions(list)

        // Auto-select first session if available
        if (list.length > 0 && !selectedSession) {
          setSelectedSession(list[0].id)
        }

        // Now we can show UI while scanning in background
        setLoading(false)
        console.log('[TauriApp] UI ready, starting background scan...')

        // Scan file system in background (may take time for large collections)
        try {
          const result = await scanSessions(false)
          setScanResult(result)
          console.log('[TauriApp] Scan complete:', result)

          // Refresh list if scan found changes
          if (result.newSessions > 0 || result.updatedSessions > 0 || result.deletedSessions > 0) {
            const updatedList = await listSessions({ limit: 100 })
            setSessions(updatedList)
          }
        } catch (scanErr) {
          console.error('[TauriApp] Scan error (non-fatal):', scanErr)
        }
      } catch (err) {
        console.error('[TauriApp] Init error:', err)
        setError(String(err))
        setLoading(false)
      }
    }

    init()
  }, [])

  // Listen for session changes
  useEffect(() => {
    if (!isTauri()) return

    let unlisten: (() => void) | undefined

    const setup = async () => {
      unlisten = await onSessionChanged(async (event) => {
        console.log('Session changed:', event)

        // Refresh session list
        try {
          const list = await listSessions()
          setSessions(list)

          // If the changed session is selected, refresh it
          if (event.sessionId === selectedSession) {
            // Force re-render
            setSelectedSession(null)
            setTimeout(() => setSelectedSession(event.sessionId), 0)
          }
        } catch (err) {
          console.error('Failed to refresh sessions:', err)
        }
      })
    }

    setup()

    return () => {
      if (unlisten) unlisten()
    }
  }, [selectedSession])

  // Refresh handler
  const handleRefresh = useCallback(async () => {
    try {
      setScanning(true)
      setScanResult(null)

      const result = await scanSessions(true)
      setScanResult(result)

      const list = await listSessions({ limit: 100 })
      setSessions(list)

      setScanning(false)
    } catch (err) {
      setError(String(err))
      setScanning(false)
    }
  }, [])

  const toggleTheme = () => {
    setTheme((prev) => (prev === 'dark' ? 'light' : 'dark'))
  }

  // Import .roam file
  const handleImport = useCallback(async () => {
    try {
      const { open } = await import('@tauri-apps/plugin-dialog')
      const selected = await open({
        filters: [{ name: 'Roam Files', extensions: ['roam'] }],
        multiple: false,
      })
      if (!selected) return

      const filePath = selected as string
      const result = await importRoam(filePath)
      alert(`Imported ${result.imported} session(s), skipped ${result.skipped}\nSource: ${result.source}`)

      // Refresh session list and rescan
      const scanResult = await scanSessions(true)
      setScanResult(scanResult)
      const list = await listSessions({ limit: 100 })
      setSessions(list)
    } catch (err) {
      alert(`Import failed: ${err}`)
    }
  }, [])

  // Export selected session to .roam file
  const handleExport = useCallback(async () => {
    try {
      if (!selectedSession) {
        alert('No session selected')
        return
      }

      const { save } = await import('@tauri-apps/plugin-dialog')
      const now = new Date()
      const timestamp = `${now.toISOString().slice(0, 10).replace(/-/g, '')}_${now.toTimeString().slice(0, 8).replace(/:/g, '')}`
      const defaultName = `claude-roam_${timestamp}.roam`

      const outputPath = await save({
        filters: [{ name: 'Roam Files', extensions: ['roam'] }],
        defaultPath: defaultName,
      })
      if (!outputPath) return

      const result = await exportRoam([selectedSession], outputPath)
      alert(result)
    } catch (err) {
      alert(`Export failed: ${err}`)
    }
  }, [selectedSession])

  // Show error state
  if (error) {
    return (
      <div className="app">
        <div className="error-container">
          <h2>Error</h2>
          <p>{error}</p>
          <button onClick={() => window.location.reload()}>Reload</button>
        </div>
      </div>
    )
  }

  // Show loading state
  if (loading) {
    return (
      <div className="app">
        <LoadingScreen message="Scanning sessions..." />
      </div>
    )
  }

  return (
    <div className="app tauri-app">
      <div className="app-content">
        <TauriSessionList
          sessions={sessions}
          selectedId={selectedSession}
          onSelect={setSelectedSession}
          onRefresh={handleRefresh}
          onToggleTheme={toggleTheme}
          onImport={handleImport}
          theme={theme}
        />

        <div className="session-detail-container">
          {scanning && <ScanProgress result={scanResult} />}

          {selectedSession ? (
            <SessionDetail
              key={selectedSession}
              sessionId={selectedSession}
              useTauri={true}
              onExport={handleExport}
            />
          ) : (
            <div className="no-selection">
              <p>Select a session to view</p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

export default TauriApp
