/**
 * TauriApp - Entry point for Tauri desktop application
 * Provides a native desktop experience with file watching and SQLite storage
 */

import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import {
  isTauri,
  listSessions,
  listProjects,
  getProjectSessions,
  scanSessions,
  onSessionChanged,
  exportRoam,
  importRoam,
  type SessionMeta,
  type ProjectInfo,
  type ScanResult,
} from './utils/tauriStore'
import SessionDetail from './pages/SessionDetail'
import './App.css'

type Theme = 'light' | 'dark'
type SortKey = 'time' | 'size' | 'messages'
type SortDir = 'asc' | 'desc'
type ViewMode = 'list' | 'directory'

interface DirTreeNode {
  name: string
  fullPath: string
  children: Map<string, DirTreeNode>
  projects: ProjectInfo[]
  totalSessions: number
}

// Shared session rendering props
interface SessionRenderProps {
  dirSessions: Record<string, SessionMeta[]>
  loadProjectSessions: (encodedDir: string) => void
  selectedId: string | null
  onSelect: (id: string) => void
  filterText: string
  sortKey: SortKey
  sortDir: SortDir
  formatDate: (ts: number) => string
  formatSize: (bytes: number) => string
}

/** Sort sessions by the active sort key */
function sortSessions(sessions: SessionMeta[], sortKey: SortKey, sortDir: SortDir): SessionMeta[] {
  return [...sessions].sort((a, b) => {
    let cmp = 0
    switch (sortKey) {
      case 'time': cmp = a.lastModified - b.lastModified; break
      case 'size': cmp = a.fileSize - b.fileSize; break
      case 'messages': cmp = a.messageCount - b.messageCount; break
    }
    return sortDir === 'desc' ? -cmp : cmp
  })
}

/** Check if directory segments match the filter (so we skip session-level filtering) */
function dirMatchesFilter(encodedDir: string, filterQ: string): boolean {
  if (!filterQ) return false
  return encodedDir.toLowerCase().includes(filterQ) ||
    encodedDir.replace(/^-/, '').split('-').some(seg => seg.toLowerCase().includes(filterQ))
}

/** Render sessions for a single project directory */
function ProjectSessions({ project, depth, ...props }: { project: ProjectInfo; depth: number } & SessionRenderProps) {
  const { dirSessions, loadProjectSessions, selectedId, onSelect, filterText, sortKey, sortDir, formatDate, formatSize } = props
  const cached = dirSessions[project.encodedDir]
  if (!cached) loadProjectSessions(project.encodedDir)

  const filterQ = filterText.trim().toLowerCase()
  let displayed = cached && filterQ && !dirMatchesFilter(project.encodedDir, filterQ)
    ? cached.filter(s =>
        (s.firstHumanMessage || '').toLowerCase().includes(filterQ) ||
        s.id.toLowerCase().includes(filterQ))
    : cached
  if (displayed) displayed = sortSessions(displayed, sortKey, sortDir)

  const pad = { paddingLeft: depth * 16 + 8 }
  return (
    <div className="folder-sessions">
      {!displayed ? (
        <div className="folder-loading" style={pad}>Loading...</div>
      ) : displayed.length === 0 ? (
        <div className="folder-loading" style={pad}>No matching sessions</div>
      ) : displayed.map(s => (
        <div key={s.id} className={`session-item ${selectedId === s.id ? 'selected' : ''}`} style={pad} onClick={() => onSelect(s.id)}>
          <div className="session-item-title" title={s.firstHumanMessage || s.id}>{s.firstHumanMessage || s.id}</div>
          <div className="session-item-meta">
            <span className="session-stats">{s.messageCount} msgs {'\u2022'} {formatSize(s.fileSize)}</span>
            <span className="session-date">{formatDate(s.lastModified)}</span>
          </div>
        </div>
      ))}
    </div>
  )
}

