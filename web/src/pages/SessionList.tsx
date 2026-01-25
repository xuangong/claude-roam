import { useState, useEffect, useCallback } from 'react'
import { Link } from 'react-router-dom'
import { getGroupedSessions, searchContent, deleteSession, getPinnedFolders, pinFolder, unpinFolder, type GroupedSessionItem, type SearchResultItem, type PinnedFolder } from '../api'

function formatTimeAgo(dateStr: string): string {
  const date = new Date(dateStr)
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffMins = Math.floor(diffMs / 60000)
  const diffHours = Math.floor(diffMs / 3600000)
  const diffDays = Math.floor(diffMs / 86400000)

  if (diffMins < 1) return 'now'
  if (diffMins < 60) return `${diffMins}m`
  if (diffHours < 24) return `${diffHours}h`
  if (diffDays < 7) return `${diffDays}d`
  return date.toLocaleDateString()
}

function getFolder(path: string | null): string {
  if (!path) return 'unknown'
  const parts = path.split('/').filter(Boolean)
  if (parts.length >= 2) {
    return parts.slice(-2).join('/')
  }
  return parts[parts.length - 1] || 'unknown'
}

interface GroupedData {
  [machine: string]: {
    [folder: string]: {
      sessions: GroupedSessionItem[]
      fullPath: string | null
    }
  }
}

