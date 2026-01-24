import { useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { saveAuthToken } from '../api'

function AuthCallback() {
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const token = searchParams.get('token')
    const errorMsg = searchParams.get('error')

    if (errorMsg) {
      setError(errorMsg)
      return
    }

    if (token) {
      saveAuthToken(token)
      // Redirect to home
      navigate('/', { replace: true })
    } else {
      setError('No token received')
    }
  }, [searchParams, navigate])

  if (error) {
    return (
      <div className="auth-callback">
        <div className="auth-error">
          <h2>Login Failed</h2>
          <p>{error}</p>
          <a href="/" className="back-link">Back to Home</a>
        </div>
      </div>
    )
  }

  return (
    <div className="auth-callback">
      <div className="auth-loading">
        <p>Logging in...</p>
      </div>
    </div>
  )
}

export default AuthCallback
