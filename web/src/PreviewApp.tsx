import { useState, useEffect } from 'react'
import RoamPreviewCore from './pages/RoamPreviewCore'

// Types for roam data
interface RoamSession {
  id: string
  lineCount: number
  modifiedAt: string
  data: string
}

interface RoamBundleV1 {
  version: 1
  exportedAt: string
  source: {
    machineId: string
    machineName: string
    originalPath: string
  }
  session: {
    id: string
    lineCount: number
    modifiedAt: string
  }
  data: string
}

interface RoamBundleV2 {
  version: 2
  exportedAt: string
  source: {
    machineId: string
    machineName: string
    originalPath: string
  }
  sessions: RoamSession[]
}

type RoamBundle = RoamBundleV1 | RoamBundleV2

type Theme = 'light' | 'dark'

function PreviewApp() {
  const [theme, setTheme] = useState<Theme>(() => {
    const saved = localStorage.getItem('theme') as Theme
    if (saved) return saved
    if (window.matchMedia('(prefers-color-scheme: light)').matches) {
      return 'light'
    }
    return 'dark'
  })

  const [bundle, setBundle] = useState<RoamBundle | null>(null)
  const [sessions, setSessions] = useState<RoamSession[]>([])
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
    localStorage.setItem('theme', theme)
  }, [theme])

  // Load data from embedded script tag (base64 encoded)
  useEffect(() => {
    try {
      const dataScript = document.getElementById('roam-data-base64')
      if (!dataScript) {
        setError('No data found in page')
        return
      }

      const base64Text = dataScript.textContent || ''
      // Check if data is the placeholder (not injected yet)
      // Placeholder starts with underscore, valid base64 starts with letter/digit
      if (base64Text.startsWith('_') || !base64Text.trim()) {
        setError('No data embedded. Use CLI to open this preview.')
        return
      }

      // Decode base64 to JSON string (properly handle UTF-8)
      const binaryString = atob(base64Text)
      const bytes = Uint8Array.from(binaryString, c => c.charCodeAt(0))
      const jsonText = new TextDecoder('utf-8').decode(bytes)
      const data = JSON.parse(jsonText) as RoamBundle

      if (!data.version || !data.source) {
        throw new Error('Invalid .roam file format')
      }

      setBundle(data)

      let sessionList: RoamSession[] = []
      if (data.version === 1) {
        const v1 = data as RoamBundleV1
        sessionList = [{
          id: v1.session.id,
          lineCount: v1.session.lineCount,
          modifiedAt: v1.session.modifiedAt,
          data: v1.data
        }]
      } else if (data.version === 2) {
        sessionList = (data as RoamBundleV2).sessions
      }

      // Sort by modifiedAt desc
      sessionList.sort((a, b) => new Date(b.modifiedAt).getTime() - new Date(a.modifiedAt).getTime())
      setSessions(sessionList)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to parse embedded data')
    }
  }, [])

  const toggleTheme = () => {
    setTheme(prev => prev === 'dark' ? 'light' : 'dark')
  }

  if (error) {
    return (
      <div className="app">
        <div className="app-header-controls">
          <button className="theme-toggle" onClick={toggleTheme} title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}>
            {theme === 'dark' ? '\u2600\ufe0f' : '\ud83c\udf19'}
          </button>
        </div>
        <div className="detail-page">
          <div className="detail-header">
            <h1>Claude Roam Preview</h1>
          </div>
          <div className="error" style={{ marginTop: 'var(--space-4)' }}>{error}</div>
        </div>
      </div>
    )
  }

  if (!bundle) {
    return (
      <div className="app">
        <div className="loading-container">
          <div className="loading-spinner" />
        </div>
      </div>
    )
  }

  return (
    <div className="app">
      <div className="app-header-controls">
        <button className="theme-toggle" onClick={toggleTheme} title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}>
          {theme === 'dark' ? '\u2600\ufe0f' : '\ud83c\udf19'}
        </button>
      </div>
      <RoamPreviewCore
        bundle={bundle}
        sessions={sessions}
      />
    </div>
  )
}

export default PreviewApp