function SessionList() {
  const [sessions, setSessions] = useState<GroupedSessionItem[]>([])
  const [searchResults, setSearchResults] = useState<SearchResultItem[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [searchInput, setSearchInput] = useState('')
  const [isSearching, setIsSearching] = useState(false)
  const [expandedMachines, setExpandedMachines] = useState<Set<string>>(new Set())
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set())
  const [copiedKey, setCopiedKey] = useState<string | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [isDeleting, setIsDeleting] = useState(false)
  const [pinnedFolders, setPinnedFolders] = useState<PinnedFolder[]>([])
  const [minLines, setMinLines] = useState<number>(() => {
    const saved = localStorage.getItem('minLines')
    return saved ? parseInt(saved) : 0
  })

  // Save minLines to localStorage
  useEffect(() => {
    localStorage.setItem('minLines', String(minLines))
  }, [minLines])

  const fetchSessions = useCallback(async () => {
    try {
      setLoading(true)
      setError(null)
      const [sessionsResponse, pinnedResponse] = await Promise.all([
        getGroupedSessions(),
        getPinnedFolders()
      ])
      setSessions(sessionsResponse.sessions)
      setPinnedFolders(pinnedResponse.folders)
      const machines = new Set(sessionsResponse.sessions.map(s => s.machine_name || 'unknown'))
      setExpandedMachines(machines)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load sessions')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchSessions()
  }, [fetchSessions])

  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!searchInput.trim()) {
      setSearchResults(null)
      return
    }

    try {
      setIsSearching(true)
      setError(null)
      const response = await searchContent(searchInput.trim())
      setSearchResults(response.results)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Search failed')
    } finally {
      setIsSearching(false)
    }
  }

  const clearSearch = () => {
    setSearchInput('')
    setSearchResults(null)
  }

  const toggleMachine = (machine: string) => {
    setExpandedMachines(prev => {
      const next = new Set(prev)
      if (next.has(machine)) {
        next.delete(machine)
      } else {
        next.add(machine)
      }
      return next
    })
  }

  const toggleFolder = (key: string) => {
    setExpandedFolders(prev => {
      const next = new Set(prev)
      if (next.has(key)) {
        next.delete(key)
      } else {
        next.add(key)
      }
      return next
    })
  }

  // Filter sessions by minLines
  const filteredSessions = sessions.filter(s => s.total_lines >= minLines)

  // Group by machine and directory
  const groupedData: GroupedData = {}
  for (const session of filteredSessions) {
    const machine = session.machine_name || 'unknown'
    const folder = getFolder(session.original_path)
    if (!groupedData[machine]) {
      groupedData[machine] = {}
    }
    if (!groupedData[machine][folder]) {
      groupedData[machine][folder] = {
        sessions: [],
        fullPath: session.original_path
      }
    }
    groupedData[machine][folder].sessions.push(session)
  }

  // Check if a folder is pinned
  const isPinned = (machine: string, fullPath: string | null): boolean => {
    if (!fullPath) return false
    return pinnedFolders.some(p => p.machine_name === machine && p.original_path === fullPath)
  }

  // Toggle pin status
  const togglePin = async (machine: string, fullPath: string | null, e: React.MouseEvent) => {
    e.stopPropagation()
    if (!fullPath) return

    try {
      if (isPinned(machine, fullPath)) {
        await unpinFolder(machine, fullPath)
        setPinnedFolders(prev => prev.filter(p => !(p.machine_name === machine && p.original_path === fullPath)))
      } else {
        await pinFolder(machine, fullPath)
        setPinnedFolders(prev => [...prev, {
          id: Date.now(),
          user_id: '',
          machine_name: machine,
          original_path: fullPath,
          pinned_at: new Date().toISOString()
        }])
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to toggle pin')
    }
  }

  // Sort folders: pinned first, then by name
  const sortFolders = (folders: [string, { sessions: GroupedSessionItem[]; fullPath: string | null }][], machine: string) => {
    return folders.sort((a, b) => {
      const aPinned = isPinned(machine, a[1].fullPath)
      const bPinned = isPinned(machine, b[1].fullPath)
      if (aPinned && !bPinned) return -1
      if (!aPinned && bPinned) return 1
      return a[0].localeCompare(b[0])
    })
  }

  const copyMapCommand = async (machine: string, fullPath: string | null, folderKey: string) => {
    if (!fullPath) return
    const command = `claude-roam map add "${machine}:${fullPath}"`
    try {
      await navigator.clipboard.writeText(command)
      setCopiedKey(folderKey)
      setTimeout(() => setCopiedKey(null), 2000)
    } catch (err) {
      console.error('Failed to copy:', err)
    }
  }

  const handleDelete = async (sessionId: string, e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()

    if (!confirm(`Delete session ${sessionId.slice(0, 8)}...?`)) {
      return
    }

    try {
      setDeletingId(sessionId)
      await deleteSession(sessionId)
      // Remove from local state
      setSessions(prev => prev.filter(s => s.session_id !== sessionId))
      if (searchResults) {
        setSearchResults(prev => prev ? prev.filter(s => s.session_id !== sessionId) : null)
      }
      // Remove from selection
      setSelectedIds(prev => {
        const next = new Set(prev)
        next.delete(sessionId)
        return next
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete session')
    } finally {
      setDeletingId(null)
    }
  }

  const toggleSelect = (sessionId: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(sessionId)) {
        next.delete(sessionId)
      } else {
        next.add(sessionId)
      }
      return next
    })
  }

  const selectAllInFolder = (folderSessions: GroupedSessionItem[]) => {
    setSelectedIds(prev => {
      const next = new Set(prev)
      const allSelected = folderSessions.every(s => prev.has(s.session_id))
      if (allSelected) {
        // Deselect all
        folderSessions.forEach(s => next.delete(s.session_id))
      } else {
        // Select all
        folderSessions.forEach(s => next.add(s.session_id))
      }
      return next
    })
  }

  const clearSelection = () => {
    setSelectedIds(new Set())
  }

  const handleBatchDelete = async () => {
    if (selectedIds.size === 0) return

    if (!confirm(`Delete ${selectedIds.size} selected session(s)?`)) {
      return
    }

    setIsDeleting(true)
    setError(null)

    const idsToDelete = Array.from(selectedIds)
    let deleted = 0
    let failed = 0

    for (const id of idsToDelete) {
      try {
        await deleteSession(id)
        deleted++
      } catch {
        failed++
      }
    }

    // Update local state
    setSessions(prev => prev.filter(s => !selectedIds.has(s.session_id)))
    if (searchResults) {
      setSearchResults(prev => prev ? prev.filter(s => !selectedIds.has(s.session_id)) : null)
    }
    setSelectedIds(new Set())
    setIsDeleting(false)

    if (failed > 0) {
      setError(`Deleted ${deleted}, failed ${failed}`)
    }
  }

  return (
    <div className="session-list-page">
      <header className="header">
        <h1>Claude Roam</h1>
        <div className="header-controls">
          <Link to="/preview" style={{ marginRight: 'var(--space-4)' }}>
            <button>Load .roam</button>
          </Link>
          <div className="filter-box">
            <label htmlFor="minLines">Min lines:</label>
            <input
              id="minLines"
              type="number"
              min="0"
              value={minLines || ''}
              onChange={e => setMinLines(parseInt(e.target.value) || 0)}
              placeholder="0"
            />
          </div>
          <form className="search-box" onSubmit={handleSearch}>
            <input
              type="text"
              placeholder="$ grep -r 'search query'..."
              value={searchInput}
              onChange={e => setSearchInput(e.target.value)}
            />
            <button type="submit" disabled={isSearching} className="primary">
              {isSearching ? 'Searching' : 'Search'}
            </button>
            {searchResults !== null && (
              <button type="button" onClick={clearSearch} className="clear-btn">
                ✕
              </button>
            )}
          </form>
        </div>
      </header>

      {error && <div className="error">ERROR: {error}</div>}

      {/* Batch Action Bar */}
      {selectedIds.size > 0 && (
        <div className="batch-action-bar">
          <span className="selection-count">{selectedIds.size} selected</span>
          <button className="batch-btn cancel" onClick={clearSelection}>
            Cancel
          </button>
          <button
            className="batch-btn delete"
            onClick={handleBatchDelete}
            disabled={isDeleting}
          >
            {isDeleting ? 'Deleting...' : 'Delete Selected'}
          </button>
        </div>
      )}

      {/* Search Results */}
      {searchResults !== null && (
        <div className="search-results">
          <div className="search-header">
            grep: {searchResults.length} match{searchResults.length !== 1 ? 'es' : ''} for "{searchInput}"
          </div>
          {searchResults.length === 0 ? (
            <div className="no-results">No matches found</div>
          ) : (
            <div className="session-list" style={{ paddingLeft: 0 }}>
              {searchResults.map(result => (
                <div key={result.session_id} className={`session-card search-result ${selectedIds.has(result.session_id) ? 'selected' : ''}`}>
                  <input
                    type="checkbox"
                    className="session-checkbox"
                    checked={selectedIds.has(result.session_id)}
                    onChange={() => toggleSelect(result.session_id)}
                    onClick={(e) => e.stopPropagation()}
                  />
                  <Link to={`/sessions/${result.session_id}`}>
                    <div className="session-id">{result.session_id.slice(0, 8)}</div>
                    {result.snippet && (
                      <div
                        className="session-snippet"
                        dangerouslySetInnerHTML={{ __html: result.snippet }}
                      />
                    )}
                    <div className="session-meta">
                      <span>{result.total_lines} lines</span>
                      <span>{result.machines || 'N/A'}</span>
                      <span>{formatTimeAgo(result.updated_at)}</span>
                    </div>
                  </Link>
                  <button
                    className="delete-btn"
                    onClick={(e) => handleDelete(result.session_id, e)}
                    disabled={deletingId === result.session_id}
                    title="Delete session"
                  >
                    {deletingId === result.session_id ? '...' : '×'}
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Grouped View */}
      {searchResults === null && !loading && (
        <div className="grouped-sessions">
          <div className="session-count">
            {filteredSessions.length} session{filteredSessions.length !== 1 ? 's' : ''}{minLines > 0 ? ` (≥${minLines} lines)` : ''} synced
          </div>

          {Object.entries(groupedData).map(([machine, folders]) => (
            <div key={machine} className="machine-group">
              <div
                className="machine-header"
                onClick={() => toggleMachine(machine)}
              >
                <span className="toggle-icon">
                  {expandedMachines.has(machine) ? '▼' : '▶'}
                </span>
                <span className="machine-name">{machine}</span>
                <span className="machine-count">
                  {Object.values(folders).reduce((sum, f) => sum + f.sessions.length, 0)} sessions
                </span>
              </div>

              {expandedMachines.has(machine) && (
                <div className="folders">
                  {sortFolders(Object.entries(folders), machine).map(([folder, folderData]) => {
                    const folderKey = `${machine}:${folder}`
                    const isExpanded = expandedFolders.has(folderKey)
                    const folderIsPinned = isPinned(machine, folderData.fullPath)
                    return (
                      <div key={folderKey} className={`folder-group ${folderIsPinned ? 'pinned' : ''}`}>
                        <div className="folder-header-row">
                          <button
                            className={`pin-btn ${folderIsPinned ? 'pinned' : ''}`}
                            onClick={(e) => togglePin(machine, folderData.fullPath, e)}
                            title={folderIsPinned ? 'Unpin folder' : 'Pin folder'}
                          >
                            {folderIsPinned ? '★' : '☆'}
                          </button>
                          <div
                            className="folder-header"
                            onClick={() => toggleFolder(folderKey)}
                          >
                            <span className="toggle-icon">
                              {isExpanded ? '▼' : '▶'}
                            </span>
                            <span className="folder-name">{folder}</span>
                            <span className="folder-count">
                              ({folderData.sessions.length})
                            </span>
                          </div>
                          <button
                            className="select-all-btn"
                            onClick={(e) => {
                              e.stopPropagation()
                              selectAllInFolder(folderData.sessions)
                            }}
                            title="Select all in folder"
                          >
                            {folderData.sessions.every(s => selectedIds.has(s.session_id)) ? '☑' : '☐'}
                          </button>
                          {folderData.fullPath && (
                            <button
                              className={`copy-map-btn ${copiedKey === folderKey ? 'copied' : ''}`}
                              onClick={(e) => {
                                e.stopPropagation()
                                copyMapCommand(machine, folderData.fullPath, folderKey)
                              }}
                              title={`Copy: claude-roam map add "${machine}:${folderData.fullPath}"`}
                            >
                              {copiedKey === folderKey ? '✓ copied' : 'copy map'}
                            </button>
                          )}
                        </div>

                        {isExpanded && (
                          <div className="session-list">
                            {folderData.sessions.map(session => (
                              <div key={session.session_id} className={`session-card ${selectedIds.has(session.session_id) ? 'selected' : ''}`}>
                                <input
                                  type="checkbox"
                                  className="session-checkbox"
                                  checked={selectedIds.has(session.session_id)}
                                  onChange={() => toggleSelect(session.session_id)}
                                  onClick={(e) => e.stopPropagation()}
                                />
                                <Link to={`/sessions/${session.session_id}`}>
                                  <div className="session-id">{session.session_id.slice(0, 8)}</div>
                                  {session.first_message && (
                                    <div className="session-message">
                                      {session.first_message.length > 120
                                        ? session.first_message.slice(0, 120) + '...'
                                        : session.first_message}
                                    </div>
                                  )}
                                  <div className="session-meta">
                                    <span>{session.total_lines} lines</span>
                                    <span>{formatTimeAgo(session.updated_at)}</span>
                                  </div>
                                </Link>
                                <button
                                  className="delete-btn"
                                  onClick={(e) => handleDelete(session.session_id, e)}
                                  disabled={deletingId === session.session_id}
                                  title="Delete session"
                                >
                                  {deletingId === session.session_id ? '...' : '×'}
                                </button>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {loading && <div className="loading">Loading sessions</div>}

      {!loading && sessions.length === 0 && searchResults === null && (
        <div className="loading">No sessions found. Run `claude-roam push` to sync.</div>
      )}
    </div>
  )
}

export default SessionList
