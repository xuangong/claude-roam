/**
 * Session scanner for Claude projects directory
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getClaudeProjectsDir, decodeClaudePath } from "./path.js";

export interface LocalSession {
  sessionId: string;
  filePath: string;
  directory: string; // original directory (decoded, may be inaccurate for paths with hyphens)
  encodedDir: string; // encoded directory name (used for matching)
  lineCount: number;
  modifiedAt: Date;
}

/**
 * Scan a directory for JSONL session files
 */
function scanDirectory(
  dirPath: string,
  dirName: string,
  sessions: LocalSession[]
): void {
  try {
    const files = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const file of files) {
      if (!file.isFile() || !file.name.endsWith(".jsonl")) continue;

      const filePath = path.join(dirPath, file.name);
      const sessionId = file.name.replace(".jsonl", "");

      try {
        const stats = fs.statSync(filePath);
        const content = fs.readFileSync(filePath, "utf-8");
        const lineCount = content.trim()
          ? content.trim().split("\n").length
          : 0;

        sessions.push({
          sessionId,
          filePath,
          directory: decodeClaudePath(dirName),
          encodedDir: dirName,
          lineCount,
          modifiedAt: stats.mtime,
        });
      } catch {
        // Skip files we can't read
      }
    }
  } catch {
    // Skip directories we can't read
  }
}

/**
 * Scan all JSONL files in the Claude projects directory
 */
export function scanLocalSessions(): LocalSession[] {
  const projectsDir = getClaudeProjectsDir();
  const sessions: LocalSession[] = [];

  if (!fs.existsSync(projectsDir)) {
    return sessions;
  }

  // Scan all directories in projects dir
  const dirs = fs.readdirSync(projectsDir, { withFileTypes: true });

  for (const dir of dirs) {
    if (!dir.isDirectory()) continue;

    const dirPath = path.join(projectsDir, dir.name);
    scanDirectory(dirPath, dir.name, sessions);
  }

  return sessions.sort(
    (a, b) => b.modifiedAt.getTime() - a.modifiedAt.getTime()
  );
}

/**
 * Read session content from file
 */
export function readSessionContent(filePath: string): string {
  return fs.readFileSync(filePath, "utf-8");
}

/**
 * Get incremental content from a session file
 */
export function getIncrementalContent(
  filePath: string,
  fromLine: number
): string {
  const content = readSessionContent(filePath);
  const lines = content.trim().split("\n");
  return lines.slice(fromLine - 1).join("\n");
}

/**
 * Find session by ID across all directories
 */
export function findSessionById(sessionId: string): LocalSession | undefined {
  const sessions = scanLocalSessions();
  return sessions.find((s) => s.sessionId === sessionId);
}
