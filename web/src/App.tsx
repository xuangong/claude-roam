import { useState, useEffect, createContext, useContext } from 'react'
import { Routes, Route } from 'react-router-dom'
import SessionList from './pages/SessionList'
import SessionDetail from './pages/SessionDetail'
import RoamPreview from './pages/RoamPreview'
import AuthCallback from './pages/AuthCallback'
import LoginPage from './pages/LoginPage'
import { getCurrentUser, logout, getGitHubLoginUrl, User } from './api'
import { isLocalDev } from './utils/tauriStore'
import './App.css'

type Theme = 'light' | 'dark'

// Auth context to share user state and login function
interface AuthContextType {
  user: User | null
  loadingUser: boolean
  handleLogin: () => void
  handleLogout: () => void
  setUser: (user: User | null) => void
}

export const AuthContext = createContext<AuthContextType | null>(null)

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthContext')
  return ctx
}

function App() {
  const [theme, setTheme] = useState<Theme>(() => {
    const saved = localStorage.getItem('theme') as Theme
    if (saved) return saved
    // Check system preference
    if (window.matchMedia('(prefers-color-scheme: light)').matches) {
      return 'light'
    }
    return 'dark'
  })

  const [user, setUser] = useState<User | null>(null)
  const [loadingUser, setLoadingUser] = useState(true)

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
    localStorage.setItem('theme', theme)
  }, [theme])

  useEffect(() => {
    // Check if user is logged in
    getCurrentUser().then(u => {
      setUser(u)
      setLoadingUser(false)
    })
  }, [])

  const toggleTheme = () => {
    setTheme(prev => prev === 'dark' ? 'light' : 'dark')
  }

  const handleLogout = () => {
    logout()
    setUser(null)
  }

  const handleLogin = () => {
    window.location.href = getGitHubLoginUrl()
  }

  const authContext: AuthContextType = {
    user,
    loadingUser,
    handleLogin,
    handleLogout,
    setUser,
  }

  // Loading state
  if (loadingUser) {
    return (
      <div className="app">
        <div className="loading-container">
          <div className="loading-spinner" />
        </div>
      </div>
    )
  }

  // Local dev mode - skip login, use mock user
  const localDevMode = isLocalDev()
  const mockUser: User = {
    id: 'local-dev',
    provider: 'local',
    provider_id: 'local-dev',
    email: 'dev@localhost',
    name: 'Local Dev',
    avatar_url: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }
  const effectiveUser = localDevMode ? mockUser : user

  // Not logged in and not in local dev mode - show login page
  if (!effectiveUser) {
    return (
      <AuthContext.Provider value={authContext}>
        <div className="app">
          <div className="app-header-controls">
            <button className="theme-toggle" onClick={toggleTheme} title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}>
              {theme === 'dark' ? '\u2600\ufe0f' : '\ud83c\udf19'}
            </button>
          </div>
          <Routes>
            <Route path="/auth/callback" element={<AuthCallback />} />
            <Route path="*" element={<LoginPage />} />
          </Routes>
        </div>
      </AuthContext.Provider>
    )
  }

  return (
    <AuthContext.Provider value={authContext}>
      <div className="app">
        <div className="app-header-controls">
          <div className="user-section">
            <div className="user-info">
              {effectiveUser.avatar_url && (
                <img src={effectiveUser.avatar_url} alt="" className="user-avatar" />
              )}
              <span className="user-name">{effectiveUser.name || effectiveUser.email || 'User'}</span>
              {!localDevMode && (
                <button className="logout-btn" onClick={handleLogout}>
                  Logout
                </button>
              )}
              {localDevMode && (
                <span className="dev-badge" style={{ marginLeft: 8, padding: '2px 6px', background: '#f0ad4e', borderRadius: 4, fontSize: 11 }}>DEV</span>
              )}
            </div>
          </div>
          <button className="theme-toggle" onClick={toggleTheme} title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}>
            {theme === 'dark' ? '\u2600\ufe0f' : '\ud83c\udf19'}
          </button>
        </div>
        <Routes>
          <Route path="/" element={<SessionList />} />
          <Route path="/sessions/:id" element={<SessionDetail />} />
          <Route path="/preview" element={<RoamPreview />} />
          <Route path="/auth/callback" element={<AuthCallback />} />
        </Routes>
      </div>
    </AuthContext.Provider>
  )
}

export default App
