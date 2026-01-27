/**
 * Path utilities for Claude Roam CLI
 */

import * as os from "node:os";
import * as path from "node:path";

/**
 * Detect the current platform
 */
export function detectPlatform(): "darwin" | "linux" | "wsl" | "win32" {
  if (process.platform === "win32") return "win32";
  if (process.platform === "darwin") return "darwin";

  // 检测 WSL
  const release = os.release().toLowerCase();
  if (release.includes("microsoft") || release.includes("wsl")) {
    return "wsl";
  }
  return "linux";
}

/**
 * Get the Claude projects directory
 */
export function getClaudeProjectsDir(): string {
  const platform = detectPlatform();
  if (platform === "win32") {
    return path.join(os.homedir(), ".claude", "projects");
  }
  return path.join(os.homedir(), ".claude", "projects");
}

/**
 * Encode a path for Claude directory naming
 * Unix: /home/user/code → -home-user-code
 * Windows: C:\Users\foo → C--Users-foo
 */
export function encodePathForClaude(absPath: string): string {
  // Normalize path separators to forward slashes
  const normalized = absPath.replace(/\\/g, "/");

  // Check if it's a Windows path (starts with drive letter)
  if (/^[A-Z]:/i.test(normalized)) {
    // Windows: C:/Users/foo → C--Users-foo
    // Replace :/ with -- and remaining / with -
    return normalized.replace(/:\//, "--").replace(/\//g, "-");
  }

  // Unix: /home/user/code → -home-user-code
  return normalized.replace(/\//g, "-");
}

/**
 * Decode a Claude encoded path
 * Unix: -home-user-code → /home/user/code
 * Windows: C--Users-foo → C:/Users/foo
 */
export function decodeClaudePath(encoded: string): string {
  // Check if it's a Windows encoded path (starts with drive letter followed by --)
  if (/^[A-Z]--/i.test(encoded)) {
    // Windows: C--Users-foo → C:/Users/foo
    return encoded.replace(/^([A-Z])--/, "$1:/").replace(/-/g, "/");
  }

  // Unix: -home-user-code → /home/user/code
  return encoded.replace(/-/g, "/");
}

/**
 * Get the target directory for a pulled session
 */
export function getSessionTargetDir(targetDir: string): string {
  const absPath = path.resolve(targetDir);
  const encoded = encodePathForClaude(absPath);
  return path.join(getClaudeProjectsDir(), encoded);
}

/**
 * Get the session file path
 */
export function getSessionFilePath(
  sessionId: string,
  targetDir: string
): string {
  return path.join(getSessionTargetDir(targetDir), `${sessionId}.jsonl`);
}
