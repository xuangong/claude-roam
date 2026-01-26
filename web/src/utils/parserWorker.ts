/**
 * Web Worker factory for parsing large session data
 * This runs parsing off the main thread to avoid UI freezing
 */

export function createParserWorker(): Worker {
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

    // Process a raw message object into display messages
    function processRawMessage(obj, toolUseMap) {
      const results = [];
      const msgType = obj.type;

      if (msgType === 'file-history-snapshot' || msgType === 'queue-operation') {
        return results;
      }

      if (msgType === 'system') {
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

      if (msgType === 'tree-separator') {
        results.push({
          displayType: 'tree-separator',
          blocks: [],
          treeIndex: obj.treeIndex,
          treeSummaryCount: obj.treeSummaryCount || 0,
          treeTimestamp: obj.timestamp || ''
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

        // First pass: collect uuid/parentUuid relationships
        const parentMap = new Map();
        const timestampMap = new Map();
        const typeMap = new Map();
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

              if (line.length < 5000000) {
                try {
                  let uuid = null, parentUuid = null, type = null, timestamp = null;

                  const typeMatch = line.match(/"type"\\s*:\\s*"([^"]+)"/);
                  if (typeMatch) type = typeMatch[1];

                  if (type === 'file-history-snapshot') {
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

        // Build tree structure
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

        // Find leaves
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

        // Build uuid to line position map
        const uuidPositions = new Map();
        lineStart = 0;
        for (let i = 0; i <= dataLen; i++) {
          if (i === dataLen || data[i] === '\\n') {
            if (i > lineStart) {
              const lineEnd = i;
              const lineLen = lineEnd - lineStart;
              let sample = data.substring(lineStart, Math.min(lineStart + 500, lineEnd));
              let uuidMatch = sample.match(/"uuid"\\s*:\\s*"([^"]+)"/);

              if (!uuidMatch && lineLen > 500) {
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
        const messageTypes = [];

        const parseAndProcessLine = (start, end) => {
          const line = data.substring(start, end);
          if (line.length > 5000000) return [];

          try {
            const obj = JSON.parse(line);
            return processRawMessage(obj, toolUseMap);
          } catch (e) {
            return [];
          }
        };

        const addMessage = async (msg) => {
          currentChunk.push(msg);
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

        // Save metadata
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
  `

  const blob = new Blob([workerCode], { type: 'application/javascript' })
  const url = URL.createObjectURL(blob)
  return new Worker(url)
}
