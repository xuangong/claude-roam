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
 * /home/user/code → -home-user-code
 * C:\Users\foo → -C-Users-foo
 */
export function encodePathForClaude(absPath: string): string {
  // Normalize path separators
  let normalized = absPath.replace(/\\/g, "/");

  // Handle Windows drive letters
  if (/^[A-Z]:/i.test(normalized)) {
    normalized = normalized.replace(/^([A-Z]):/, "/$1");
  }

  // Replace slashes with dashes
  return normalized.replace(/\//g, "-");
}

/**
 * Decode a Claude encoded path
 * -home-user-code → /home/user/code
 * -C-Users-foo → C:/Users/foo
 */
export function decodeClaudePath(encoded: string): string {
  // Replace dashes with slashes
  const decoded = encoded.replace(/-/g, "/");

  // Handle Windows drive letters
  if (/^\/[A-Z]\//.test(decoded)) {
    return decoded.replace(/^\/([A-Z])\//, "$1:/");
  }

  return decoded;
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
