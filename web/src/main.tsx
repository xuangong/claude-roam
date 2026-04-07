/**
 * Main entry point - Auto-detects Tauri or browser environment
 */

import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter, MemoryRouter } from 'react-router-dom'
import App from './App'
import TauriApp from './TauriApp'
import { isTauri } from './utils/tauriStore'
import './index.css'

// Debug info
const debugInfo = {
  isTauri: isTauri(),
  hasTauriInternals: typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window,
  userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : 'N/A',
}

console.log('[main.tsx] Debug info:', debugInfo)

// Global error handler
window.onerror = (message, source, lineno, colno, error) => {
  console.error('[Global Error]', { message, source, lineno, colno, error })
  const root = document.getElementById('root')
  if (root) {
    root.innerHTML = `
      <div style="padding: 20px; font-family: monospace; color: #ff6b6b; background: #1a1a2e;">
        <h2>JavaScript Error</h2>
        <p><strong>Message:</strong> ${message}</p>
        <p><strong>Source:</strong> ${source}:${lineno}:${colno}</p>
        <pre style="background: #16213e; padding: 10px; overflow: auto;">${error?.stack || 'No stack trace'}</pre>
      </div>
    `
  }
}

// Unhandled promise rejection handler
window.onunhandledrejection = (event) => {
  console.error('[Unhandled Promise Rejection]', event.reason)
}

// Show loading state immediately
const root = document.getElementById('root')
if (root) {
  root.innerHTML = '<div style="padding: 20px; color: #888;">Loading... (isTauri: ' + debugInfo.isTauri + ')</div>'
}

try {
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      {isTauri() ? (
        <MemoryRouter>
          <TauriApp />
        </MemoryRouter>
      ) : (
        <BrowserRouter>
          <App />
        </BrowserRouter>
      )}
    </React.StrictMode>
  )
  console.log('[main.tsx] React render called successfully')
} catch (e) {
  console.error('[main.tsx] React render failed:', e)
  if (root) {
    root.innerHTML = `
      <div style="padding: 20px; font-family: monospace; color: #ff6b6b; background: #1a1a2e;">
        <h2>React Render Error</h2>
        <pre style="background: #16213e; padding: 10px; overflow: auto;">${e instanceof Error ? e.stack : String(e)}</pre>
      </div>
    `
  }
}
