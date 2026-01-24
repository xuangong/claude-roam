import { useState, useEffect } from 'react'
import { Link, useParams } from 'react-router-dom'
import { getSessionDetail, pullSession, type SessionDetailResponse, type Segment } from '../api'

interface Message {
  role: 'user' | 'assistant'
  content: string
}

function parseMessages(data: string): Message[] {
  const messages: Message[] = []
  const lines = data.split('\n').filter(line => line.trim())

  for (const line of lines) {
    try {
      const obj = JSON.parse(line)

      // Handle human/user messages
      if (obj.type === 'human' && obj.message) {
        const msg = obj.message
        let content = ''
        if (typeof msg.content === 'string') {
          content = msg.content
        } else if (Array.isArray(msg.content)) {
          for (const item of msg.content) {
            if (item.type === 'text') {
              content += item.text
            }
          }
        }
        if (content) {
          messages.push({ role: 'user', content })
        }
      }

      // Handle assistant messages
      if (obj.type === 'assistant' && obj.message) {
        const msg = obj.message
        let content = ''
        if (typeof msg.content === 'string') {
          content = msg.content
        } else if (Array.isArray(msg.content)) {
          for (const item of msg.content) {
            if (item.type === 'text') {
              content += item.text
            }
          }
        }
        if (content) {
          messages.push({ role: 'assistant', content })
        }
      }

      // Handle simple role format
      if (obj.role === 'user' && obj.content) {
        messages.push({
          role: 'user',
          content: typeof obj.content === 'string' ? obj.content : JSON.stringify(obj.content)
        })
      }
      if (obj.role === 'assistant' && obj.content) {
        messages.push({
          role: 'assistant',
          content: typeof obj.content === 'string' ? obj.content : JSON.stringify(obj.content)
        })
      }
    } catch {
      // Skip invalid lines
    }
  }

  return messages.slice(0, 20) // Limit preview
}

function SessionDetail() {
  const { id } = useParams<{ id: string }>()
  const [detail, setDetail] = useState<SessionDetailResponse | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!id) return

    async function fetchData() {
      try {
        setLoading(true)
        setError(null)
        const [detailResp, pullResp] = await Promise.all([
          getSessionDetail(id!),
          pullSession(id!)
        ])
        setDetail(detailResp)
        setMessages(parseMessages(pullResp.data))
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load session')
      } finally {
        setLoading(false)
      }
    }

    fetchData()
  }, [id])

  if (loading) {
    return <div className="loading">Loading...</div>
  }

  if (error) {
    return (
      <div>
        <Link to="/" className="back-link">← Back</Link>
        <div className="error">{error}</div>
      </div>
    )
  }

  if (!detail) {
    return null
  }

  return (
    <div>
      <Link to="/" className="back-link">← Back</Link>

      <div className="detail-header">
        <h1>{detail.session.session_id}</h1>
        <div className="detail-meta">
          <span>Lines: {detail.session.total_lines}</span>
          <span>Created: {new Date(detail.session.created_at).toLocaleString()}</span>
          <span>Updated: {new Date(detail.session.updated_at).toLocaleString()}</span>
        </div>
      </div>

      <div className="section">
        <h2>Source History</h2>
        <table className="segments-table">
          <thead>
            <tr>
              <th>Lines</th>
              <th>Machine</th>
              <th>Path</th>
              <th>Time</th>
            </tr>
          </thead>
          <tbody>
            {detail.segments.map((seg: Segment) => (
              <tr key={seg.id}>
                <td>{seg.from_line}-{seg.to_line}</td>
                <td>{seg.machine_name || seg.machine_id.slice(0, 8)}</td>
                <td>{seg.original_path || 'N/A'}</td>
                <td>{new Date(seg.pushed_at).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="section">
        <h2>Preview</h2>
        <div className="preview-box">
          {messages.length === 0 ? (
            <div className="loading">No messages to preview</div>
          ) : (
            messages.map((msg, i) => (
              <div key={i} className={`message ${msg.role}`}>
                <div className="message-role">{msg.role === 'user' ? 'User' : 'Assistant'}</div>
                <div className="message-content">
                  {msg.content.length > 500 ? msg.content.slice(0, 500) + '...' : msg.content}
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  )
}

export default SessionDetail