function buildDirTree(projects: ProjectInfo[]): DirTreeNode {
  const root: DirTreeNode = { name: '', fullPath: '', children: new Map(), projects: [], totalSessions: 0 }

  for (const p of projects) {
    // encodedDir format: "-Users-zhangxian-projects-foo" (/ replaced with -)
    // Convert to path segments: strip leading "-", split by "-"
    // This is imperfect (folder names with "-" get split), but the tree
    // self-corrects because sessions only attach to the full matching leaf node
    const parts = p.encodedDir.replace(/^-/, '').split('-').filter(Boolean)
    let node = root
    let path = ''
    for (const part of parts) {
      path += '/' + part
      if (!node.children.has(part)) {
        node.children.set(part, { name: part, fullPath: path, children: new Map(), projects: [], totalSessions: 0 })
      }
      node = node.children.get(part)!
    }
    node.projects.push(p)
  }

  // Propagate totalSessions up
  function propagate(node: DirTreeNode): number {
    let sum = node.projects.reduce((s, p) => s + p.sessionCount, 0)
    for (const child of node.children.values()) {
      sum += propagate(child)
    }
    node.totalSessions = sum
    return sum
  }
  propagate(root)

  // Collapse single-child chains that have no projects
  // e.g. Users > zhangxian > projects → Users/zhangxian/projects
  // This fixes the "-" split issue: "claude-roam" becomes "claude > roam",
  // but since neither has projects, they collapse to "claude/roam"
  function collapse(node: DirTreeNode): DirTreeNode {
    while (node.children.size === 1 && node.projects.length === 0) {
      const child = [...node.children.values()][0]
      node.name = node.name ? node.name + '/' + child.name : child.name
      node.fullPath = child.fullPath
      node.children = child.children
      node.projects = child.projects
    }
    const collapsed = new Map<string, DirTreeNode>()
    for (const [, child] of node.children) {
      const c = collapse(child)
      collapsed.set(c.name, c)
    }
    node.children = collapsed
    return node
  }
  collapse(root)

  return root
}

// Recursive tree node renderer
function DirTreeNodeView({
  node, depth, expandedDirs, toggleDir, ...sessionProps
}: {
  node: DirTreeNode
  depth: number
  expandedDirs: Set<string>
  toggleDir: (key: string) => void
} & SessionRenderProps) {
  const { loadProjectSessions, filterText } = sessionProps

  const sortedChildren = useMemo(() =>
    [...node.children.values()].sort((a, b) => a.name.localeCompare(b.name)),
    [node.children]
  )

  return (
    <>
      {sortedChildren.map(child => {
        const hasLeafProjects = child.projects.length > 0
        const hasSubDirs = child.children.size > 0
        const isOpen = filterText.trim().length > 0 || expandedDirs.has(child.fullPath)

        return (
          <div key={child.fullPath} className="dir-tree-node">
            <div
              className={`dir-tree-header ${isOpen ? 'expanded' : ''}`}
              style={{ paddingLeft: depth * 16 + 8 }}
              onClick={() => {
                toggleDir(child.fullPath)
                if (!isOpen && hasLeafProjects) {
                  for (const p of child.projects) loadProjectSessions(p.encodedDir)
                }
              }}
            >
              <span className="toggle-icon">
                {(hasSubDirs || hasLeafProjects) ? (isOpen ? '\u25BE' : '\u25B8') : ''}
              </span>
              <span className="dir-tree-name" title={child.name}>{child.name}</span>
              {child.totalSessions > 0 && <span className="folder-count">({child.totalSessions})</span>}
            </div>
            {isOpen && (
              <div className="dir-tree-children">
                {hasLeafProjects && child.projects.map(p =>
                  <ProjectSessions key={p.encodedDir} project={p} depth={depth + 1} {...sessionProps} />
                )}
                {hasSubDirs && (
                  <DirTreeNodeView node={child} depth={depth + 1} expandedDirs={expandedDirs} toggleDir={toggleDir} {...sessionProps} />
                )}
              </div>
            )}
          </div>
        )
      })}
    </>
  )
}

