/**
 * API client for Claude Roam server
 */

export interface SourceInfo {
  machine_id: string;
  machine_name: string | null;
  platform: string | null;
  original_path: string | null;
}

export interface PushRequest {
  from_line: number;
  append_data: string;
  source: SourceInfo;
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

function getApiUrl(): string {
  const url = process.env.ROAM_API;
  if (!url) {
    throw new Error(
      "ROAM_API environment variable not set. Please set it to your server URL."
    );
  }
  return url.replace(/\/$/, ""); // Remove trailing slash
}

async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries = 3
): Promise<T> {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i === maxRetries - 1) throw e;
      await Bun.sleep(1000 * (i + 1)); // Exponential backoff
    }
  }
  throw new Error("unreachable");
}

export async function pushSession(
  sessionId: string,
  request: PushRequest
): Promise<void> {
  const url = `${getApiUrl()}/api/sessions/${sessionId}/push`;

  await withRetry(async () => {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Push failed: ${response.status} ${text}`);
    }
  });
}

export async function pullSession(
  sessionId: string,
  fromLine?: number
): Promise<PullResponse> {
  let url = `${getApiUrl()}/api/sessions/${sessionId}/pull`;
  if (fromLine !== undefined) {
    url += `?from_line=${fromLine}`;
  }

  return await withRetry(async () => {
    const response = await fetch(url);
    if (!response.ok) {
      if (response.status === 404) {
        throw new Error(`Session not found: ${sessionId}`);
      }
      const text = await response.text();
      throw new Error(`Pull failed: ${response.status} ${text}`);
    }
    return (await response.json()) as PullResponse;
  });
}

export async function listSessions(
  query?: string,
  limit = 50,
  offset = 0
): Promise<SessionListResponse> {
  const params = new URLSearchParams();
  if (query) params.set("q", query);
  params.set("limit", limit.toString());
  params.set("offset", offset.toString());

  const url = `${getApiUrl()}/api/sessions?${params.toString()}`;

  return await withRetry(async () => {
    const response = await fetch(url);
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`List failed: ${response.status} ${text}`);
    }
    return (await response.json()) as SessionListResponse;
  });
}

export async function getSessionDetail(
  sessionId: string
): Promise<SessionDetailResponse> {
  const url = `${getApiUrl()}/api/sessions/${sessionId}`;

  return await withRetry(async () => {
    const response = await fetch(url);
    if (!response.ok) {
      if (response.status === 404) {
        throw new Error(`Session not found: ${sessionId}`);
      }
      const text = await response.text();
      throw new Error(`Get detail failed: ${response.status} ${text}`);
    }
    return (await response.json()) as SessionDetailResponse;
  });
}

export async function deleteSession(sessionId: string): Promise<void> {
  const url = `${getApiUrl()}/api/sessions/${sessionId}`;

  await withRetry(async () => {
    const response = await fetch(url, { method: "DELETE" });
    if (!response.ok) {
      if (response.status === 404) {
        throw new Error(`Session not found: ${sessionId}`);
      }
      const text = await response.text();
      throw new Error(`Delete failed: ${response.status} ${text}`);
    }
  });
}

export async function healthCheck(): Promise<boolean> {
  const url = `${getApiUrl()}/api/health`;
  try {
    const response = await fetch(url);
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * List sessions by machine and path (cloud directory)
 */
export async function listSessionsByDir(
  machine: string,
  originalPath: string
): Promise<SessionListItem[]> {
  const params = new URLSearchParams();
  params.set("machine", machine);
  params.set("path", originalPath);

  const url = `${getApiUrl()}/api/sessions/by-dir?${params.toString()}`;

  return await withRetry(async () => {
    const response = await fetch(url);
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`List by dir failed: ${response.status} ${text}`);
    }
    const data = await response.json();
    return data.sessions as SessionListItem[];
  });
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

/**
 * List all sessions grouped by machine and path
 */
export async function listSessionsGrouped(): Promise<GroupedSessionItem[]> {
  const url = `${getApiUrl()}/api/sessions/grouped`;

  return await withRetry(async () => {
    const response = await fetch(url);
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`List grouped failed: ${response.status} ${text}`);
    }
    const data = await response.json() as GroupedSessionsResponse;
    return data.sessions;
  });
}


// ============ Auth API ============

export interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

export interface UserInfo {
  id: string;
  provider: string;
  provider_id: string;
  email: string | null;
  name: string | null;
  avatar_url: string | null;
  created_at: string;
  updated_at: string;
}

export interface DeviceTokenResponse {
  status: "pending" | "completed" | "expired";
  access_token?: string;
  user?: UserInfo;
}

/**
 * Request a device code for GitHub login
 */
export async function requestDeviceCode(): Promise<DeviceCodeResponse> {
  const url = `${getApiUrl()}/api/auth/device/github`;

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to get device code: ${response.status} ${text}`);
  }

  return (await response.json()) as DeviceCodeResponse;
}

/**
 * Poll for device token (check if user has authorized)
 */
export async function pollDeviceToken(deviceCode: string): Promise<DeviceTokenResponse> {
  const url = `${getApiUrl()}/api/auth/device/github/token`;

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      device_code: deviceCode,
      provider: "github",
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to check token: ${response.status} ${text}`);
  }

  return (await response.json()) as DeviceTokenResponse;
}

/**
 * Get current user info
 */
export async function getCurrentUser(token: string): Promise<UserInfo | null> {
  const url = `${getApiUrl()}/api/auth/me`;

  try {
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    if (response.status === 401) {
      return null;
    }

    if (!response.ok) {
      return null;
    }

    const data = await response.json();
    return data.user as UserInfo;
  } catch {
    return null;
  }
}
