import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  listSessions,
  getSessionDetail,
  pullSession,
  deleteSession,
  healthCheck,
} from '../api'

// Mock fetch globally
const mockFetch = vi.fn()
global.fetch = mockFetch

describe('API Client', () => {
  beforeEach(() => {
    mockFetch.mockReset()
  })

  describe('listSessions', () => {
    it('fetches sessions without query', async () => {
      const mockResponse = {
        sessions: [
          {
            session_id: 'test-1',
            summary: null,
            first_message: 'Hello',
            total_lines: 10,
            created_at: '2026-01-01T00:00:00',
            updated_at: '2026-01-01T00:00:00',
            machines: 'macbook',
            last_path: '/test',
          },
        ],
      }

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockResponse,
      })

      const result = await listSessions()
      expect(result.sessions).toHaveLength(1)
      expect(result.sessions[0].session_id).toBe('test-1')
      expect(mockFetch).toHaveBeenCalledWith('/api/sessions?limit=50&offset=0')
    })

    it('fetches sessions with query', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ sessions: [] }),
      })

      await listSessions('search term', 20, 10)
      expect(mockFetch).toHaveBeenCalledWith(
        '/api/sessions?q=search+term&limit=20&offset=10'
      )
    })

    it('throws on non-ok response', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
      })

      await expect(listSessions()).rejects.toThrow('Failed to list sessions: 500')
    })
  })

  describe('getSessionDetail', () => {
    it('fetches session detail', async () => {
      const mockResponse = {
        session: {
          session_id: 'test-1',
          summary: null,
          first_message: 'Hello',
          total_lines: 10,
          created_at: '2026-01-01T00:00:00',
          updated_at: '2026-01-01T00:00:00',
        },
        segments: [],
      }

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockResponse,
      })

      const result = await getSessionDetail('test-1')
      expect(result.session.session_id).toBe('test-1')
      expect(mockFetch).toHaveBeenCalledWith('/api/sessions/test-1')
    })

    it('throws on 404', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
      })

      await expect(getSessionDetail('nonexistent')).rejects.toThrow(
        'Failed to get session: 404'
      )
    })
  })

  describe('pullSession', () => {
    it('pulls session content', async () => {
      const mockResponse = {
        data: '{"line": 1}',
        meta: {
          session_id: 'test-1',
          summary: null,
          first_message: 'Hello',
          total_lines: 1,
          created_at: '2026-01-01T00:00:00',
          updated_at: '2026-01-01T00:00:00',
        },
        segments: [],
      }

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockResponse,
      })

      const result = await pullSession('test-1')
      expect(result.data).toBe('{"line": 1}')
      expect(mockFetch).toHaveBeenCalledWith('/api/sessions/test-1/pull')
    })
  })

  describe('deleteSession', () => {
    it('deletes session', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ok: true }),
      })

      await deleteSession('test-1')
      expect(mockFetch).toHaveBeenCalledWith('/api/sessions/test-1', {
        method: 'DELETE',
      })
    })

    it('throws on 404', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
      })

      await expect(deleteSession('nonexistent')).rejects.toThrow(
        'Failed to delete session: 404'
      )
    })
  })

  describe('healthCheck', () => {
    it('returns true when healthy', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
      })

      const result = await healthCheck()
      expect(result).toBe(true)
    })

    it('returns false when unhealthy', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
      })

      const result = await healthCheck()
      expect(result).toBe(false)
    })

    it('returns false on network error', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network error'))

      const result = await healthCheck()
      expect(result).toBe(false)
    })
  })
})
