import { useState, useEffect, createContext, useContext } from 'react'
import { Routes, Route } from 'react-router-dom'
import SessionList from './pages/SessionList'
import SessionDetail from './pages/SessionDetail'
import RoamPreview from './pages/RoamPreview'
import AuthCallback from './pages/AuthCallback'
import LoginPage from './pages/LoginPage'
import { getCurrentUser, logout, getGitHubLoginUrl, User } from './api'
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

  // Not logged in - show login page
  if (!user) {
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
              {user.avatar_url && (
                <img src={user.avatar_url} alt="" className="user-avatar" />
              )}
              <span className="user-name">{user.name || user.email || 'User'}</span>
              <button className="logout-btn" onClick={handleLogout}>
                Logout
              </button>
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
