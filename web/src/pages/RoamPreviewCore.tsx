import { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { MiniMap, type MiniMapItem } from '../components/MiniMap'
import { MessageRow } from '../components/MessageComponents'
import { FloatingSearch } from '../components/FloatingSearch'
import type { DisplayMessage } from '../types/message'
import { formatDateTime } from '../utils/format'
import {
  hashString,
  isSessionCached,
  getSessionMeta,
  clearSession,
  MessageCache
} from '../utils/messageStore'

// Roam bundle types
export interface RoamSession {
  id: string
  lineCount: number
  modifiedAt: string
  data: string
}

export interface RoamBundleV1 {
  version: 1
  exportedAt: string
  source: {
    machineId: string
    machineName: string
    originalPath: string
  }
  session: {
    id: string
    lineCount: number
    modifiedAt: string
  }
  data: string
}

export interface RoamBundleV2 {
  version: 2
  exportedAt: string
  source: {
    machineId: string
    machineName: string
    originalPath: string
  }
  sessions: RoamSession[]
}

export type RoamBundle = RoamBundleV1 | RoamBundleV2

// Create Web Worker for parsing and storing messages
function createParserWorker(): Worker {
  const workerCode = `
    const CHUNK_SIZE = 100;

    // IndexedDB operations in worker
    const DB_NAME = 'claude-roam-messages';
    const DB_VERSION = 1;
    const STORE_CHUNKS = 'message-chunks';
    const STORE_META = 'session-meta';

    let db = null;

    function openDB() {
      return new Promise((resolve, reject) => {
        if (db) { resolve(db); return; }
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => { db = request.result; resolve(db); };
        request.onupgradeneeded = (event) => {
          const database = event.target.result;
          if (!database.objectStoreNames.contains(STORE_CHUNKS)) {
            const store = database.createObjectStore(STORE_CHUNKS, { keyPath: ['sessionId', 'chunkIndex'] });
            store.createIndex('sessionId', 'sessionId', { unique: false });
          }
          if (!database.objectStoreNames.contains(STORE_META)) {
            database.createObjectStore(STORE_META, { keyPath: 'sessionId' });
          }
        };
      });
    }

    async function saveChunk(sessionId, chunkIndex, messages) {
      const database = await openDB();
      return new Promise((resolve, reject) => {
        const tx = database.transaction(STORE_CHUNKS, 'readwrite');
        const store = tx.objectStore(STORE_CHUNKS);
        const request = store.put({ sessionId, chunkIndex, messages });
        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve();
      });
    }

    async function saveMeta(meta) {
      const database = await openDB();
      return new Promise((resolve, reject) => {
        const tx = database.transaction(STORE_META, 'readwrite');
        const store = tx.objectStore(STORE_META);
        const request = store.put(meta);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve();
      });
    }

    async function clearSessionData(sessionId) {
      const database = await openDB();
      // Clear chunks
      await new Promise((resolve, reject) => {
        const tx = database.transaction(STORE_CHUNKS, 'readwrite');
        const store = tx.objectStore(STORE_CHUNKS);
        const index = store.index('sessionId');
        const request = index.openCursor(IDBKeyRange.only(sessionId));
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const cursor = request.result;
          if (cursor) { cursor.delete(); cursor.continue(); }
          else { resolve(); }
        };
      });
      // Clear meta
      await new Promise((resolve, reject) => {
        const tx = database.transaction(STORE_META, 'readwrite');
        const store = tx.objectStore(STORE_META);
        const request = store.delete(sessionId);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve();
      });
    }

    // Helper functions
    const truncate = (str, maxLen) => {
      if (!str || typeof str !== 'string') return str;
      if (str.length <= maxLen) return str;
      return str.substring(0, maxLen) + '...[' + (str.length - maxLen) + ' more]';
    };

    const limitInput = (input) => {
      if (!input || typeof input !== 'object') return input;
      const result = {};
      for (const key in input) {
        const val = input[key];
        if (typeof val === 'string' && val.length > 10000) {
          result[key] = truncate(val, 10000);
        } else {
          result[key] = val;
        }
      }
      return result;
    };

    // Truncate message content during first pass to reduce memory
    const truncateMessageForTree = (obj) => {
      // Only keep essential fields for tree building
      const result = {
        uuid: obj.uuid,
        parentUuid: obj.parentUuid,
        type: obj.type,
        timestamp: obj.timestamp
      };

      // Keep message but truncate content
      if (obj.message && obj.message.content) {
        const content = obj.message.content;
        if (typeof content === 'string') {
          result.message = { ...obj.message, content: truncate(content, 50000) };
        } else if (Array.isArray(content)) {
          result.message = {
            ...obj.message,
            content: content.map(item => {
              if (item.type === 'text' && item.text) {
                return { ...item, text: truncate(item.text, 50000) };
              }
              if (item.type === 'tool_use' && item.input) {
                return { ...item, input: limitInput(item.input) };
              }
              if (item.type === 'tool_result') {
                let resultContent = item.content;
                if (typeof resultContent === 'string') {
                  resultContent = truncate(resultContent, 50000);
                } else if (Array.isArray(resultContent)) {
                  resultContent = resultContent.map(c => c.text ? { ...c, text: truncate(c.text, 50000) } : c);
                }
                return { ...item, content: resultContent };
              }
              return item;
            })
          };
        } else {
          result.message = obj.message;
        }
      }

      // For summaries
      if (obj.summary) {
        result.summary = truncate(obj.summary, 5000);
      }
      if (obj.leafUuid) {
        result.leafUuid = obj.leafUuid;
      }

      return result;
    };

    // Process a raw message object into display messages
    function processRawMessage(obj, toolUseMap) {
      const results = [];
      const msgType = obj.type;

      if (msgType === 'file-history-snapshot' || msgType === 'queue-operation') {
        return results;
      }

      if (msgType === 'system') {
        // System messages may have content and subtype
        const subtype = obj.subtype || '';
        const content = obj.content || '';
        let displayContent = '';
        let jsonDetails = null;

        if (subtype === 'compact_boundary') {
          displayContent = '[Compact Boundary] ' + content;
          if (obj.compactMetadata) {
            jsonDetails = { subtype, compactMetadata: obj.compactMetadata };
          }
        } else if (subtype === 'stop_hook_summary') {
          displayContent = '[Hook] ' + (obj.stopReason || content || 'hook executed');
          jsonDetails = {
            subtype,
            hookCount: obj.hookCount,
            hookInfos: obj.hookInfos,
            hookErrors: obj.hookErrors,
            preventedContinuation: obj.preventedContinuation,
            stopReason: obj.stopReason,
            hasOutput: obj.hasOutput
          };
        } else if (content) {
          displayContent = content;
        }

        const blocks = [];
        if (displayContent) {
          blocks.push({ type: 'text', content: truncate(displayContent, 5000) });
        }
        if (jsonDetails) {
          blocks.push({ type: 'json', content: JSON.stringify(jsonDetails, null, 2) });
        }

        results.push({
          displayType: 'system',
          blocks: blocks
        });
        return results;
      }

      if (msgType === 'summary') {
        results.push({
          displayType: 'system',
          blocks: [{ type: 'text', content: '[Compacted] ' + truncate(obj.summary || '', 5000) }]
        });
        return results;
      }

      if ((msgType === 'user' || msgType === 'assistant') && obj.message) {
        const content = obj.message.content;

        if (typeof content === 'string') {
          if (content.trim()) {
            results.push({
              displayType: msgType === 'user' ? 'human' : 'assistant',
              blocks: [{ type: 'text', content: truncate(content, 50000) }]
            });
          }
        } else if (Array.isArray(content)) {
          const textParts = [];

          for (const item of content) {
            if (item.type === 'text' && item.text) {
              textParts.push(truncate(item.text, 50000));
            } else if (item.type === 'tool_use') {
              if (textParts.length > 0 && msgType === 'assistant') {
                results.push({
                  displayType: 'assistant',
                  blocks: [{ type: 'text', content: textParts.join('') }]
                });
                textParts.length = 0;
              }
              const toolId = item.id || '';
              const toolName = item.name || 'unknown_tool';
              toolUseMap.set(toolId, { id: toolId, name: toolName });
              results.push({
                displayType: 'tool_call',
                blocks: [{ type: 'tool_use', id: toolId, name: toolName, input: limitInput(item.input || {}) }],
                toolName: toolName,
                toolId: toolId
              });
            } else if (item.type === 'tool_result') {
              if (textParts.length > 0 && msgType === 'user') {
                results.push({
                  displayType: 'human',
                  blocks: [{ type: 'text', content: textParts.join('') }]
                });
                textParts.length = 0;
              }
              let resultContent = '';
              if (typeof item.content === 'string') {
                resultContent = item.content;
              } else if (Array.isArray(item.content)) {
                resultContent = item.content.map(c => c.text || '').join('\\n');
              } else if (item.content) {
                try { resultContent = JSON.stringify(item.content, null, 2); }
                catch { resultContent = '[Error]'; }
              }
              const toolInfo = toolUseMap.get(item.tool_use_id);
              results.push({
                displayType: 'tool_result',
                blocks: [{ type: 'tool_result', tool_use_id: item.tool_use_id || '', content: truncate(resultContent, 50000), is_error: item.is_error }],
                toolName: toolInfo ? toolInfo.name : 'unknown',
                toolId: item.tool_use_id
              });
            }
          }

          if (textParts.length > 0) {
            results.push({
              displayType: msgType === 'user' ? 'human' : 'assistant',
              blocks: [{ type: 'text', content: textParts.join('') }]
            });
          }
        }
      }

      return results;
    }

    self.onmessage = async function(e) {
      const { data, sessionId, dataHash } = e.data;

      try {
        self.postMessage({ type: 'progress', message: 'Clearing old data...' });
        await clearSessionData(sessionId);

        self.postMessage({ type: 'progress', message: 'Processing data stream...' });

        // Stream processing - avoid creating lines array
        // First pass: collect only uuid/parentUuid relationships (minimal data)
        const parentMap = new Map();  // uuid -> parentUuid
        const timestampMap = new Map();  // uuid -> timestamp
        const typeMap = new Map();  // uuid -> type
        const snapshotIdMap = new Map();
        const summaryUuids = [];

        let lineStart = 0;
        let lineCount = 0;
        const dataLen = data.length;

        for (let i = 0; i <= dataLen; i++) {
          if (i === dataLen || data[i] === '\\n') {
            if (i > lineStart) {
              const line = data.substring(lineStart, i);
              lineCount++;

              if (line.length < 5000000) {  // Skip extremely large lines > 5MB
                try {
                  // Quick extraction of key fields without full parse for very large lines
                  let uuid = null, parentUuid = null, type = null, timestamp = null;

                  // Extract type first
                  const typeMatch = line.match(/"type"\\s*:\\s*"([^"]+)"/);
                  if (typeMatch) type = typeMatch[1];

                  if (type === 'file-history-snapshot') {
                    // Handle snapshot id mapping
                    const msgIdMatch = line.match(/"messageId"\\s*:\\s*"([^"]+)"/);
                    const snapMsgIdMatch = line.match(/"snapshot"\\s*:\\s*\\{[^}]*"messageId"\\s*:\\s*"([^"]+)"/);
                    if (msgIdMatch && snapMsgIdMatch) {
                      snapshotIdMap.set(msgIdMatch[1], snapMsgIdMatch[1]);
                    }
                  } else if (type === 'summary') {
                    const uuidMatch = line.match(/"uuid"\\s*:\\s*"([^"]+)"/);
                    if (uuidMatch) {
                      summaryUuids.push(uuidMatch[1]);
                      typeMap.set(uuidMatch[1], 'summary');
                    }
                  } else {
                    // Extract uuid and parentUuid
                    const uuidMatch = line.match(/"uuid"\\s*:\\s*"([^"]+)"/);
                    const parentMatch = line.match(/"parentUuid"\\s*:\\s*"([^"]+)"/);
                    const tsMatch = line.match(/"timestamp"\\s*:\\s*"([^"]+)"/);

                    if (uuidMatch) {
                      uuid = uuidMatch[1];
                      parentUuid = parentMatch ? parentMatch[1] : null;
                      timestamp = tsMatch ? tsMatch[1] : null;

                      if (parentUuid && snapshotIdMap.has(parentUuid)) {
                        parentUuid = snapshotIdMap.get(parentUuid);
                      }

                      parentMap.set(uuid, parentUuid);
                      if (timestamp) timestampMap.set(uuid, timestamp);
                      if (type) typeMap.set(uuid, type);
                    }
                  }
                } catch {}
              }

              if (lineCount % 500 === 0) {
                self.postMessage({ type: 'progress', message: 'Scanned ' + lineCount + ' lines...' });
              }
            }
            lineStart = i + 1;
          }
        }

        self.postMessage({ type: 'progress', message: 'Building tree structure from ' + parentMap.size + ' messages...' });

        // Build tree structure using only the maps
        const rootCache = new Map();
        const getRoot = (uuid) => {
          if (rootCache.has(uuid)) return rootCache.get(uuid);
          let current = uuid;
          const path = [];
          while (current && parentMap.has(current)) {
            if (path.length > 10000) break;
            path.push(current);
            const parent = parentMap.get(current);
            if (!parent || !parentMap.has(parent)) {
              for (const p of path) rootCache.set(p, current);
              return current;
            }
            current = parent;
          }
          const result = path.length > 0 ? path[path.length - 1] : null;
          for (const p of path) rootCache.set(p, result);
          return result;
        };

        // Find leaves (uuids that are not parents of anyone)
        const allParents = new Set(parentMap.values());
        const leaves = [];
        for (const uuid of parentMap.keys()) {
          if (!allParents.has(uuid)) leaves.push(uuid);
        }

        // Group leaves by root
        const leavesByRoot = new Map();
        for (const leaf of leaves) {
          const root = getRoot(leaf);
          if (root) {
            if (!leavesByRoot.has(root)) leavesByRoot.set(root, []);
            leavesByRoot.get(root).push(leaf);
          }
        }

        // Sort roots by latest timestamp
        const rootTimestamps = [];
        for (const [root, rootLeaves] of leavesByRoot) {
          let latest = '';
          for (const leaf of rootLeaves) {
            const ts = timestampMap.get(leaf) || '';
            if (ts > latest) latest = ts;
          }
          rootTimestamps.push([root, latest]);
        }
        rootTimestamps.sort((a, b) => a[1].localeCompare(b[1]));

        self.postMessage({ type: 'progress', message: 'Processing ' + rootTimestamps.length + ' conversation trees...' });

        // Second pass: process and save messages
        let currentChunk = [];
        let chunkIndex = 0;
        let totalMessages = 0;

        const saveCurrentChunk = async () => {
          if (currentChunk.length > 0) {
            await saveChunk(sessionId, chunkIndex, currentChunk);
            chunkIndex++;
            currentChunk = [];
          }
        };

        // Build uuid to line position map for quick lookup
        const uuidPositions = new Map();
        lineStart = 0;
        for (let i = 0; i <= dataLen; i++) {
          if (i === dataLen || data[i] === '\\n') {
            if (i > lineStart) {
              const lineEnd = i;
              const lineLen = lineEnd - lineStart;
              // Search for uuid - check beginning first, then end of line
              // uuid is typically near the end of the JSON object
              let sample = data.substring(lineStart, Math.min(lineStart + 500, lineEnd));
              let uuidMatch = sample.match(/"uuid"\\s*:\\s*"([^"]+)"/);

              if (!uuidMatch && lineLen > 500) {
                // Try the last 500 chars
                sample = data.substring(Math.max(lineStart, lineEnd - 500), lineEnd);
                uuidMatch = sample.match(/"uuid"\\s*:\\s*"([^"]+)"/);
              }

              if (uuidMatch) {
                uuidPositions.set(uuidMatch[1], [lineStart, lineEnd]);
              }
            }
            lineStart = i + 1;
          }
        }

        const toolUseMap = new Map();
        const messageTypes = [];  // Store type info for minimap

        const parseAndProcessLine = (start, end) => {
          const line = data.substring(start, end);
          if (line.length > 5000000) return [];  // Skip > 5MB lines

          try {
            const obj = JSON.parse(line);
            return processRawMessage(obj, toolUseMap);
          } catch (e) {
            return [];
          }
        };

        const addMessage = async (msg) => {
          currentChunk.push(msg);
          // Record type for minimap: h=human, a=assistant, c=tool_call, r=tool_result, s=separator, y=system
          const typeChar = msg.displayType === 'human' ? 'h' :
                          msg.displayType === 'assistant' ? 'a' :
                          msg.displayType === 'tool_call' ? 'c' :
                          msg.displayType === 'tool_result' ? 'r' :
                          msg.displayType === 'tree-separator' ? 's' :
                          msg.displayType === 'system' ? 'y' : 'a';
          messageTypes.push(typeChar);
          totalMessages++;
          if (currentChunk.length >= CHUNK_SIZE) {
            await saveCurrentChunk();
            if (totalMessages % 500 === 0) {
              self.postMessage({ type: 'progress', message: 'Saved ' + totalMessages + ' messages...' });
            }
          }
        };

        // Process each tree
        let treeIndex = 0;
        const processedUuids = new Set();

        for (const [root, _] of rootTimestamps) {
          const rootLeaves = leavesByRoot.get(root) || [];

          // Find the leaf with latest timestamp
          let currentLeaf = null;
          let latestTs = '';
          for (const leaf of rootLeaves) {
            const ts = timestampMap.get(leaf) || '';
            if (ts > latestTs) {
              latestTs = ts;
              currentLeaf = leaf;
            }
          }

          if (!currentLeaf) continue;

          // Build chain from leaf to root
          const chain = [];
          let current = currentLeaf;
          const visited = new Set();
          while (current && !visited.has(current)) {
            visited.add(current);
            chain.unshift(current);
            current = parentMap.get(current);
            if (chain.length > 50000) break;
          }

          treeIndex++;
          if (treeIndex > 1 || rootTimestamps.length > 1) {
            await addMessage({
              displayType: 'tree-separator',
              blocks: [],
              treeIndex: treeIndex,
              treeSummaryCount: 0,
              treeTimestamp: latestTs
            });
          }

          // Process each message in chain
          for (const uuid of chain) {
            if (processedUuids.has(uuid)) continue;
            processedUuids.add(uuid);

            const pos = uuidPositions.get(uuid);
            if (pos) {
              const msgs = parseAndProcessLine(pos[0], pos[1]);
              for (const m of msgs) await addMessage(m);
            }
          }
        }

        // Save final chunk
        await saveCurrentChunk();

        // Save metadata with type string for minimap
        const typeString = messageTypes.join('');
        await saveMeta({
          sessionId: sessionId,
          totalMessages: totalMessages,
          totalChunks: chunkIndex,
          processedAt: Date.now(),
          dataHash: dataHash,
          typeString: typeString
        });

        self.postMessage({ type: 'progress', message: 'Done! ' + totalMessages + ' messages saved' });
        self.postMessage({ type: 'done', totalMessages: totalMessages, totalChunks: chunkIndex, typeString: typeString });

      } catch (err) {
        self.postMessage({ type: 'error', message: 'Error: ' + err.message + ' at ' + err.stack });
      }
    };
  `;

  const blob = new Blob([workerCode], { type: 'application/javascript' })
  const url = URL.createObjectURL(blob)
  return new Worker(url)
}

// Session List View
function SessionListView({
  sessions,
  source,
  minLines,
  onMinLinesChange,
  onSelectSession
}: {
  sessions: RoamSession[]
  source: { machineName: string; originalPath: string }
  minLines: number
  onMinLinesChange: (n: number) => void
  onSelectSession: (s: RoamSession) => void
}) {
  const filteredSessions = sessions.filter(s => s.lineCount >= minLines)

  return (
    <>
      <div className="detail-header">
        <h1>Roam Preview</h1>
        <div className="detail-meta">
          <span>Source: {source.machineName}:{source.originalPath}</span>
          <span>{filteredSessions.length} of {sessions.length} sessions</span>
        </div>
      </div>

      <div className="section">
        <div className="filter-box" style={{ marginBottom: 'var(--space-4)' }}>
          <label htmlFor="minLines">Min lines:</label>
          <input
            id="minLines"
            type="number"
            min="0"
            value={minLines || ''}
            onChange={e => onMinLinesChange(parseInt(e.target.value) || 0)}
            placeholder="0"
          />
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
          {filteredSessions.map((s) => (
            <div
              key={s.id}
              className="session-card"
              onClick={() => onSelectSession(s)}
              style={{ cursor: 'pointer' }}
            >
              <div style={{ flex: 1 }}>
                <div className="session-id">{s.id}</div>
                <div className="session-meta">
                  <span>{s.lineCount} lines</span>
                  <span>{formatDateTime(s.modifiedAt)}</span>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </>
  )
}

// Estimate message height based on type char (from typeString)
function estimateHeightByType(typeChar: string): number {
  switch (typeChar) {
    case 'h': return 80   // human
    case 'a': return 150  // assistant
    case 'c': return 50   // tool_call
    case 'r': return 80   // tool_result
    case 's': return 40   // tree-separator
    case 'y': return 40   // system
    default: return 60
  }
}

// Estimate message height from actual message content
function estimateMessageHeight(msg: DisplayMessage | null, typeChar?: string): number {
  if (!msg) {
    // Use typeChar if available, otherwise default
    return typeChar ? estimateHeightByType(typeChar) : 60
  }
  switch (msg.displayType) {
    case 'human': {
      const textLen = msg.blocks.reduce((acc, b) => acc + (b.type === 'text' ? b.content.length : 0), 0)
      return Math.max(60, Math.min(400, 60 + Math.floor(textLen / 80) * 20))
    }
    case 'assistant': {
      const textLen = msg.blocks.reduce((acc, b) => acc + (b.type === 'text' ? b.content.length : 0), 0)
      return Math.max(60, Math.min(600, 60 + Math.floor(textLen / 80) * 20))
    }
    case 'tool_call': return 50
    case 'tool_result': return 80
    case 'tree-separator': return 40
    case 'system': return 40
    default: return 60
  }
}

// Session Detail View with IndexedDB-backed virtual scrolling
function SessionDetailView({
  session,
  source,
  onBack
}: {
  session: RoamSession
  source: { machineName: string; originalPath: string }
  onBack: () => void
}) {
  const [isLoading, setIsLoading] = useState(true)
  const [loadingProgress, setLoadingProgress] = useState('')
  const [totalMessages, setTotalMessages] = useState(0)
  const [typeString, setTypeString] = useState('')  // For minimap colors
  const [visibleMessages, setVisibleMessages] = useState<Map<number, DisplayMessage>>(new Map())
  const [visibleStart, setVisibleStart] = useState(0)
  const [visibleEnd, setVisibleEnd] = useState(1)
  const parentRef = useRef<HTMLDivElement>(null)
  const cacheRef = useRef<MessageCache | null>(null)

  // Search state
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<number[]>([])  // Message indices with matches
  const [currentSearchIndex, setCurrentSearchIndex] = useState(-1)  // Current result being viewed
  const [refreshKey, setRefreshKey] = useState(0)  // For forcing re-parse
  const [showSearch, setShowSearch] = useState(false)  // Show floating search

  // Handle keyboard shortcuts for search
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Ctrl/Cmd + F to open search
      if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
        e.preventDefault()
        setShowSearch(true)
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [])

  // Clear cache and refresh
  const handleRefreshCache = useCallback(async () => {
    await clearSession(session.id)
    cacheRef.current?.clear()
    setRefreshKey(k => k + 1)
  }, [session.id])

  // Initialize and parse session data
  useEffect(() => {
    let cancelled = false
    const sessionId = session.id
    const dataHash = hashString(session.data)

    async function init(forceReparse = false) {
      setIsLoading(true)
      setLoadingProgress('Checking cache...')

      // Check if already cached (skip if forcing reparse)
      const cached = !forceReparse && await isSessionCached(sessionId, dataHash)
      if (cached && !cancelled) {
        const meta = await getSessionMeta(sessionId)
        if (meta) {
          const ts = (meta as { typeString?: string }).typeString || ''
          // If typeString is missing, need to re-parse
          if (ts.length > 0) {
            setTotalMessages(meta.totalMessages)
            setTypeString(ts)
            cacheRef.current = new MessageCache(sessionId)
            // Preload all messages into memory for fast scrolling
            setLoadingProgress('Loading messages into memory...')
            await cacheRef.current.prefetch(Math.floor(meta.totalMessages / 2), meta.totalMessages)
            setIsLoading(false)
            return
          }
        }
      }

      // Need to parse - use worker
      setLoadingProgress('Starting parser...')
      const worker = createParserWorker()

      worker.onmessage = async (e) => {
        if (cancelled) return

        const { type, message, totalMessages: total, typeString: ts } = e.data
        if (type === 'progress') {
          setLoadingProgress(message)
        } else if (type === 'done') {
          worker.terminate()
          setTotalMessages(total)
          setTypeString(ts || '')
          cacheRef.current = new MessageCache(sessionId)
          // Preload all messages into memory for fast scrolling
          setLoadingProgress('Loading messages into memory...')
          await cacheRef.current.prefetch(Math.floor(total / 2), total)
          setIsLoading(false)
        } else if (type === 'error') {
          worker.terminate()
          setLoadingProgress('Error: ' + message)
        }
      }

      worker.onerror = (err) => {
        worker.terminate()
        setLoadingProgress('Worker error: ' + err.message)
      }

      worker.postMessage({ data: session.data, sessionId, dataHash })
    }

    init(refreshKey > 0)

    return () => {
      cancelled = true
      cacheRef.current?.clear()
    }
  }, [session, refreshKey])

  // Virtualizer
  const virtualizer = useVirtualizer({
    count: totalMessages,
    getScrollElement: () => parentRef.current,
    estimateSize: (index) => estimateMessageHeight(visibleMessages.get(index) || null, typeString[index]),
    overscan: 20,
  })

  // Search effect - search through all messages when query changes
  useEffect(() => {
    if (!searchQuery.trim() || !cacheRef.current || totalMessages === 0) {
      setSearchResults([])
      setCurrentSearchIndex(-1)
      return
    }

    const query = searchQuery.toLowerCase()
    const results: number[] = []

    // Search through all cached messages
    for (let i = 0; i < totalMessages; i++) {
      const msg = cacheRef.current.getIfCached(i)
      if (msg) {
        // Search in text blocks
        for (const block of msg.blocks) {
          if (block.type === 'text' && block.content.toLowerCase().includes(query)) {
            results.push(i)
            break
          } else if (block.type === 'tool_use' && block.name.toLowerCase().includes(query)) {
            results.push(i)
            break
          } else if (block.type === 'tool_result' && block.content.toLowerCase().includes(query)) {
            results.push(i)
            break
          }
        }
      }
    }

    setSearchResults(results)
    if (results.length > 0) {
      setCurrentSearchIndex(0)
      virtualizer.scrollToIndex(results[0], { align: 'center' })
    } else {
      setCurrentSearchIndex(-1)
    }
  }, [searchQuery, totalMessages, virtualizer])

  // Search navigation functions
  const handleSearchNext = useCallback(() => {
    if (searchResults.length === 0) return
    const newIndex = currentSearchIndex >= searchResults.length - 1 ? 0 : currentSearchIndex + 1
    setCurrentSearchIndex(newIndex)
    virtualizer.scrollToIndex(searchResults[newIndex], { align: 'center' })
  }, [searchResults, currentSearchIndex, virtualizer])

  const handleSearchPrev = useCallback(() => {
    if (searchResults.length === 0) return
    const newIndex = currentSearchIndex <= 0 ? searchResults.length - 1 : currentSearchIndex - 1
    setCurrentSearchIndex(newIndex)
    virtualizer.scrollToIndex(searchResults[newIndex], { align: 'center' })
  }, [searchResults, currentSearchIndex, virtualizer])

  const handleSearchClose = useCallback(() => {
    setShowSearch(false)
    setSearchQuery('')
    setSearchResults([])
    setCurrentSearchIndex(-1)
  }, [])

  // Handle click on search result marker in minimap
  const handleSearchResultClick = useCallback((searchIndex: number) => {
    setCurrentSearchIndex(searchIndex)
    virtualizer.scrollToIndex(searchResults[searchIndex], { align: 'center' })
  }, [searchResults, virtualizer])

  // Load visible messages from IndexedDB
  useEffect(() => {
    if (isLoading || totalMessages === 0 || !cacheRef.current) return

    const range = virtualizer.range
    if (!range) return

    const start = Math.max(0, range.startIndex - 50)
    const end = Math.min(totalMessages - 1, range.endIndex + 50)

    // Prefetch and update visible messages
    cacheRef.current.prefetch(Math.floor((start + end) / 2), totalMessages).then(() => {
      const newVisible = new Map<number, DisplayMessage>()
      for (let i = start; i <= end; i++) {
        const msg = cacheRef.current?.getIfCached(i)
        if (msg) newVisible.set(i, msg)
      }
      setVisibleMessages(newVisible)
    })

    // Update minimap range based on visible message indices
    // Use message index ratio for consistency with separator positions
    if (totalMessages > 0) {
      setVisibleStart(range.startIndex / totalMessages)
      setVisibleEnd(Math.min(1, (range.endIndex + 1) / totalMessages))
    }
  }, [virtualizer.range, isLoading, totalMessages])

  // Minimap items - merge adjacent same-type messages for better visibility
  const minimapItems = useMemo<MiniMapItem[]>(() => {
    if (totalMessages === 0 || !typeString) return []

    // Map type chars to display types
    const charToType: Record<string, string> = {
      'h': 'human',
      'a': 'assistant',
      'c': 'tool_call',
      'r': 'tool_result',
      's': 'tree-separator',
      'y': 'system'
    }

    const items: MiniMapItem[] = []
    let treeIdx = 0
    let currentType: string | null = null
    let currentStart = 0
    let currentCount = 0

    const pushCurrentBlock = () => {
      if (currentType && currentCount > 0) {
        items.push({
          type: currentType,
          index: currentStart,
          heightRatio: currentCount / totalMessages,
          treeIndex: currentType === 'tree-separator' ? treeIdx : undefined
        })
      }
    }

    for (let i = 0; i < totalMessages; i++) {
      const typeChar = typeString[i] || 'a'
      const displayType = charToType[typeChar] || 'assistant'

      if (displayType === 'tree-separator') {
        // Always create separate item for separator
        pushCurrentBlock()
        treeIdx++
        items.push({
          type: 'tree-separator',
          index: i,
          heightRatio: 1 / totalMessages,
          treeIndex: treeIdx
        })
        currentType = null
        currentCount = 0
      } else if (displayType === currentType) {
        // Merge with current block
        currentCount++
      } else {
        // Start new block
        pushCurrentBlock()
        currentType = displayType
        currentStart = i
        currentCount = 1
      }
    }
    // Push final block
    pushCurrentBlock()

    return items
  }, [totalMessages, typeString])

  // Ref to track ongoing scroll target
  const scrollTargetRef = useRef<number | null>(null)

  const handleMinimapNavigate = useCallback((ratio: number) => {
    if (!parentRef.current) return

    // ratio is message index ratio, convert to target message index
    const targetIndex = Math.floor(ratio * totalMessages)

    // Save target for continuous scrolling
    scrollTargetRef.current = ratio

    // Function to scroll to target index
    const scrollToTarget = () => {
      // Check if this scroll target is still valid
      if (scrollTargetRef.current !== ratio) return
      if (!parentRef.current) return

      // Use virtualizer to scroll to the target index
      virtualizer.scrollToIndex(targetIndex, { align: 'start' })

      // Check if we need to keep adjusting
      const range = virtualizer.range
      if (range && Math.abs(range.startIndex - targetIndex) > 2) {
        requestAnimationFrame(scrollToTarget)
      }
    }

    // Start scrolling
    scrollToTarget()

    // Prefetch messages around target
    if (cacheRef.current) {
      cacheRef.current.prefetch(targetIndex, totalMessages)
    }
  }, [totalMessages, virtualizer])

  // Loading state
  if (isLoading) {
    return (
      <>
        <button onClick={onBack} className="back-link" style={{ background: 'none', border: 'none', padding: 0 }}>
          Back to session list
        </button>

        <div className="detail-header">
          <h1>{session.id}</h1>
          <div className="detail-meta">
            <span>{session.lineCount} lines</span>
            <span>Modified: {formatDateTime(session.modifiedAt)}</span>
            <span>Source: {source.machineName}</span>
          </div>
        </div>

        <div className="section conversation-section">
          <h2>Conversation</h2>
          <div className="loading-container" style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '60px 20px',
            color: 'var(--text-secondary)'
          }}>
            <div className="loading-spinner" style={{
              width: '40px',
              height: '40px',
              border: '3px solid var(--border)',
              borderTopColor: 'var(--accent)',
              borderRadius: '50%',
              animation: 'spin 1s linear infinite',
              marginBottom: '16px'
            }} />
            <div style={{ fontSize: '14px' }}>{loadingProgress}</div>
            <style>{`
              @keyframes spin {
                to { transform: rotate(360deg); }
              }
            `}</style>
          </div>
        </div>
      </>
    )
  }

  const virtualItems = virtualizer.getVirtualItems()
  const totalSize = virtualizer.getTotalSize()

  return (
    <>
      <button onClick={onBack} className="back-link" style={{ background: 'none', border: 'none', padding: 0 }}>
        Back to session list
      </button>

      <div className="detail-header">
        <h1>{session.id}</h1>
        <div className="detail-meta">
          <span>{session.lineCount} lines</span>
          <span>{totalMessages} messages</span>
          <span>Modified: {formatDateTime(session.modifiedAt)}</span>
          <span>Source: {source.machineName}</span>
          <button
            onClick={() => setShowSearch(true)}
            style={{
              padding: 'var(--space-1) var(--space-2)',
              fontSize: '12px',
              cursor: 'pointer',
              background: 'var(--bg-tertiary)',
              border: '1px solid var(--border-default)',
              borderRadius: 'var(--radius-sm)',
              color: 'var(--text-secondary)',
            }}
            title="Search (Ctrl+F)"
          >
            🔍 Search
          </button>
          <button
            onClick={handleRefreshCache}
            style={{
              marginLeft: 'auto',
              padding: 'var(--space-1) var(--space-2)',
              fontSize: '12px',
              cursor: 'pointer',
              background: 'var(--bg-tertiary)',
              border: '1px solid var(--border-default)',
              borderRadius: 'var(--radius-sm)',
              color: 'var(--text-secondary)',
            }}
            title="Clear cache and re-parse messages"
          >
            ↻ Refresh
          </button>
        </div>
      </div>

      {/* Floating Search */}
      {showSearch && (
        <FloatingSearch
          totalResults={searchResults.length}
          currentIndex={currentSearchIndex}
          onSearch={setSearchQuery}
          onNext={handleSearchNext}
          onPrev={handleSearchPrev}
          onClose={handleSearchClose}
        />
      )}

      <div className="section conversation-section">
        <h2>Conversation</h2>
        <div className="conversation-container">
          <div
            className="conversation-flow virtual-scroll-container"
            ref={parentRef}
            style={{
              height: 'calc(100vh - 200px)',
              overflow: 'auto',
              contain: 'strict',
              scrollbarWidth: 'none',  // Firefox
              msOverflowStyle: 'none', // IE/Edge
              scrollBehavior: 'auto',  // Disable smooth scrolling
            }}
          >
            {totalMessages === 0 ? (
              <div className="empty-conversation">No conversation data to display</div>
            ) : (
              <div style={{ height: `${totalSize}px`, width: '100%', position: 'relative' }}>
                {virtualItems.map((virtualRow) => {
                  const msg = visibleMessages.get(virtualRow.index) || null
                  return (
                    <div
                      key={virtualRow.key}
                      data-index={virtualRow.index}
                      ref={virtualizer.measureElement}
                      style={{
                        position: 'absolute',
                        top: 0,
                        left: 0,
                        width: '100%',
                        transform: `translateY(${virtualRow.start}px)`,
                      }}
                    >
                      <MessageRow
                        msg={msg}
                        searchQuery={searchQuery}
                        isSearchMatch={searchResults.includes(virtualRow.index)}
                      />
                    </div>
                  )
                })}
              </div>
            )}
          </div>
          {totalMessages > 0 && (
            <MiniMap
              items={minimapItems}
              visibleStart={visibleStart}
              visibleEnd={visibleEnd}
              onNavigate={handleMinimapNavigate}
              totalMessages={totalMessages}
              searchResults={searchResults}
              currentSearchIndex={currentSearchIndex}
              onSearchResultClick={handleSearchResultClick}
            />
          )}
        </div>
      </div>
    </>
  )
}

// Main RoamPreviewCore component
interface RoamPreviewCoreProps {
  bundle: RoamBundle
  sessions: RoamSession[]
}

function RoamPreviewCore({ bundle, sessions }: RoamPreviewCoreProps) {
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null)
  const [minLines, setMinLines] = useState(() => {
    const saved = localStorage.getItem('minLines')
    return saved ? parseInt(saved) : 0
  })

  useEffect(() => {
    localStorage.setItem('minLines', String(minLines))
  }, [minLines])

  const selectedSession = selectedSessionId
    ? sessions.find(s => s.id === selectedSessionId) || null
    : null

  if (selectedSession) {
    return (
      <div className="detail-page">
        <SessionDetailView
          session={selectedSession}
          source={bundle.source}
          onBack={() => setSelectedSessionId(null)}
        />
      </div>
    )
  }

  return (
    <div className="detail-page">
      <SessionListView
        sessions={sessions}
        source={bundle.source}
        minLines={minLines}
        onMinLinesChange={setMinLines}
        onSelectSession={(session) => setSelectedSessionId(session.id)}
      />
    </div>
  )
}

export default RoamPreviewCore
