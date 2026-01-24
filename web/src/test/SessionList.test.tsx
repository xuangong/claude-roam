import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { BrowserRouter } from 'react-router-dom'
import SessionList from '../pages/SessionList'
import * as api from '../api'

// Mock the API module
vi.mock('../api')

describe('SessionList', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  const renderWithRouter = (component: React.ReactElement) => {
    return render(<BrowserRouter>{component}</BrowserRouter>)
  }

  it('renders loading state initially', () => {
    vi.mocked(api.listSessions).mockImplementation(
      () => new Promise(() => {}) // Never resolves
    )

    renderWithRouter(<SessionList />)
    expect(screen.getByText('Loading...')).toBeInTheDocument()
  })

  it('renders sessions when loaded', async () => {
    vi.mocked(api.listSessions).mockResolvedValueOnce({
      sessions: [
        {
          session_id: 'test-session-1',
          summary: null,
          first_message: 'Hello world',
          total_lines: 10,
          created_at: '2026-01-01T00:00:00',
          updated_at: '2026-01-01T00:00:00',
          machines: 'macbook',
          last_path: '/test',
        },
      ],
      total: 1,
      page: 1,
      limit: 20,
      has_more: false,
    })

    renderWithRouter(<SessionList />)

    await waitFor(() => {
      expect(screen.getByText('test-session-1')).toBeInTheDocument()
    })

    expect(screen.getByText('"Hello world"')).toBeInTheDocument()
    expect(screen.getByText('Lines: 10')).toBeInTheDocument()
  })

  it('renders no sessions message when empty', async () => {
    vi.mocked(api.listSessions).mockResolvedValueOnce({
      sessions: [],
      total: 0,
      page: 1,
      limit: 20,
      has_more: false,
    })

    renderWithRouter(<SessionList />)

    await waitFor(() => {
      expect(screen.getByText('No sessions found')).toBeInTheDocument()
    })
  })

  it('renders error message on failure', async () => {
    vi.mocked(api.listSessions).mockRejectedValueOnce(
      new Error('Failed to fetch')
    )

    renderWithRouter(<SessionList />)

    await waitFor(() => {
      expect(screen.getByText('Failed to fetch')).toBeInTheDocument()
    })
  })

  it('handles search', async () => {
    vi.mocked(api.listSessions).mockResolvedValue({
      sessions: [],
      total: 0,
      page: 1,
      limit: 20,
      has_more: false,
    })

    renderWithRouter(<SessionList />)

    // Wait for initial load
    await waitFor(() => {
      expect(api.listSessions).toHaveBeenCalled()
    })

    // Type in search
    const searchInput = screen.getByPlaceholderText('Search sessions...')
    fireEvent.change(searchInput, { target: { value: 'test query' } })

    // Submit search
    const searchButton = screen.getByText('Search')
    fireEvent.click(searchButton)

    // Verify search was called with LIMIT=20
    await waitFor(() => {
      expect(api.listSessions).toHaveBeenLastCalledWith('test query', 20, 0)
    })
  })

  it('truncates long first messages', async () => {
    const longMessage = 'a'.repeat(150)
    vi.mocked(api.listSessions).mockResolvedValueOnce({
      sessions: [
        {
          session_id: 'test-1',
          summary: null,
          first_message: longMessage,
          total_lines: 10,
          created_at: '2026-01-01T00:00:00',
          updated_at: '2026-01-01T00:00:00',
          machines: null,
          last_path: null,
        },
      ],
      total: 1,
      page: 1,
      limit: 20,
      has_more: false,
    })

    renderWithRouter(<SessionList />)

    await waitFor(() => {
      const messageElement = screen.getByText(/"a+\.\.\."/i)
      expect(messageElement).toBeInTheDocument()
    })
  })
})
