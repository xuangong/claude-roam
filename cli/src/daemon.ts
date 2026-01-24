/**
 * Daemon for watching and auto-syncing Claude sessions
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getClaudeProjectsDir, decodeClaudePath, detectPlatform } from "./path.js";
import { pushSession, type PushRequest } from "./api.js";
import {
  loadState,
  updateSessionState,
  type State,
} from "./state.js";

interface WatchedFile {
  sessionId: string;
  filePath: string;
  directory: string;
  lastLineCount: number;
  debounceTimer?: ReturnType<typeof setTimeout>;
}

const DEBOUNCE_MS = 2000;
const watchedFiles = new Map<string, WatchedFile>();
let state: State;

/**
 * Initialize daemon state
 */
function initDaemon(): void {
  state = loadState();
  console.log(`Machine ID: ${state.machine_id}`);
  console.log(`Machine Name: ${state.machine_name}`);
  console.log(`Platform: ${detectPlatform()}`);
}

/**
 * Count lines in a file
 */
function countLines(filePath: string): number {
  try {
    const content = fs.readFileSync(filePath, "utf-8").trim();
    return content ? content.split("\n").length : 0;
  } catch {
    return 0;
  }
}

/**
 * Get incremental content from file
 */
function getIncrementalContent(filePath: string, fromLine: number): string {
  try {
    const content = fs.readFileSync(filePath, "utf-8").trim();
    const lines = content.split("\n");
    return lines.slice(fromLine - 1).join("\n");
  } catch {
    return "";
  }
}

/**
 * Push changes for a file
 */
async function pushChanges(watched: WatchedFile): Promise<void> {
  const currentLines = countLines(watched.filePath);

  if (currentLines <= watched.lastLineCount) {
    return; // No new content
  }

  const fromLine = watched.lastLineCount + 1;
  const appendData = getIncrementalContent(watched.filePath, fromLine);

  if (!appendData.trim()) {
    return; // No content to push
  }

  const request: PushRequest = {
    from_line: fromLine,
    append_data: appendData,
    source: {
      machine_id: state.machine_id,
      machine_name: state.machine_name,
      platform: detectPlatform(),
      original_path: watched.directory,
    },
  };

  try {
    await pushSession(watched.sessionId, request);
    watched.lastLineCount = currentLines;
    updateSessionState(watched.sessionId, currentLines, watched.filePath);
    console.log(
      `[${new Date().toISOString()}] Pushed ${watched.sessionId}: lines ${fromLine}-${currentLines}`
    );
  } catch (err) {
    console.error(
      `[${new Date().toISOString()}] Failed to push ${watched.sessionId}:`,
      err
    );
  }
}

/**
 * Handle file change event with debounce
 */
function handleFileChange(filePath: string): void {
  const watched = watchedFiles.get(filePath);
  if (!watched) return;

  // Clear existing debounce timer
  if (watched.debounceTimer) {
    clearTimeout(watched.debounceTimer);
  }

  // Set new debounce timer
  watched.debounceTimer = setTimeout(async () => {
    await pushChanges(watched);
  }, DEBOUNCE_MS);
}

/**
 * Add a file to watch list
 */
function addWatchedFile(
  filePath: string,
  sessionId: string,
  directory: string
): void {
  const sessionState = state.sessions[sessionId];
  const lastLineCount = sessionState?.lastLine || 0;

  watchedFiles.set(filePath, {
    sessionId,
    filePath,
    directory,
    lastLineCount,
  });
}

/**
 * Scan directory for existing session files
 */
function scanDirectory(dirPath: string, encodedDir: string): void {
  try {
    const files = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const file of files) {
      if (!file.isFile() || !file.name.endsWith(".jsonl")) continue;

      const filePath = path.join(dirPath, file.name);
      const sessionId = file.name.replace(".jsonl", "");
      const directory = decodeClaudePath(encodedDir);

      addWatchedFile(filePath, sessionId, directory);
    }
  } catch {
    // Ignore errors
  }
}

/**
 * Watch a directory for new files
 */
function watchDirectory(dirPath: string, encodedDir: string): void {
  try {
    fs.watch(dirPath, (eventType, filename) => {
      if (!filename?.endsWith(".jsonl")) return;

      const filePath = path.join(dirPath, filename);

      if (eventType === "rename") {
        // File added or removed
        if (fs.existsSync(filePath)) {
          const sessionId = filename.replace(".jsonl", "");
          const directory = decodeClaudePath(encodedDir);
          if (!watchedFiles.has(filePath)) {
            addWatchedFile(filePath, sessionId, directory);
            console.log(`[${new Date().toISOString()}] Now watching: ${sessionId}`);
          }
          handleFileChange(filePath);
        } else {
          watchedFiles.delete(filePath);
        }
      } else if (eventType === "change") {
        handleFileChange(filePath);
      }
    });
  } catch (err) {
    console.error(`Failed to watch directory ${dirPath}:`, err);
  }
}

/**
 * Start the daemon
 */
export async function startDaemon(): Promise<void> {
  initDaemon();

  const projectsDir = getClaudeProjectsDir();
  console.log(`Watching: ${projectsDir}`);

  if (!fs.existsSync(projectsDir)) {
    fs.mkdirSync(projectsDir, { recursive: true });
  }

  // Scan existing directories
  const dirs = fs.readdirSync(projectsDir, { withFileTypes: true });
  for (const dir of dirs) {
    if (!dir.isDirectory()) continue;

    const dirPath = path.join(projectsDir, dir.name);
    scanDirectory(dirPath, dir.name);
    watchDirectory(dirPath, dir.name);
  }

  // Watch for new directories
  fs.watch(projectsDir, (eventType, filename) => {
    if (eventType === "rename" && filename) {
      const dirPath = path.join(projectsDir, filename);
      if (fs.existsSync(dirPath) && fs.statSync(dirPath).isDirectory()) {
        console.log(`[${new Date().toISOString()}] New project directory: ${filename}`);
        scanDirectory(dirPath, filename);
        watchDirectory(dirPath, filename);
      }
    }
  });

  console.log(`Watching ${watchedFiles.size} session files`);
  console.log("Daemon started. Press Ctrl+C to stop.");

  // Initial push for any files that have new content
  for (const watched of watchedFiles.values()) {
    const currentLines = countLines(watched.filePath);
    if (currentLines > watched.lastLineCount) {
      await pushChanges(watched);
    }
  }

  // Keep the process running
  await new Promise(() => {});
}

/**
 * Check daemon status
 */
export function getDaemonStatus(): { watching: number; sessions: string[] } {
  return {
    watching: watchedFiles.size,
    sessions: Array.from(watchedFiles.values()).map((w) => w.sessionId),
  };
}
