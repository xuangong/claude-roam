/**
 * Tauri IPC Store - Data access layer for Tauri backend
 * This module provides a unified API that works in both Tauri and browser environments
 */

import type { DisplayMessage } from '../types/message'

// Check if running in Tauri environment
// In Tauri 2.x, __TAURI_INTERNALS__ is always available; __TAURI__ requires withGlobalTauri config
export const isTauri = (): boolean => {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

// Check if running in local development mode (skip auth for local preview)
export const isLocalDev = (): boolean => {
  if (typeof window === 'undefined') return false
  const host = window.location.hostname
  return host === 'localhost' || host === '127.0.0.1' || host.startsWith('192.168.')
}

// Tauri API types
interface TauriInvoke {
  <T>(cmd: string, args?: Record<string, unknown>): Promise<T>
}

interface TauriEvent {
  listen<T>(
    event: string,
    handler: (event: { payload: T }) => void
  ): Promise<() => void>
}

// Session metadata from Rust backend
export interface SessionMeta {
  id: string
  encodedDir: string
  directory: string
  lineCount: number
  messageCount: number
  firstHumanMessage: string | null
  lastModified: number
  parsedAt: number | null
  fileSize: number
  treeCount: number
  typeString: string | null
  createdAt: string | null
  updatedAt: string | null
}

// Project info
export interface ProjectInfo {
  encodedDir: string
  directory: string
  sessionCount: number
  lastModified: number
}

// Scan result
export interface ScanResult {
  totalSessions: number
  newSessions: number
  updatedSessions: number
  deletedSessions: number
  duration_ms: number
}

// Search result
export interface SearchResult {
  uuid: string
  treeIndex: number
  displayType: string
  snippet: string
  score: number
}

// Tool call result
export interface ToolCallResult {
  uuid: string
  treeIndex: number
  toolName: string
  toolId: string
  input: unknown
}

// Session analysis
export interface SessionAnalysis {
  totalMessages: number
  humanMessages: number
  assistantMessages: number
  toolCalls: ToolCallStat[]
  treeCount: number
  timeSpan: TimeSpan | null
  topToolsByUsage: { name: string; count: number }[]
  tokenUsage: TokenUsage | null
}

export interface ToolCallStat {
  toolName: string
  callCount: number
  successCount: number
  errorCount: number
}

export interface TimeSpan {
  start: string
  end: string
  durationMinutes: number
}

// Token usage
export interface TokenUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
}

// Session change event
export interface SessionChangeEvent {
  sessionId: string
  encodedDir: string
  changeType: 'created' | 'modified' | 'deleted'
  newLineCount?: number
}

// Get Tauri invoke function
async function getInvoke(): Promise<TauriInvoke> {
  if (!isTauri()) {
    throw new Error('Not running in Tauri environment')
  }
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke
}

// Get Tauri event listener
async function getEventListener(): Promise<TauriEvent> {
  if (!isTauri()) {
    throw new Error('Not running in Tauri environment')
  }
  const { listen } = await import('@tauri-apps/api/event')
  return { listen }
}

// ============ Projects API ============

/**
 * List all projects (encoded directories)
 */
export async function listProjects(): Promise<ProjectInfo[]> {
  const invoke = await getInvoke()
  return invoke<ProjectInfo[]>('list_projects')
}

/**
 * Get sessions for a specific project
 */
export async function getProjectSessions(
  encodedDir: string
): Promise<SessionMeta[]> {
  const invoke = await getInvoke()
  return invoke<SessionMeta[]>('get_project_sessions', { encodedDir })
}

// ============ Sessions API ============

/**
 * List all sessions
 */
export async function listSessions(options?: {
  encodedDir?: string
  limit?: number
  offset?: number
}): Promise<SessionMeta[]> {
  const invoke = await getInvoke()
  return invoke<SessionMeta[]>('list_sessions', options || {})
}

/**
 * Get a single session by ID
 */
export async function getSession(
  sessionId: string
): Promise<SessionMeta | null> {
  const invoke = await getInvoke()
  return invoke<SessionMeta | null>('get_session', { sessionId })
}

/**
 * Scan file system for sessions and update database
 */
export async function scanSessions(
  forceReparse?: boolean
): Promise<ScanResult> {
  const invoke = await getInvoke()
  return invoke<ScanResult>('scan_sessions', { forceReparse })
}

// ============ Messages API ============

/**
 * Get messages in a range (for virtual scrolling)
 */
export async function getMessagesRange(
  sessionId: string,
  startIndex: number,
  endIndex: number
): Promise<DisplayMessage[]> {
  const invoke = await getInvoke()
  const messages = await invoke<DisplayMessage[]>('get_messages_range', {
    sessionId,
    startIndex,
    endIndex,
  })
  return normalizeMessages(messages)
}

/**
 * Get a single message by UUID
 */
export async function getMessageByUuid(
  sessionId: string,
  uuid: string
): Promise<DisplayMessage | null> {
  const invoke = await getInvoke()
  const message = await invoke<DisplayMessage | null>('get_message_by_uuid', {
    sessionId,
    uuid,
  })
  return message ? normalizeMessage(message) : null
}

/**
 * Get tree path from root to a message
 */
export async function getTreePath(
  sessionId: string,
  uuid: string
): Promise<DisplayMessage[]> {
  const invoke = await getInvoke()
  const messages = await invoke<DisplayMessage[]>('get_tree_path', {
    sessionId,
    uuid,
  })
  return normalizeMessages(messages)
}

// ============ Search API ============

// ============ Import/Export API ============

