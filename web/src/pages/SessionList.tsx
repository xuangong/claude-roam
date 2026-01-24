import { useState, useEffect, useCallback } from 'react'
import { Link } from 'react-router-dom'
import { getGroupedSessions, searchContent, type GroupedSessionItem, type SearchResultItem } from '../api'

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

  const fetchSessions = useCallback(async () => {
    try {
      setLoading(true)
      setError(null)
      const response = await getGroupedSessions()
      setSessions(response.sessions)
      const machines = new Set(response.sessions.map(s => s.machine_name || 'unknown'))
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

  // Group by machine and directory
  const groupedData: GroupedData = {}
  for (const session of sessions) {
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

  return (
    <div className="session-list-page">
      <header className="header">
        <h1>Claude Roam</h1>
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
      </header>

      {error && <div className="error">ERROR: {error}</div>}

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
                <div key={result.session_id} className="session-card search-result">
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
            {sessions.length} session{sessions.length !== 1 ? 's' : ''} synced
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
                  {Object.entries(folders).map(([folder, folderData]) => {
                    const folderKey = `${machine}:${folder}`
                    const isExpanded = expandedFolders.has(folderKey)
                    return (
                      <div key={folderKey} className="folder-group">
                        <div className="folder-header-row">
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
                              <div key={session.session_id} className="session-card">
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
