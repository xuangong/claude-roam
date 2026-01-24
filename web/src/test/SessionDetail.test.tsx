import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { BrowserRouter, MemoryRouter, Route, Routes } from 'react-router-dom'
import SessionDetail from '../pages/SessionDetail'
import * as api from '../api'

// Mock the API module
vi.mock('../api')

// Mock clipboard API
Object.assign(navigator, {
  clipboard: {
    writeText: vi.fn().mockResolvedValue(undefined),
  },
})

describe('SessionDetail', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  const renderWithRouter = (sessionId: string) => {
    return render(
      <MemoryRouter initialEntries={[`/sessions/${sessionId}`]}>
        <Routes>
          <Route path="/sessions/:id" element={<SessionDetail />} />
        </Routes>
      </MemoryRouter>
    )
  }

  it('renders loading state initially', () => {
    vi.mocked(api.getSessionDetail).mockImplementation(
      () => new Promise(() => {})
    )
    vi.mocked(api.pullSession).mockImplementation(() => new Promise(() => {}))

    renderWithRouter('test-session')
    expect(screen.getByText('Loading...')).toBeInTheDocument()
  })

  it('renders session detail when loaded', async () => {
    vi.mocked(api.getSessionDetail).mockResolvedValueOnce({
      session: {
        session_id: 'test-session',
        summary: null,
        first_message: 'Hello',
        total_lines: 10,
        created_at: '2026-01-01T10:00:00',
        updated_at: '2026-01-01T12:00:00',
      },
      segments: [
        {
          id: 1,
          from_line: 1,
          to_line: 10,
          machine_id: 'machine-1',
          machine_name: 'MacBook',
          platform: 'darwin',
          original_path: '/Users/test',
          pushed_at: '2026-01-01T10:00:00',
        },
      ],
    })

    vi.mocked(api.pullSession).mockResolvedValueOnce({
      data: '{"type": "human", "message": {"content": "Hello"}}\n{"type": "assistant", "message": {"content": "Hi"}}',
      meta: {
        session_id: 'test-session',
        summary: null,
        first_message: 'Hello',
        total_lines: 2,
        created_at: '2026-01-01T10:00:00',
        updated_at: '2026-01-01T12:00:00',
      },
      segments: [],
    })

    renderWithRouter('test-session')

    await waitFor(() => {
      expect(screen.getByText('test-session')).toBeInTheDocument()
    })

    // Check segments table
    expect(screen.getByText('1-10')).toBeInTheDocument()
    expect(screen.getByText('MacBook')).toBeInTheDocument()

    // Check pull command
    expect(
      screen.getByText('claude-roam pull test-session')
    ).toBeInTheDocument()
  })

  it('renders error message on failure', async () => {
    vi.mocked(api.getSessionDetail).mockRejectedValueOnce(
      new Error('Session not found')
    )
    vi.mocked(api.pullSession).mockRejectedValueOnce(
      new Error('Session not found')
    )

    renderWithRouter('nonexistent')

    await waitFor(() => {
      expect(screen.getByText('Session not found')).toBeInTheDocument()
    })
  })

  it('copies pull command to clipboard', async () => {
    vi.mocked(api.getSessionDetail).mockResolvedValueOnce({
      session: {
        session_id: 'test-copy',
        summary: null,
        first_message: null,
        total_lines: 5,
        created_at: '2026-01-01T10:00:00',
        updated_at: '2026-01-01T10:00:00',
      },
      segments: [],
    })

    vi.mocked(api.pullSession).mockResolvedValueOnce({
      data: '',
      meta: {
        session_id: 'test-copy',
        summary: null,
        first_message: null,
        total_lines: 0,
        created_at: '2026-01-01T10:00:00',
        updated_at: '2026-01-01T10:00:00',
      },
      segments: [],
    })

    renderWithRouter('test-copy')

    await waitFor(() => {
      expect(screen.getByText('Copy')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByText('Copy'))

    await waitFor(() => {
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
        'claude-roam pull test-copy'
      )
    })

    expect(screen.getByText('Copied!')).toBeInTheDocument()
  })

  it('shows back link', async () => {
    vi.mocked(api.getSessionDetail).mockResolvedValueOnce({
      session: {
        session_id: 'test-back',
        summary: null,
        first_message: null,
        total_lines: 0,
        created_at: '2026-01-01T10:00:00',
        updated_at: '2026-01-01T10:00:00',
      },
      segments: [],
    })

    vi.mocked(api.pullSession).mockResolvedValueOnce({
      data: '',
      meta: {
        session_id: 'test-back',
        summary: null,
        first_message: null,
        total_lines: 0,
        created_at: '2026-01-01T10:00:00',
        updated_at: '2026-01-01T10:00:00',
      },
      segments: [],
    })

    renderWithRouter('test-back')

    await waitFor(() => {
      expect(screen.getByText('← Back')).toBeInTheDocument()
    })
  })
})