export interface ImportResult {
  imported: number
  skipped: number
  total: number
  source: string
}

/**
 * Export sessions to a .roam file
 */
export async function exportRoam(
  sessionIds: string[],
  outputPath: string
): Promise<string> {
  const invoke = await getInvoke()
  return invoke<string>('export_roam', { sessionIds, outputPath })
}

/**
 * Import a .roam file
 */
export async function importRoam(
  filePath: string
): Promise<ImportResult> {
  const invoke = await getInvoke()
  return invoke<ImportResult>('import_roam', { filePath })
}

// ============ Search API (continued) ============

/**
 * Search messages using full-text search
 */
export async function searchMessages(
  sessionId: string,
  query: string,
  limit?: number
): Promise<SearchResult[]> {
  const invoke = await getInvoke()
  return invoke<SearchResult[]>('search_messages', {
    sessionId,
    query,
    limit,
  })
}

/**
 * Search tool calls
 */
export async function searchToolCalls(
  sessionId: string,
  toolName?: string
): Promise<ToolCallResult[]> {
  const invoke = await getInvoke()
  return invoke<ToolCallResult[]>('search_tool_calls', {
    sessionId,
    toolName,
  })
}

// ============ Analysis API ============

/**
 * Analyze a session
 */
export async function analyzeSession(
  sessionId: string
): Promise<SessionAnalysis> {
  const invoke = await getInvoke()
  return invoke<SessionAnalysis>('analyze_session', { sessionId })
}

// ============ Events API ============

/**
 * Listen for session change events
 */
export async function onSessionChanged(
  handler: (event: SessionChangeEvent) => void
): Promise<() => void> {
  const eventApi = await getEventListener()
  return eventApi.listen<SessionChangeEvent>('session-changed', (event) => {
    handler(event.payload)
  })
}

// ============ Utility Functions ============

/**
 * Normalize message from Rust backend to frontend format
 */
function normalizeMessage(msg: DisplayMessage): DisplayMessage {
  // Save original message as raw before normalization
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rawSnapshot = JSON.parse(JSON.stringify(msg)) as Record<string, unknown>

  // Map Rust display types to frontend types
  const typeMapping: Record<string, string> = {
    human: 'human',
    assistant: 'assistant',
    tool_use: 'tool_call',
    tool_result: 'tool_result',
    thinking: 'system',
    code_result: 'system',
    error: 'error',
  }

  const displayType = typeMapping[msg.displayType as string] || msg.displayType

  // Normalize content blocks from Rust format to frontend format
  // Rust: { type: "text", text: "..." } → Frontend: { type: "text", content: "..." }
  // Rust: { type: "tool_result", tool_use_id, content: string|blocks } → Frontend: { type: "tool_result", tool_use_id, content: string }
  // Rust: { type: "thinking", thinking: "..." } → Frontend: { type: "text", content: "..." }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const blocks = ((msg.blocks || []) as any[]).map((block: any) => {
    if (block.type === 'text') {
      return { type: 'text', content: (block as { text?: string }).text || (block as { content?: string }).content || '' }
    }
    if (block.type === 'tool_use') {
      return { type: 'tool_use', id: block.id || '', name: block.name || '', input: block.input || {} }
    }
    if (block.type === 'tool_result') {
      const content = typeof block.content === 'string' ? block.content : JSON.stringify(block.content || '')
      return { type: 'tool_result', tool_use_id: block.tool_use_id || '', content }
    }
    if (block.type === 'thinking') {
      return { type: 'text', content: (block as { thinking?: string }).thinking || '' }
    }
    if (block.type === 'code_execution_tool_result') {
      const parts = []
      if (block.stdout) parts.push(block.stdout)
      if (block.stderr) parts.push(`[stderr] ${block.stderr}`)
      return { type: 'text', content: parts.join('\n') || '' }
    }
    // Fallback: ensure content field exists
    return { ...block, content: (block as { content?: string }).content || (block as { text?: string }).text || '' }
  })

  return {
    ...msg,
    displayType: displayType as DisplayMessage['displayType'],
    blocks: blocks as DisplayMessage['blocks'],
    raw: rawSnapshot,
  }
}

/**
 * Normalize array of messages
 */
function normalizeMessages(messages: DisplayMessage[]): DisplayMessage[] {
  return messages.map(normalizeMessage)
}

// ============ Hybrid Store (Tauri + Browser fallback) ============

/**
 * Hybrid message store that uses Tauri when available, falls back to browser
 */
export class HybridMessageStore {
  private sessionId: string
  private useNative: boolean

  constructor(sessionId: string) {
    this.sessionId = sessionId
    this.useNative = isTauri()
  }

  async getMessagesInRange(
    startIndex: number,
    endIndex: number
  ): Promise<DisplayMessage[]> {
    if (this.useNative) {
      return getMessagesRange(this.sessionId, startIndex, endIndex)
    }

    // Fallback to IndexedDB (legacy)
    const { getMessagesInRange } = await import('./messageStore')
    return getMessagesInRange(this.sessionId, startIndex, endIndex)
  }

  async getTotalMessages(): Promise<number> {
    if (this.useNative) {
      const session = await getSession(this.sessionId)
      return session?.messageCount || 0
    }

    // Fallback to IndexedDB (legacy)
    const { getSessionMeta } = await import('./messageStore')
    const meta = await getSessionMeta(this.sessionId)
    return meta?.totalMessages || 0
  }

  async search(query: string, limit?: number): Promise<SearchResult[]> {
    if (this.useNative) {
      return searchMessages(this.sessionId, query, limit)
    }

    // Fallback: simple in-memory search
    return []
  }
}
