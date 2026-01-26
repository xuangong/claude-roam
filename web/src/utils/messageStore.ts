/**
 * IndexedDB-based message store for large session data
 *
 * Architecture:
 * - Messages are stored in chunks (100 messages per chunk)
 * - Each chunk is a separate IndexedDB record for fast random access
 * - Metadata (total count, chunk info) stored separately
 * - Supports multiple sessions via sessionId key
 */

const DB_NAME = 'claude-roam-messages'
const DB_VERSION = 1
const STORE_CHUNKS = 'message-chunks'
const STORE_META = 'session-meta'
const CHUNK_SIZE = 100

export interface DisplayMessage {
  displayType: 'human' | 'assistant' | 'tool_call' | 'tool_result' | 'system' | 'tree-separator'
  blocks: ContentBlock[]
  toolName?: string
  toolId?: string
  treeIndex?: number
  treeSummaryCount?: number
  treeTimestamp?: string
}

interface TextBlock {
  type: 'text'
  content: string
}

interface ToolUseBlock {
  type: 'tool_use'
  id: string
  name: string
  input: Record<string, unknown>
}

interface ToolResultBlock {
  type: 'tool_result'
  tool_use_id: string
  content: string
  is_error?: boolean
}

type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock

interface SessionMeta {
  sessionId: string
  totalMessages: number
  totalChunks: number
  processedAt: number
  dataHash: string  // To detect if data changed
}

interface MessageChunk {
  sessionId: string
  chunkIndex: number
  messages: DisplayMessage[]
}

let dbPromise: Promise<IDBDatabase> | null = null

function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise

  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)

    request.onerror = () => reject(request.error)
    request.onsuccess = () => resolve(request.result)

    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result

      // Store for message chunks
      if (!db.objectStoreNames.contains(STORE_CHUNKS)) {
        const chunkStore = db.createObjectStore(STORE_CHUNKS, { keyPath: ['sessionId', 'chunkIndex'] })
        chunkStore.createIndex('sessionId', 'sessionId', { unique: false })
      }

      // Store for session metadata
      if (!db.objectStoreNames.contains(STORE_META)) {
        db.createObjectStore(STORE_META, { keyPath: 'sessionId' })
      }
    }
  })

  return dbPromise
}

// Simple hash function for detecting data changes
function hashString(str: string): string {
  let hash = 0
  const len = Math.min(str.length, 10000) // Only hash first 10KB for speed
  for (let i = 0; i < len; i++) {
    const char = str.charCodeAt(i)
    hash = ((hash << 5) - hash) + char
    hash = hash & hash
  }
  return hash.toString(36) + '_' + str.length
}

export async function getSessionMeta(sessionId: string): Promise<SessionMeta | null> {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_META, 'readonly')
    const store = tx.objectStore(STORE_META)
    const request = store.get(sessionId)
    request.onerror = () => reject(request.error)
    request.onsuccess = () => resolve(request.result || null)
  })
}

export async function isSessionCached(sessionId: string, dataHash: string): Promise<boolean> {
  const meta = await getSessionMeta(sessionId)
  return meta !== null && meta.dataHash === dataHash
}

export async function saveSessionMeta(meta: SessionMeta): Promise<void> {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_META, 'readwrite')
    const store = tx.objectStore(STORE_META)
    const request = store.put(meta)
    request.onerror = () => reject(request.error)
    request.onsuccess = () => resolve()
  })
}

export async function saveMessageChunk(chunk: MessageChunk): Promise<void> {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_CHUNKS, 'readwrite')
    const store = tx.objectStore(STORE_CHUNKS)
    const request = store.put(chunk)
    request.onerror = () => reject(request.error)
    request.onsuccess = () => resolve()
  })
}

export async function getMessageChunk(sessionId: string, chunkIndex: number): Promise<MessageChunk | null> {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_CHUNKS, 'readonly')
    const store = tx.objectStore(STORE_CHUNKS)
    const request = store.get([sessionId, chunkIndex])
    request.onerror = () => reject(request.error)
    request.onsuccess = () => resolve(request.result || null)
  })
}

