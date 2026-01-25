/**
 * API client for Claude Roam Web
 */

/**
 * Get auth headers if user is logged in
 */
function getAuthHeaders(): Record<string, string> {
  const token = localStorage.getItem('auth_token');
  if (token) {
    return { Authorization: `Bearer ${token}` };
  }
  return {};
}

/**
 * Custom error for authentication failures
 */
export class AuthError extends Error {
  constructor(message = 'Authentication required') {
    super(message);
    this.name = 'AuthError';
  }
}

export interface Segment {
  id: number;
  from_line: number;
  to_line: number;
  machine_id: string;
  machine_name: string | null;
  platform: string | null;
  original_path: string | null;
  pushed_at: string;
}

export interface SessionMeta {
  session_id: string;
  summary: string | null;
  first_message: string | null;
  total_lines: number;
  created_at: string;
  updated_at: string;
}

export interface PullResponse {
  data: string;
  meta: SessionMeta;
  segments: Segment[];
}

export interface SessionListItem {
  session_id: string;
  summary: string | null;
  first_message: string | null;
  total_lines: number;
  created_at: string;
  updated_at: string;
  machines: string | null;
  last_path: string | null;
}

export interface SessionListResponse {
  sessions: SessionListItem[];
  total: number;
  page: number;
  limit: number;
  has_more: boolean;
}

export interface SessionDetailResponse {
  session: SessionMeta;
  segments: Segment[];
}

export interface SearchResultItem {
  session_id: string;
  summary: string | null;
  first_message: string | null;
  total_lines: number;
  created_at: string;
  updated_at: string;
  machines: string | null;
  last_path: string | null;
  snippet: string | null;
}

export interface SearchResponse {
  results: SearchResultItem[];
  total: number;
}

export interface GroupedSessionItem {
  session_id: string;
  summary: string | null;
  first_message: string | null;
  total_lines: number;
  created_at: string;
  updated_at: string;
  machine_name: string | null;
  original_path: string | null;
}

export interface GroupedSessionsResponse {
  sessions: GroupedSessionItem[];
}

const API_BASE = '/api';

export async function listSessions(
  query?: string,
  limit = 50,
  offset = 0
): Promise<SessionListResponse> {
  const params = new URLSearchParams();
  if (query) params.set('q', query);
  params.set('limit', limit.toString());
  params.set('offset', offset.toString());

  const response = await fetch(`${API_BASE}/sessions?${params.toString()}`, {
    headers: getAuthHeaders(),
  });
  if (response.status === 401) {
    throw new AuthError();
  }
  if (!response.ok) {
    throw new Error(`Failed to list sessions: ${response.status}`);
  }
  return response.json();
}

export async function getSessionDetail(
  sessionId: string
): Promise<SessionDetailResponse> {
  const response = await fetch(`${API_BASE}/sessions/${sessionId}`, {
    headers: getAuthHeaders(),
  });
  if (response.status === 401) {
    throw new AuthError();
  }
  if (!response.ok) {
    throw new Error(`Failed to get session: ${response.status}`);
  }
  return response.json();
}

export async function pullSession(sessionId: string): Promise<PullResponse> {
  const response = await fetch(`${API_BASE}/sessions/${sessionId}/pull`, {
    headers: getAuthHeaders(),
  });
  if (response.status === 401) {
    throw new AuthError();
  }
  if (!response.ok) {
    throw new Error(`Failed to pull session: ${response.status}`);
  }
  return response.json();
}

export async function deleteSession(sessionId: string): Promise<void> {
  const response = await fetch(`${API_BASE}/sessions/${sessionId}`, {
    method: 'DELETE',
    headers: getAuthHeaders(),
  });
  if (response.status === 401) {
    throw new AuthError();
  }
  if (!response.ok) {
    throw new Error(`Failed to delete session: ${response.status}`);
  }
}

