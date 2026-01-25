import { useState, useRef } from 'react'
import { Link } from 'react-router-dom'
import RoamPreviewCore, { type RoamBundle, type RoamBundleV1, type RoamBundleV2, type RoamSession } from './RoamPreviewCore'

function RoamPreview() {
  const [bundle, setBundle] = useState<RoamBundle | null>(null)
  const [sessions, setSessions] = useState<RoamSession[]>([])
  const [error, setError] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return

    setError(null)

    try {
      const text = await file.text()
      const data = JSON.parse(text) as RoamBundle

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
      setError(err instanceof Error ? err.message : 'Failed to parse file')
      setBundle(null)
      setSessions([])
    }
  }

  // No file loaded yet
  if (!bundle) {
    return (
      <div className="detail-page">
        <Link to="/" className="back-link">Back to sessions</Link>

        <div className="detail-header">
          <h1>Load .roam File</h1>
          <p style={{ color: 'var(--text-secondary)', marginTop: 'var(--space-2)' }}>
            Preview sessions exported from Claude Roam CLI
          </p>
        </div>

        <div className="section">
          <input
            type="file"
            accept=".roam"
            ref={fileInputRef}
            onChange={handleFileSelect}
            style={{ display: 'none' }}
          />
          <button className="primary" onClick={() => fileInputRef.current?.click()}>
            Select .roam file
          </button>

          {error && <div className="error" style={{ marginTop: 'var(--space-4)' }}>{error}</div>}
        </div>
      </div>
    )
  }

  // Use RoamPreviewCore for display
  return (
    <>
      <div className="detail-page" style={{ paddingBottom: 0 }}>
        <Link to="/" className="back-link">Back to sessions</Link>
      </div>
      <RoamPreviewCore bundle={bundle} sessions={sessions} />
    </>
  )
}

export default RoamPreview