export async function getMessagesInRange(
  sessionId: string,
  startIndex: number,
  endIndex: number
): Promise<DisplayMessage[]> {
  const startChunk = Math.floor(startIndex / CHUNK_SIZE)
  const endChunk = Math.floor(endIndex / CHUNK_SIZE)

  const messages: DisplayMessage[] = []

  for (let i = startChunk; i <= endChunk; i++) {
    const chunk = await getMessageChunk(sessionId, i)
    if (chunk) {
      const chunkStart = i * CHUNK_SIZE
      const localStart = Math.max(0, startIndex - chunkStart)
      const localEnd = Math.min(CHUNK_SIZE, endIndex - chunkStart + 1)

      for (let j = localStart; j < localEnd && j < chunk.messages.length; j++) {
        messages.push(chunk.messages[j])
      }
    }
  }

  return messages
}

export async function clearSession(sessionId: string): Promise<void> {
  const db = await openDB()

  // Clear chunks
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_CHUNKS, 'readwrite')
    const store = tx.objectStore(STORE_CHUNKS)
    const index = store.index('sessionId')
    const request = index.openCursor(IDBKeyRange.only(sessionId))

    request.onerror = () => reject(request.error)
    request.onsuccess = () => {
      const cursor = request.result
      if (cursor) {
        cursor.delete()
        cursor.continue()
      } else {
        resolve()
      }
    }
  })

  // Clear meta
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_META, 'readwrite')
    const store = tx.objectStore(STORE_META)
    const request = store.delete(sessionId)
    request.onerror = () => reject(request.error)
    request.onsuccess = () => resolve()
  })
}

// Message cache for current viewport
export class MessageCache {
  private cache: Map<number, DisplayMessage> = new Map()
  private sessionId: string
  private cacheRadius: number  // How many messages to keep around current viewport

  constructor(sessionId: string, cacheRadius = 5000) {
    this.sessionId = sessionId
    this.cacheRadius = cacheRadius
  }

  async get(index: number): Promise<DisplayMessage | null> {
    if (this.cache.has(index)) {
      return this.cache.get(index)!
    }

    // Load from IndexedDB
    const messages = await getMessagesInRange(this.sessionId, index, index)
    if (messages.length > 0) {
      this.cache.set(index, messages[0])
      return messages[0]
    }
    return null
  }

  async prefetch(centerIndex: number, totalCount: number): Promise<void> {
    const start = Math.max(0, centerIndex - this.cacheRadius)
    const end = Math.min(totalCount - 1, centerIndex + this.cacheRadius)

    // Check which indices we need to load
    const missingRanges: Array<[number, number]> = []
    let rangeStart: number | null = null

    for (let i = start; i <= end; i++) {
      if (!this.cache.has(i)) {
        if (rangeStart === null) rangeStart = i
      } else {
        if (rangeStart !== null) {
          missingRanges.push([rangeStart, i - 1])
          rangeStart = null
        }
      }
    }
    if (rangeStart !== null) {
      missingRanges.push([rangeStart, end])
    }

    // Load missing ranges
    for (const [rStart, rEnd] of missingRanges) {
      const messages = await getMessagesInRange(this.sessionId, rStart, rEnd)
      for (let i = 0; i < messages.length; i++) {
        this.cache.set(rStart + i, messages[i])
      }
    }

    // Evict items outside cache radius
    const keysToDelete: number[] = []
    for (const key of this.cache.keys()) {
      if (key < start - this.cacheRadius || key > end + this.cacheRadius) {
        keysToDelete.push(key)
      }
    }
    for (const key of keysToDelete) {
      this.cache.delete(key)
    }
  }

  getIfCached(index: number): DisplayMessage | null {
    return this.cache.get(index) || null
  }

  clear(): void {
    this.cache.clear()
  }
}

export { CHUNK_SIZE, hashString }