export async function healthCheck(): Promise<boolean> {
  try {
    const response = await fetch(`${API_BASE}/health`);
    return response.ok;
  } catch {
    return false;
  }
}

export async function searchContent(query: string): Promise<SearchResponse> {
  const response = await fetch(`${API_BASE}/search?q=${encodeURIComponent(query)}`, {
    headers: getAuthHeaders(),
  });
  if (response.status === 401) {
    throw new AuthError();
  }
  if (!response.ok) {
    throw new Error(`Failed to search: ${response.status}`);
  }
  return response.json();
}

export async function getGroupedSessions(): Promise<GroupedSessionsResponse> {
  const response = await fetch(`${API_BASE}/sessions/grouped`, {
    headers: getAuthHeaders(),
  });
  if (response.status === 401) {
    throw new AuthError();
  }
  if (!response.ok) {
    throw new Error(`Failed to get grouped sessions: ${response.status}`);
  }
  return response.json();
}


// ============ Auth API ============

export interface User {
  id: string;
  provider: string;
  provider_id: string;
  email: string | null;
  name: string | null;
  avatar_url: string | null;
  created_at: string;
  updated_at: string;
}

export interface UserResponse {
  user: User;
}

/**
 * Get current user info
 */
export async function getCurrentUser(): Promise<User | null> {
  const token = localStorage.getItem('auth_token');
  if (!token) return null;

  try {
    const response = await fetch(`${API_BASE}/auth/me`, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    if (response.status === 401) {
      localStorage.removeItem('auth_token');
      return null;
    }

    if (!response.ok) {
      return null;
    }

    const data: UserResponse = await response.json();
    return data.user;
  } catch {
    return null;
  }
}

/**
 * Logout - clear token
 */
export function logout(): void {
  localStorage.removeItem('auth_token');
}

/**
 * Get GitHub login URL
 */
export function getGitHubLoginUrl(): string {
  return `${API_BASE}/auth/github`;
}

/**
 * Save auth token
 */
export function saveAuthToken(token: string): void {
  localStorage.setItem('auth_token', token);
}

/**
 * Get auth token
 */
export function getAuthToken(): string | null {
  return localStorage.getItem('auth_token');
}

/**
 * Check if user is logged in
 */
export function isLoggedIn(): boolean {
  return !!getAuthToken();
}


// ============ Pinned Folders API ============

export interface PinnedFolder {
  id: number;
  user_id: string;
  machine_name: string;
  original_path: string;
  pinned_at: string;
}

export interface PinnedFoldersResponse {
  folders: PinnedFolder[];
}

export async function getPinnedFolders(): Promise<PinnedFoldersResponse> {
  const response = await fetch(`${API_BASE}/pinned-folders`, {
    headers: getAuthHeaders(),
  });
  if (response.status === 401) {
    throw new AuthError();
  }
  if (!response.ok) {
    throw new Error(`Failed to get pinned folders: ${response.status}`);
  }
  return response.json();
}

export async function pinFolder(machineName: string, originalPath: string): Promise<void> {
  const response = await fetch(`${API_BASE}/pinned-folders`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...getAuthHeaders(),
    },
    body: JSON.stringify({
      machine_name: machineName,
      original_path: originalPath,
    }),
  });
  if (response.status === 401) {
    throw new AuthError();
  }
  if (!response.ok) {
    throw new Error(`Failed to pin folder: ${response.status}`);
  }
}

export async function unpinFolder(machineName: string, originalPath: string): Promise<void> {
  const params = new URLSearchParams();
  params.set('machine_name', machineName);
  params.set('original_path', originalPath);

  const response = await fetch(`${API_BASE}/pinned-folders?${params.toString()}`, {
    method: 'DELETE',
    headers: getAuthHeaders(),
  });
  if (response.status === 401) {
    throw new AuthError();
  }
  if (!response.ok) {
    throw new Error(`Failed to unpin folder: ${response.status}`);
  }
}
