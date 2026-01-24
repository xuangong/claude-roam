/**
 * State management for Claude Roam CLI
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { v4 as uuidv4 } from "./uuid.js";

export interface SessionState {
  lastLine: number;
  localPath: string;
}

export interface AuthState {
  token: string;
  user: {
    id: string;
    provider: string;
    name: string | null;
    email: string | null;
    avatar_url: string | null;
  };
}

export interface State {
  machine_id: string;
  machine_name: string;
  // 目录映射：本地目录 -> 云端目录标识 ("machine_name:original_path")
  dirMappings: Record<string, string>;
  sessions: Record<string, SessionState>;
  // 认证信息
  auth?: AuthState;
}

const STATE_DIR = path.join(os.homedir(), ".claude-roam");
const STATE_FILE = path.join(STATE_DIR, "state.json");

/**
 * Generate a simple UUID v4
 */
function generateMachineId(): string {
  return uuidv4();
}

/**
 * Get machine name from environment or hostname
 */
function getMachineName(): string {
  return process.env.ROAM_MACHINE_NAME || os.hostname();
}

/**
 * Load state from disk
 */
export function loadState(): State {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const data = fs.readFileSync(STATE_FILE, "utf-8");
      const state = JSON.parse(data);
      // 确保 dirMappings 字段存在（兼容旧版本）
      if (!state.dirMappings) {
        state.dirMappings = {};
      }
      return state;
    }
  } catch {
    // Ignore errors, return default state
  }

  return {
    machine_id: generateMachineId(),
    machine_name: getMachineName(),
    dirMappings: {},
    sessions: {},
  };
}

/**
 * Save state to disk
 */
export function saveState(state: State): void {
  if (!fs.existsSync(STATE_DIR)) {
    fs.mkdirSync(STATE_DIR, { recursive: true });
  }
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

/**
 * Update session state
 */
export function updateSessionState(
  sessionId: string,
  lastLine: number,
  localPath: string
): void {
  const state = loadState();
  state.sessions[sessionId] = { lastLine, localPath };
  saveState(state);
}

/**
 * Get session state
 */
export function getSessionState(sessionId: string): SessionState | undefined {
  const state = loadState();
  return state.sessions[sessionId];
}

/**
 * Get all tracked sessions
 */
export function getAllTrackedSessions(): Record<string, SessionState> {
  const state = loadState();
  return state.sessions;
}

/**
 * Add directory mapping (local dir -> remote dir)
 * Remote dir format: "machine_name:original_path"
 */
export function addDirMapping(localDir: string, remoteDir: string): void {
  const state = loadState();
  state.dirMappings[localDir] = remoteDir;
  saveState(state);
}

/**
 * Remove directory mapping for a local dir
 */
export function removeDirMapping(localDir: string): boolean {
  const state = loadState();
  if (state.dirMappings[localDir]) {
    delete state.dirMappings[localDir];
    saveState(state);
    return true;
  }
  return false;
}

/**
 * Get directory mapping for a local dir
 */
export function getDirMapping(localDir: string): string | undefined {
  const state = loadState();
  return state.dirMappings[localDir];
}

/**
 * Get all directory mappings
 */
export function getAllDirMappings(): Record<string, string> {
  const state = loadState();
  return state.dirMappings;
}

/**
 * Parse remote dir string into machine and path
 * "machine_name:original_path" -> { machine: "machine_name", path: "original_path" }
 */
export function parseRemoteDir(remoteDir: string): { machine: string; path: string } | null {
  const colonIndex = remoteDir.indexOf(":");
  if (colonIndex === -1) return null;
  return {
    machine: remoteDir.slice(0, colonIndex),
    path: remoteDir.slice(colonIndex + 1),
  };
}


// ============ Auth functions ============

/**
 * Save auth state
 */
export function saveAuth(auth: AuthState): void {
  const state = loadState();
  state.auth = auth;
  saveState(state);
}

/**
 * Get auth state
 */
export function getAuth(): AuthState | undefined {
  const state = loadState();
  return state.auth;
}

/**
 * Clear auth state (logout)
 */
export function clearAuth(): void {
  const state = loadState();
  delete state.auth;
  saveState(state);
}

/**
 * Check if user is logged in
 */
export function isLoggedIn(): boolean {
  return !!getAuth()?.token;
}