// Session list component for Tauri
function TauriSessionList({
  sessions,
  projects,
  selectedId,
  onSelect,
  onRefresh,
  onToggleTheme,
  onImport,
  theme,
}: {
  sessions: SessionMeta[]
  projects: ProjectInfo[]
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
  const [viewMode, setViewMode] = useState<ViewMode>(() => {
    return (localStorage.getItem('session-view-mode') as ViewMode) || 'directory'
  })
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set())
  const [dirSessions, setDirSessions] = useState<Record<string, SessionMeta[]>>({})
  const [filterFocused, setFilterFocused] = useState(false)
  const [autoExpandedOnce, setAutoExpandedOnce] = useState(false)

  const dirTree = useMemo(() => {
    if (!filterText.trim()) return buildDirTree(projects)
    const q = filterText.toLowerCase()
    const filtered = projects.filter(p => {
      // Match against encodedDir segments (directory field is same as encodedDir)
      if (p.encodedDir.toLowerCase().includes(q)) return true
      // Match against decoded segments (split by -)
      const segments = p.encodedDir.replace(/^-/, '').split('-')
      if (segments.some(seg => seg.toLowerCase().includes(q))) return true
      // Match sessions inside (if loaded)
      const cached = dirSessions[p.encodedDir]
      if (cached) {
        return cached.some(s =>
          (s.firstHumanMessage || '').toLowerCase().includes(q) ||
          s.id.toLowerCase().includes(q)
        )
      }
      return false
    })
    return buildDirTree(filtered)
  }, [projects, filterText, dirSessions])

  // Auto-expand first few levels on initial load
  useEffect(() => {
    if (autoExpandedOnce || projects.length === 0) return
    setAutoExpandedOnce(true)
    const paths = new Set<string>()
    // Include root key if root was collapsed
    if (dirTree.name) {
      paths.add(dirTree.fullPath || '/' + dirTree.name)
    }
    // Collect paths for the first 3 depth levels
    function collectPaths(node: DirTreeNode, depth: number) {
      if (depth >= 3) return
      for (const child of node.children.values()) {
        paths.add(child.fullPath)
        collectPaths(child, depth + 1)
      }
    }
    collectPaths(dirTree, 0)
    if (paths.size > 0) {
      setExpandedDirs(prev => {
        const next = new Set(prev)
        for (const p of paths) next.add(p)
        return next
      })
    }
  }, [dirTree, projects, autoExpandedOnce])

  // When filter is active in directory mode, pre-load sessions for matching projects
  useEffect(() => {
    if (viewMode !== 'directory' || !filterText.trim()) return
    const q = filterText.toLowerCase()
    for (const p of projects) {
      if (dirSessions[p.encodedDir]) continue
      // Only load if the project might match by name
      const segments = p.encodedDir.replace(/^-/, '').split('-')
      if (p.encodedDir.toLowerCase().includes(q) || segments.some(seg => seg.toLowerCase().includes(q))) {
        loadProjectSessions(p.encodedDir)
      }
    }
  }, [viewMode, filterText, projects])

  const toggleViewMode = () => {
    const next = viewMode === 'list' ? 'directory' : 'list'
    setViewMode(next)
    localStorage.setItem('session-view-mode', next)

    // When switching to directory mode, expand to the selected session
    if (next === 'directory' && selectedId) {
      const session = sessions.find(s => s.id === selectedId)
      if (session) {
        // Build tree path from encodedDir segments
        const parts = session.encodedDir.replace(/^-/, '').split('-').filter(Boolean)
        let path = ''
        const paths: string[] = []
        for (const part of parts) {
          path += '/' + part
          paths.push(path)
        }
        setExpandedDirs(prev => {
          const next = new Set(prev)
          if (dirTree.fullPath) next.add(dirTree.fullPath)
          for (const p of paths) next.add(p)
          return next
        })
        loadProjectSessions(session.encodedDir)
      }
    }

    // Scroll to selected session after DOM updates
    if (selectedId) {
      const scrollToSelected = (retries = 5) => {
        const el = document.querySelector('.session-item.selected')
        if (el) {
          el.scrollIntoView({ block: 'center', behavior: 'smooth' })
        } else if (retries > 0) {
          setTimeout(() => scrollToSelected(retries - 1), 150)
        }
      }
      setTimeout(() => scrollToSelected(), 100)
    }
  }

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir(d => d === 'desc' ? 'asc' : 'desc')
    } else {
      setSortKey(key)
      setSortDir('desc')
    }
  }

  const toggleDir = useCallback((nodeKey: string) => {
    setExpandedDirs(prev => {
      const next = new Set(prev)
      if (next.has(nodeKey)) {
        next.delete(nodeKey)
      } else {
        next.add(nodeKey)
      }
      return next
    })
  }, [])

  const loadProjectSessions = useCallback(async (encodedDir: string) => {
    if (dirSessions[encodedDir]) return
    try {
      const sessions = await getProjectSessions(encodedDir)
      setDirSessions(prev => ({ ...prev, [encodedDir]: sessions }))
    } catch (err) {
      console.error('Failed to load project sessions:', err)
    }
  }, [dirSessions])

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
          onFocus={() => setFilterFocused(true)}
          onBlur={() => setFilterFocused(false)}
          onKeyDown={e => { if (e.key === 'Escape') { e.currentTarget.blur() } }}
        />
        {!filterFocused && (
          <div className="session-sort-btns">
          <button
            className={`mode-btn ${viewMode === 'directory' ? 'active' : ''}`}
            onClick={toggleViewMode}
            title={viewMode === 'list' ? 'Switch to directory view' : 'Switch to list view'}
          >
            {viewMode === 'list' ? '\u{1F4C1}' : '\u{1F4CB}'}
          </button>
          <span className="sort-divider" />
          <button
            className={`sort-btn ${sortKey === 'time' ? 'active' : ''}`}
            onClick={() => toggleSort('time')}
            title="Sort by time"
          >
            {'\u{1F550}'}{sortKey === 'time' ? (sortDir === 'desc' ? '\u2193' : '\u2191') : ''}
          </button>
          <button
            className={`sort-btn ${sortKey === 'size' ? 'active' : ''}`}
            onClick={() => toggleSort('size')}
            title="Sort by file size"
          >
            {'\u{1F4E6}'}{sortKey === 'size' ? (sortDir === 'desc' ? '\u2193' : '\u2191') : ''}
          </button>
          <button
            className={`sort-btn ${sortKey === 'messages' ? 'active' : ''}`}
            onClick={() => toggleSort('messages')}
            title="Sort by message count"
          >
            {'\u{1F4AC}'}{sortKey === 'messages' ? (sortDir === 'desc' ? '\u2193' : '\u2191') : ''}
          </button>
        </div>
        )}
      </div>
      <div className="session-list-content">
        {viewMode === 'list' ? (
          // Flat list view (chronological)
          sortedSessions.length === 0 ? (
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
                    {session.messageCount} msgs {'\u2022'} {formatSize(session.fileSize)}
                  </span>
                  <span className="session-date">
                    {formatDate(session.lastModified)}
                  </span>
                </div>
              </div>
            ))
          )
        ) : (
          // Directory tree view
          projects.length === 0 ? (
            <div className="empty-state">
              <p>{filterText ? 'No matching projects' : 'No projects found'}</p>
            </div>
          ) : (() => {
            const sessionRenderProps: SessionRenderProps = {
              dirSessions, loadProjectSessions, selectedId, onSelect,
              filterText, sortKey, sortDir, formatDate, formatSize,
            }
            const rootKey = dirTree.fullPath || '/' + dirTree.name
            const isRootOpen = filterText.trim().length > 0 || expandedDirs.has(rootKey)

            if (!dirTree.name) {
              return <DirTreeNodeView node={dirTree} depth={0} expandedDirs={expandedDirs} toggleDir={toggleDir} {...sessionRenderProps} />
            }

            return (
              <div className="dir-tree-node">
                <div className={`dir-tree-header ${isRootOpen ? 'expanded' : ''}`} style={{ paddingLeft: 8 }} onClick={() => toggleDir(rootKey)}>
                  <span className="toggle-icon">{isRootOpen ? '\u25BE' : '\u25B8'}</span>
                  <span className="dir-tree-name">{'/' + dirTree.name}</span>
                  <span className="folder-count">({dirTree.totalSessions})</span>
                </div>
                {isRootOpen && (
                  <>
                    {dirTree.projects.map(p =>
                      <ProjectSessions key={p.encodedDir} project={p} depth={1} {...sessionRenderProps} />
                    )}
                    <DirTreeNodeView node={dirTree} depth={1} expandedDirs={expandedDirs} toggleDir={toggleDir} {...sessionRenderProps} />
                  </>
                )}
              </div>
            )
          })()
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
  const [projects, setProjects] = useState<ProjectInfo[]>([])
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
        const [list, projectList] = await Promise.all([
          listSessions({ limit: 100 }),
          listProjects(),
        ])
        console.log('[TauriApp] Loaded sessions:', list.length, 'projects:', projectList.length)
        setSessions(list)
        setProjects(projectList)

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
            const [updatedList, updatedProjects] = await Promise.all([
              listSessions({ limit: 100 }),
              listProjects(),
            ])
            setSessions(updatedList)
            setProjects(updatedProjects)
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
          const [list, projectList] = await Promise.all([
            listSessions(),
            listProjects(),
          ])
          setSessions(list)
          setProjects(projectList)

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

      const [list, projectList] = await Promise.all([
        listSessions({ limit: 100 }),
        listProjects(),
      ])
      setSessions(list)
      setProjects(projectList)

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

  // Sidebar resize
  const sidebarRef = useRef<HTMLDivElement>(null)
  const MIN_DETAIL_WIDTH = 300
  const MIN_SIDEBAR_WIDTH = 220

  const clampWidth = useCallback((w: number) => {
    const max = window.innerWidth - MIN_DETAIL_WIDTH
    return Math.min(max, Math.max(MIN_SIDEBAR_WIDTH, w))
  }, [])

  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const saved = localStorage.getItem('sidebar-width')
    return saved ? parseInt(saved, 10) : 320
  })

  // Auto-clamp on window resize
  useEffect(() => {
    const onResize = () => {
      setSidebarWidth(prev => clampWidth(prev))
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [clampWidth])

  const onResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    const startX = e.clientX
    const startWidth = sidebarWidth

    const onMove = (e: MouseEvent) => {
      const newWidth = clampWidth(startWidth + (e.clientX - startX))
      setSidebarWidth(newWidth)
    }
    const onUp = () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      // Persist
      const el = sidebarRef.current
      if (el) localStorage.setItem('sidebar-width', String(el.offsetWidth))
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
  }, [sidebarWidth])

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
        <div ref={sidebarRef} style={{ width: clampWidth(sidebarWidth), flexShrink: 0 }}>
        <TauriSessionList
          sessions={sessions}
          projects={projects}
          selectedId={selectedSession}
          onSelect={setSelectedSession}
          onRefresh={handleRefresh}
          onToggleTheme={toggleTheme}
          onImport={handleImport}
          theme={theme}
        />
        </div>

        <div
          className="resize-handle"
          onMouseDown={onResizeStart}
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
