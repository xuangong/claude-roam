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

// Create an inline Web Worker for heavy parsing
function createParserWorker(): Worker {
  const workerCode = `
    self.onmessage = function(e) {
      const { base64Text } = e.data;
      try {
        self.postMessage({ type: 'progress', message: 'Decoding base64...' });
        const binaryString = atob(base64Text);

        self.postMessage({ type: 'progress', message: 'Converting to bytes...' });
        const bytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
          bytes[i] = binaryString.charCodeAt(i);
        }

        self.postMessage({ type: 'progress', message: 'Decoding UTF-8...' });
        const jsonText = new TextDecoder('utf-8').decode(bytes);

        self.postMessage({ type: 'progress', message: 'Parsing JSON...' });
        const data = JSON.parse(jsonText);

        self.postMessage({ type: 'done', data: data });
      } catch (err) {
        self.postMessage({ type: 'error', message: err.message });
      }
    };
  `;
  const blob = new Blob([workerCode], { type: 'application/javascript' });
  const url = URL.createObjectURL(blob);
  return new Worker(url);
}

// Load data using Web Worker to avoid blocking UI
function loadDataWithWorker(
  base64Text: string,
  onProgress: (msg: string) => void
): Promise<RoamBundle> {
  return new Promise((resolve, reject) => {
    const worker = createParserWorker();

    worker.onmessage = (e) => {
      const { type, message, data } = e.data;
      if (type === 'progress') {
        onProgress(message);
      } else if (type === 'done') {
        worker.terminate();
        resolve(data as RoamBundle);
      } else if (type === 'error') {
        worker.terminate();
        reject(new Error(message));
      }
    };

    worker.onerror = (err) => {
      worker.terminate();
      reject(new Error(err.message));
    };

    worker.postMessage({ base64Text });
  });
}

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
  const [loadingProgress, setLoadingProgress] = useState<string>('Loading...')

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
    localStorage.setItem('theme', theme)
  }, [theme])

  // Load data from embedded script tag using Web Worker
  useEffect(() => {
    const dataScript = document.getElementById('roam-data-base64')
    if (!dataScript) {
      setError('No data found in page')
      return
    }

    const base64Text = dataScript.textContent || ''
    if (base64Text.startsWith('_') || !base64Text.trim()) {
      setError('No data embedded. Use CLI to open this preview.')
      return
    }

    loadDataWithWorker(base64Text, setLoadingProgress)
      .then((data) => {
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

        sessionList.sort((a, b) => new Date(b.modifiedAt).getTime() - new Date(a.modifiedAt).getTime())
        setSessions(sessionList)
      })
      .catch(err => {
        setError(err instanceof Error ? err.message : 'Failed to parse embedded data')
      })
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
        <div className="loading-container" style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          height: '100vh',
          gap: '16px'
        }}>
          <div className="loading-spinner" style={{
            width: '40px',
            height: '40px',
            border: '3px solid var(--border)',
            borderTopColor: 'var(--accent)',
            borderRadius: '50%',
            animation: 'spin 1s linear infinite'
          }} />
          <div style={{ color: 'var(--text-secondary)', fontSize: '14px' }}>{loadingProgress}</div>
          <style>{`
            @keyframes spin {
              to { transform: rotate(360deg); }
            }
          `}</style>
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
