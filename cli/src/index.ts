#!/usr/bin/env bun
/**
 * Claude Roam CLI - Main entry point
 */

import { Command } from "commander";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  pullSession as pullSessionApi,
  pushSession as pushSessionApi,
  listSessions,
  listSessionsByDir,
  listSessionsGrouped,
  healthCheck,
  requestDeviceCode,
  pollDeviceToken,
  getCurrentUser,
  getRemoteSessionIds,
} from "./api.js";
import { startDaemon } from "./daemon.js";
import {
  detectPlatform,
  getSessionFilePath,
  getSessionTargetDir,
  encodePathForClaude,
} from "./path.js";
import {
  findSessionById,
  readSessionContent,
  scanLocalSessions,
  LocalSession,
} from "./scanner.js";
import {
  loadState,
  updateSessionState,
  saveState,
  addDirMapping,
  removeDirMapping,
  getDirMapping,
  getAllDirMappings,
  parseRemoteDir,
  saveAuth,
  getAuth,
  clearAuth,
  isLoggedIn,
  AuthState,
  getBackupConfig,
  saveBackupConfig,
  updateLastBackup,
  updateSessionSnapshots,
  BackupConfig,
} from "./state.js";


const program = new Command();

/**
 * Run tasks in parallel with concurrency limit
 */
async function parallelLimit<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = [];
  const executing: Promise<void>[] = [];

  for (const item of items) {
    const p = fn(item).then((result) => {
      results.push(result);
    });
    executing.push(p);

    if (executing.length >= concurrency) {
      await Promise.race(executing);
      // Remove completed promises
      for (let i = executing.length - 1; i >= 0; i--) {
        const promise = executing[i];
        const resolved = await Promise.race([
          promise.then(() => true),
          Promise.resolve(false),
        ]);
        if (resolved) {
          executing.splice(i, 1);
        }
      }
    }
  }

  await Promise.all(executing);
  return results;
}

program
  .name("claude-roam")
  .description("Claude Code session roaming sync CLI")
  .version("0.1.0");

// Push command
program
  .command("push")
  .description("Push session(s) to server")
  .option("-s, --session <id>", "Push specific session")
  .option("--all", "Push all local sessions (default: only current directory)")
  .option("--force", "Force push all content, ignoring remote state")
  .option("-c, --concurrency <n>", "Max concurrent uploads", "20")
  .option("--no-repair", "Skip broken link check")
  .action(async (options) => {
    const state = loadState();
    const concurrency = parseInt(options.concurrency) || 20;

    if (!process.env.ROAM_API) {
      console.error("Error: ROAM_API environment variable not set");
      process.exit(1);
    }

    // Check login status
    if (!isLoggedIn()) {
      console.error("Error: Not logged in. Please run 'claude-roam login' first.");
      process.exit(1);
    }

    // Check health
    const healthy = await healthCheck();
    if (!healthy) {
      console.error("Error: Cannot connect to server");
      process.exit(1);
    }

    const allSessions = scanLocalSessions();
    const currentDir = process.cwd();
    const currentDirEncoded = encodePathForClaude(currentDir);

    // Filter sessions based on options
    let sessions = allSessions;
    if (options.session) {
      // Push specific session
      const session = allSessions.find((s) => s.sessionId === options.session);
      if (!session) {
        console.error(`Session not found: ${options.session}`);
        process.exit(1);
      }
      sessions = [session];
    } else if (!options.all) {
      // Default: only push sessions from current directory
      // Use encoded path for matching to handle paths with hyphens correctly
      sessions = allSessions.filter((s) => s.encodedDir === currentDirEncoded);
      if (sessions.length === 0) {
        console.log(`No sessions found in current directory: ${currentDir}`);
        console.log("Use --all to push all local sessions");
        return;
      }
    }

    // Check for broken links before push
    if (options.repair !== false) {
      await checkAndPromptRepair(sessions);
    }

    // For --all mode without --force, check which sessions exist remotely to avoid re-uploading deleted ones
    let remoteSessionIds: Set<string> | null = null;
    if (options.all && !options.force) {
      console.log("Checking remote sessions...");
      remoteSessionIds = await getRemoteSessionIds();
      console.log(`Found ${remoteSessionIds.size} session(s) on server`);
    }

    // Prepare sessions to push
    interface PushTask {
      session: LocalSession;
      fromLine: number;
      appendData: string;
      originalPath: string;
    }

    const tasks: PushTask[] = [];
    let skippedDeleted = 0;
    for (const session of sessions) {
      // In --all mode without --force, skip sessions that don't exist on server (deleted remotely)
      if (remoteSessionIds !== null && !remoteSessionIds.has(session.sessionId)) {
        // Check if this session was ever pushed (exists in local state)
        if (state.sessions[session.sessionId]) {
          skippedDeleted++;
          continue;
        }
        // New session that was never pushed - allow it
      }

      const lastLine = state.sessions[session.sessionId]?.lastLine || 0;

      // 如果没有变化且不是 force 模式，跳过
      if (session.lineCount <= lastLine && !options.force) {
        continue;
      }

      const content = readSessionContent(session.filePath);
      const lines = content.trim().split("\n");

      // force 模式下从头开始 push，否则只 push 增量
      const fromLine = options.force ? 0 : lastLine;
      const appendData = lines.slice(fromLine).join("\n");

      if (!appendData.trim()) continue;

      // 确定 originalPath：
      // 1. 如果 session 所在目录有映射 -> 使用映射的云端目录 path
      // 2. 否则使用本地目录
      let originalPath: string;
      const sessionLocalDir = session.encodedDir === currentDirEncoded ? currentDir : session.directory;
      const mapping = getDirMapping(sessionLocalDir);
      if (mapping) {
        const parsed = parseRemoteDir(mapping);
        originalPath = parsed ? parsed.path : sessionLocalDir;
      } else {
        originalPath = sessionLocalDir;
      }

      tasks.push({ session, fromLine, appendData, originalPath });
    }

    if (skippedDeleted > 0) {
      console.log(`Skipped ${skippedDeleted} session(s) deleted on server (use --force to re-upload)`);
    }

    if (tasks.length === 0) {
      console.log("All sessions are up to date");
      return;
    }

    console.log(`Pushing ${tasks.length} session(s) with concurrency ${concurrency}...`);

    let pushed = 0;
    let failed = 0;

    await parallelLimit(tasks, concurrency, async (task) => {
      try {
        await pushSessionApi(task.session.sessionId, {
          from_line: task.fromLine + 1,
          append_data: task.appendData,
          source: {
            machine_id: state.machine_id,
            machine_name: state.machine_name,
            platform: detectPlatform(),
            original_path: task.originalPath,
          },
        });

        updateSessionState(
          task.session.sessionId,
          task.session.lineCount,
          task.session.filePath
        );
        console.log(
          `✓ ${task.session.sessionId}: ${task.session.lineCount - task.fromLine} lines`
        );
        pushed++;
      } catch (err) {
        console.error(`✗ ${task.session.sessionId}: ${err}`);
        failed++;
      }
    });

    console.log(`\nPushed ${pushed} session(s)${failed > 0 ? `, ${failed} failed` : ""}`);
  });

// Pull command - based on directory mapping
program
  .command("pull")
  .description("Pull session(s) from server based on directory mapping")
  .option("--all", "Pull from all mapped directories")
  .option("-c, --concurrency <n>", "Max concurrent downloads", "20")
  .option("-y, --yes", "Skip confirmation for conflicts")
  .action(async (options) => {
    if (!process.env.ROAM_API) {
      console.error("Error: ROAM_API environment variable not set");
      process.exit(1);
    }

    // Check login status
    if (!isLoggedIn()) {
      console.error("Error: Not logged in. Please run 'claude-roam login' first.");
      process.exit(1);
    }

    const state = loadState();
    const concurrency = parseInt(options.concurrency) || 20;
    const skipConfirm = options.yes || false;

    // Check health
    const healthy = await healthCheck();
    if (!healthy) {
      console.error("Error: Cannot connect to server");
      process.exit(1);
    }

    // Collect mappings to process
    interface MappingInfo {
      localDir: string;
      machine: string;
      remotePath: string;
    }
    const mappingsToProcess: MappingInfo[] = [];

    if (options.all) {
      // Process all mappings
      const allMappings = getAllDirMappings();
      for (const [localDir, remoteDir] of Object.entries(allMappings)) {
        const parsed = parseRemoteDir(remoteDir);
        if (parsed) {
          mappingsToProcess.push({
            localDir,
            machine: parsed.machine,
            remotePath: parsed.path,
          });
        }
      }

      if (mappingsToProcess.length === 0) {
        console.log("No directory mappings configured.");
        console.log("\nUse 'claude-roam map add <remote-dir>' to add a mapping first.");
        return;
      }
    } else {
      // Process current directory mapping only
      const currentDir = process.cwd();
      const mapping = getDirMapping(currentDir);

      if (!mapping) {
        // No mapping found - check if this is the same machine
        // If so, we can pull directly without needing a mapping
        console.log("No mapping found for current directory.");
        console.log("Checking if sessions exist from this machine...\n");

        // Try to pull sessions from the same machine with the same path
        const localMachineName = state.machine_name;
        try {
          const remoteSessions = await listSessionsByDir(localMachineName, currentDir);
          if (remoteSessions.length > 0) {
            console.log(`Found ${remoteSessions.length} session(s) from this machine (${localMachineName}).`);
            console.log("Since this is the same machine, no mapping needed.\n");
            mappingsToProcess.push({
              localDir: currentDir,
              machine: localMachineName,
              remotePath: currentDir,
            });
          } else {
            // No sessions from this machine either
            console.log("No sessions found from this machine for this directory.");
            console.log("\nTo pull sessions from a different machine, establish a directory mapping:");
            console.log("  claude-roam map add \"machine_name:/original/path\"");
            console.log("\nExample:");
            console.log("  claude-roam map add \"alice-mac:/Users/alice/projects/foo\"");
            console.log("\nThis maps your current directory to a cloud directory,");
            console.log("allowing you to pull sessions across machines.");
            return;
          }
        } catch (err) {
          // API error - fall back to the original message
          console.log("Failed to check remote sessions:", err);
          console.log("\nTo pull sessions, you need to establish a directory mapping first:");
          console.log("  claude-roam map add \"machine_name:/original/path\"");
          console.log("\nExample:");
          console.log("  claude-roam map add \"alice-mac:/Users/alice/projects/foo\"");
          console.log("\nThis maps your current directory to a cloud directory,");
          console.log("allowing you to pull and push sessions across machines.");
          return;
        }
      } else {
        const parsed = parseRemoteDir(mapping);
        if (!parsed) {
          console.error("Invalid mapping format. Please remove and re-add the mapping.");
          process.exit(1);
        }

        mappingsToProcess.push({
          localDir: currentDir,
          machine: parsed.machine,
          remotePath: parsed.path,
        });
      }
    }

    // Fetch sessions for each mapping
    interface PullTask {
      sessionId: string;
      targetDir: string;
    }
    const tasks: PullTask[] = [];
    const localSessionsMap = new Map(scanLocalSessions().map(s => [s.sessionId, s]));

    console.log(`Processing ${mappingsToProcess.length} mapping(s)...`);

    for (const mapping of mappingsToProcess) {
      try {
        const remoteSessions = await listSessionsByDir(mapping.machine, mapping.remotePath);
        console.log(`  ${mapping.machine}:${mapping.remotePath} -> ${remoteSessions.length} session(s)`);

        for (const session of remoteSessions) {
          tasks.push({
            sessionId: session.session_id,
            targetDir: mapping.localDir,
          });
        }
      } catch (err) {
        console.error(`  Failed to fetch sessions for ${mapping.machine}:${mapping.remotePath}: ${err}`);
      }
    }

    if (tasks.length === 0) {
      console.log("\nNo sessions to pull.");
      return;
    }

    // Check for conflicts
    const conflicts: { sessionId: string; localLines: number }[] = [];
    for (const task of tasks) {
      const local = localSessionsMap.get(task.sessionId);
      if (local && local.lineCount > 0) {
        conflicts.push({ sessionId: task.sessionId, localLines: local.lineCount });
      }
    }

    // Handle conflicts
    if (conflicts.length > 0 && !skipConfirm) {
      console.log(`\n⚠️  Found ${conflicts.length} conflict(s) - local files will be overwritten:\n`);
      for (const c of conflicts.slice(0, 10)) {
        console.log(`  ${c.sessionId} (${c.localLines} lines locally)`);
      }
      if (conflicts.length > 10) {
        console.log(`  ... and ${conflicts.length - 10} more`);
      }

      process.stdout.write("\nContinue and overwrite? [y/N] ");

      const answer = await new Promise<string>((resolve) => {
        let input = "";
        process.stdin.setRawMode?.(true);
        process.stdin.resume();
        process.stdin.setEncoding("utf8");

        const onData = (key: string) => {
          if (key === "\r" || key === "\n") {
            process.stdin.setRawMode?.(false);
            process.stdin.pause();
            process.stdin.removeListener("data", onData);
            console.log();
            resolve(input.trim().toLowerCase());
          } else if (key === "\u0003") {
            process.stdin.setRawMode?.(false);
            process.exit(0);
          } else if (key === "\u007F") {
            input = input.slice(0, -1);
          } else {
            input += key;
            process.stdout.write(key);
          }
        };

        process.stdin.on("data", onData);
      });

      if (answer !== "y" && answer !== "yes") {
        console.log("Aborted.");
        return;
      }
    }

    console.log(`\nPulling ${tasks.length} session(s) with concurrency ${concurrency}...`);

    let pulled = 0;
    let failed = 0;

    await parallelLimit(tasks, concurrency, async (task) => {
      try {
        const response = await pullSessionApi(task.sessionId);

        // Ensure target directory exists
        const sessionDir = getSessionTargetDir(task.targetDir);
        if (!fs.existsSync(sessionDir)) {
          fs.mkdirSync(sessionDir, { recursive: true });
        }

        // Write session file
        const filePath = getSessionFilePath(task.sessionId, task.targetDir);
        fs.writeFileSync(filePath, response.data);

        updateSessionState(task.sessionId, response.meta.total_lines, filePath);

        console.log(`✓ ${task.sessionId}: ${response.meta.total_lines} lines`);
        pulled++;
      } catch (err) {
        console.error(`✗ ${task.sessionId}: ${err}`);
        failed++;
      }
    });

    console.log(`\nPulled ${pulled} session(s)${failed > 0 ? `, ${failed} failed` : ""}`);
    if (pulled > 0) {
      console.log(`\nTo resume a session:\n  claude --resume <session-id>`);
    }
  });

// List command
program
  .command("list")
  .description("List sessions")
  .option("-q, --query <query>", "Search query")
  .option("-l, --local", "List local sessions only")
  .option("-g, --grouped", "Show remote sessions grouped by machine and path")
  .option("--json", "Output as JSON")
  .option("-n, --limit <n>", "Limit results (default: 10)", "10")
  .option("-p, --page <n>", "Page number (default: 1)", "1")
  .option("-a, --all", "Show all results (no pagination)")
  .action(async (options) => {
    const limit = options.all ? 1000 : parseInt(options.limit);
    const page = parseInt(options.page);
    const offset = (page - 1) * limit;

    if (options.local) {
      // List local sessions
      const allSessions = scanLocalSessions();
      const sessions = options.all
        ? allSessions
        : allSessions.slice(offset, offset + limit);

      if (options.json) {
        console.log(JSON.stringify(sessions, null, 2));
        return;
      }

      const total = allSessions.length;
      const showing = sessions.length;
      const totalPages = Math.ceil(total / limit);

      console.log(`Local sessions: ${total} total`);
      if (!options.all && total > limit) {
        console.log(`Showing page ${page}/${totalPages} (${showing} items)\n`);
      } else {
        console.log();
      }

      for (const session of sessions) {
        console.log(`${session.sessionId}`);
        console.log(`  Lines: ${session.lineCount} | Dir: ${session.directory}`);
        console.log(`  Modified: ${session.modifiedAt.toISOString()}`);
        console.log();
      }

      if (!options.all && page < totalPages) {
        console.log(`Use --page ${page + 1} for next page, or --all to show all`);
      }
    } else if (options.grouped) {
      // List remote sessions grouped by machine and path
      if (!process.env.ROAM_API) {
        console.error("Error: ROAM_API environment variable not set");
        process.exit(1);
      }

      // Check login status
      if (!isLoggedIn()) {
        console.error("Error: Not logged in. Please run 'claude-roam login' first.");
        process.exit(1);
      }

      const sessions = await listSessionsGrouped();

      if (options.json) {
        console.log(JSON.stringify(sessions, null, 2));
        return;
      }

      // Group sessions by machine_name, then by original_path
      const grouped = new Map<string, Map<string, typeof sessions>>();

      for (const session of sessions) {
        const machine = session.machine_name || "(unknown)";
        const pathKey = session.original_path || "(unknown)";

        if (!grouped.has(machine)) {
          grouped.set(machine, new Map());
        }
        const machineGroup = grouped.get(machine)!;

        if (!machineGroup.has(pathKey)) {
          machineGroup.set(pathKey, []);
        }
        machineGroup.get(pathKey)!.push(session);
      }

      console.log(`Remote sessions grouped by cloud directory:\n`);

      for (const [machine, paths] of grouped) {
        console.log(`Machine: ${machine}`);

        for (const [pathKey, pathSessions] of paths) {
          console.log(`  └── ${pathKey} (${pathSessions.length} sessions)`);
          console.log(`      To map: claude-roam map add "${machine}:${pathKey}"`);

          // Show first few sessions
          for (const session of pathSessions.slice(0, 3)) {
            const msg = session.first_message
              ? session.first_message.length > 40
                ? session.first_message.slice(0, 40) + "..."
                : session.first_message
              : "(no message)";
            console.log(`        - ${session.session_id.slice(0, 8)}... "${msg}"`);
          }
          if (pathSessions.length > 3) {
            console.log(`        ... and ${pathSessions.length - 3} more`);
          }
        }
        console.log();
      }

      console.log(`Total: ${sessions.length} sessions`);
    } else {
      // List remote sessions (flat)
      if (!process.env.ROAM_API) {
        console.error("Error: ROAM_API environment variable not set");
        process.exit(1);
      }

      // Check login status
      if (!isLoggedIn()) {
        console.error("Error: Not logged in. Please run 'claude-roam login' first.");
        process.exit(1);
      }

      const response = await listSessions(options.query, limit, offset);
      const sessions = response.sessions;

      if (options.json) {
        console.log(JSON.stringify(sessions, null, 2));
        return;
      }

      const showing = sessions.length;
      const hasMore = showing === limit;

      if (options.query) {
        console.log(`Search results for "${options.query}":`);
      } else {
        console.log(`Remote sessions:`);
      }
      console.log(`Showing ${showing} items (page ${page})${hasMore ? " - more available" : ""}\n`);

      for (const session of sessions) {
        console.log(`${session.session_id}`);
        if (session.first_message) {
          const msg =
            session.first_message.length > 60
              ? session.first_message.slice(0, 60) + "..."
              : session.first_message;
          console.log(`  "${msg}"`);
        }
        console.log(
          `  Lines: ${session.total_lines} | Machines: ${session.machines || "N/A"}`
        );
        console.log(`  Updated: ${session.updated_at}`);
        console.log();
      }

      if (hasMore) {
        console.log(`Use --page ${page + 1} for next page, or --all to show all`);
      }
    }
  });

// Daemon command
program
  .command("daemon")
  .description("Run background sync daemon")
  .option("--detach", "Run in background (not yet implemented)")
  .action(async (options) => {
    if (!process.env.ROAM_API) {
      console.error("Error: ROAM_API environment variable not set");
      process.exit(1);
    }

    // Check login status
    if (!isLoggedIn()) {
      console.error("Error: Not logged in. Please run 'claude-roam login' first.");
      process.exit(1);
    }

    // Check health
    const healthy = await healthCheck();
    if (!healthy) {
      console.error("Error: Cannot connect to server");
      process.exit(1);
    }

    if (options.detach) {
      console.log("Background mode not yet implemented. Running in foreground.");
    }

    await startDaemon();
  });

// Status command
program
  .command("status")
  .description("Show sync status")
  .action(async () => {
    const state = loadState();
    const localSessions = scanLocalSessions();

    console.log("Claude Roam Status\n");
    console.log(`Machine ID: ${state.machine_id}`);
    console.log(`Machine Name: ${state.machine_name}`);
    console.log(`Platform: ${detectPlatform()}`);
    console.log(`API: ${process.env.ROAM_API || "Not configured"}`);
    console.log();

    if (process.env.ROAM_API) {
      const healthy = await healthCheck();
      console.log(`Server: ${healthy ? "Connected" : "Unreachable"}`);
    }

    console.log(`\nLocal Sessions: ${localSessions.length}`);
    console.log(`Tracked Sessions: ${Object.keys(state.sessions).length}`);

    // Show sessions needing sync
    const needSync = localSessions.filter((s) => {
      const tracked = state.sessions[s.sessionId];
      return !tracked || s.lineCount > tracked.lastLine;
    });

    if (needSync.length > 0) {
      console.log(`\nSessions needing sync: ${needSync.length}`);
      for (const s of needSync.slice(0, 5)) {
        const tracked = state.sessions[s.sessionId]?.lastLine || 0;
        console.log(
          `  ${s.sessionId}: ${s.lineCount - tracked} new lines`
        );
      }
      if (needSync.length > 5) {
        console.log(`  ... and ${needSync.length - 5} more`);
      }
    }
  });

// Clean command - delete local sessions
program
  .command("clean [session-id]")
  .description("Delete local session(s)")
  .option("--all", "Delete all local sessions")
  .option("-y, --yes", "Skip confirmation")
  .action(async (sessionId: string | undefined, options) => {
    const currentDir = process.cwd();
    const currentDirEncoded = encodePathForClaude(currentDir);
    const allLocalSessions = scanLocalSessions();

    // Determine which sessions to delete
    let sessionsToDelete: LocalSession[] = [];

    if (sessionId) {
      // Delete specific session
      const session = allLocalSessions.find(s => s.sessionId === sessionId);
      if (!session) {
        console.error(`Session not found: ${sessionId}`);
        process.exit(1);
      }
      sessionsToDelete = [session];
    } else if (options.all) {
      // Delete all local sessions
      sessionsToDelete = allLocalSessions;
    } else {
      // Delete sessions in current directory
      sessionsToDelete = allLocalSessions.filter(s => s.encodedDir === currentDirEncoded);
      if (sessionsToDelete.length === 0) {
        console.log(`No sessions found for current directory: ${currentDir}`);
        console.log("Use --all to delete all local sessions, or specify a session ID");
        return;
      }
    }

    if (sessionsToDelete.length === 0) {
      console.log("No sessions to delete");
      return;
    }

    // Show what will be deleted
    const totalLines = sessionsToDelete.reduce((sum, s) => sum + s.lineCount, 0);
    console.log(`\n⚠️  Will delete ${sessionsToDelete.length} session(s) (${totalLines} total lines):\n`);

    for (const s of sessionsToDelete.slice(0, 10)) {
      console.log(`  ${s.sessionId} (${s.lineCount} lines) - ${s.directory}`);
    }
    if (sessionsToDelete.length > 10) {
      console.log(`  ... and ${sessionsToDelete.length - 10} more`);
    }

    // Confirm deletion
    if (!options.yes) {
      process.stdout.write("\nConfirm deletion? [y/N] ");

      const answer = await new Promise<string>((resolve) => {
        let input = "";
        process.stdin.setRawMode?.(true);
        process.stdin.resume();
        process.stdin.setEncoding("utf8");

        const onData = (key: string) => {
          if (key === "\r" || key === "\n") {
            process.stdin.setRawMode?.(false);
            process.stdin.pause();
            process.stdin.removeListener("data", onData);
            console.log();
            resolve(input.trim().toLowerCase());
          } else if (key === "\u0003") {
            // Ctrl+C
            process.stdin.setRawMode?.(false);
            process.exit(0);
          } else if (key === "\u007F") {
            // Backspace
            input = input.slice(0, -1);
          } else {
            input += key;
            process.stdout.write(key);
          }
        };

        process.stdin.on("data", onData);
      });

      if (answer !== "y" && answer !== "yes") {
        console.log("Aborted.");
        return;
      }
    }

    // Delete sessions
    let deleted = 0;
    let failed = 0;
    const state = loadState();

    for (const session of sessionsToDelete) {
      try {
        fs.unlinkSync(session.filePath);
        // Also remove from state
        delete state.sessions[session.sessionId];
        console.log(`✓ Deleted ${session.sessionId}`);
        deleted++;
      } catch (err) {
        console.error(`✗ Failed to delete ${session.sessionId}: ${err}`);
        failed++;
      }
    }

    // Save updated state
    if (deleted > 0) {
      saveState(state);
    }

    console.log(`\nDeleted ${deleted} session(s)${failed > 0 ? `, ${failed} failed` : ""}`);
  });

// Map command - directory mapping management
const mapCommand = program
  .command("map")
  .description("Manage directory mappings (local dir <-> cloud dir)");

mapCommand
  .command("list")
  .description("List all directory mappings")
  .action(() => {
    const mappings = getAllDirMappings();
    const entries = Object.entries(mappings);

    if (entries.length === 0) {
      console.log("No directory mappings configured.");
      console.log("\nUse 'claude-roam map add <remote-dir>' to add a mapping.");
      console.log("Example: claude-roam map add \"alice-mac:/Users/alice/projects/foo\"");
      return;
    }

    console.log("Directory Mappings:\n");
    for (const [localDir, remoteDir] of entries) {
      console.log(`Local:  ${localDir}`);
      console.log(`Cloud:  ${remoteDir}`);
      console.log();
    }
  });

mapCommand
  .command("add <remote-dir>")
  .description("Map current directory to a cloud directory (format: machine:path)")
  .action((remoteDir: string) => {
    const parsed = parseRemoteDir(remoteDir);
    if (!parsed) {
      console.error("Invalid remote directory format. Expected: machine_name:path");
      console.error("Example: alice-mac:/Users/alice/projects/foo");
      process.exit(1);
    }

    const currentDir = process.cwd();
    const existing = getDirMapping(currentDir);

    if (existing) {
      console.log(`Current directory already mapped to: ${existing}`);
      console.log("Remove the existing mapping first with 'claude-roam map remove'");
      process.exit(1);
    }

    addDirMapping(currentDir, remoteDir);
    console.log("Mapping added:");
    console.log(`  Local:  ${currentDir}`);
    console.log(`  Cloud:  ${remoteDir}`);
    console.log("\nYou can now use 'claude-roam pull' to pull sessions from this cloud directory.");
  });

mapCommand
  .command("remove")
  .description("Remove mapping for current directory")
  .action(() => {
    const currentDir = process.cwd();
    const existing = getDirMapping(currentDir);

    if (!existing) {
      console.log("No mapping found for current directory.");
      return;
    }

    removeDirMapping(currentDir);
    console.log("Mapping removed:");
    console.log(`  Local:  ${currentDir}`);
    console.log(`  Cloud:  ${existing}`);
  });

mapCommand
  .command("show")
  .description("Show mapping for current directory")
  .action(() => {
    const currentDir = process.cwd();
    const mapping = getDirMapping(currentDir);

    if (!mapping) {
      console.log("No mapping found for current directory.");
      console.log("\nUse 'claude-roam map add <remote-dir>' to add a mapping.");
      return;
    }

    console.log("Current directory mapping:");
    console.log(`  Local:  ${currentDir}`);
    console.log(`  Cloud:  ${mapping}`);
  });

// Login command
program
  .command("login")
  .description("Login with GitHub")
  .action(async () => {
    if (!process.env.ROAM_API) {
      console.error("Error: ROAM_API environment variable not set");
      process.exit(1);
    }

    // Check if already logged in
    const auth = getAuth();
    if (auth) {
      console.log(`Already logged in as ${auth.user.name || auth.user.email || auth.user.id}`);
      console.log("Use 'claude-roam logout' to logout first.");
      return;
    }

    // Check server health
    const healthy = await healthCheck();
    if (!healthy) {
      console.error("Error: Cannot connect to server");
      process.exit(1);
    }

    console.log("Logging in with GitHub...\n");

    try {
      // Request device code
      const deviceCode = await requestDeviceCode();

      console.log("Please visit the following URL in your browser:");
      console.log(`\n  ${deviceCode.verification_uri}\n`);
      console.log(`And enter the code: ${deviceCode.user_code}\n`);

      // Also try to open browser automatically
      const openCmd = process.platform === "darwin" ? "open" :
                      process.platform === "win32" ? "start" : "xdg-open";
      try {
        Bun.spawn([openCmd, deviceCode.verification_uri]);
      } catch {
        // Ignore if browser can't be opened
      }

      // Poll for token
      const interval = deviceCode.interval || 5;
      const expiresAt = Date.now() + deviceCode.expires_in * 1000;

      process.stdout.write("Waiting for authorization");

      while (Date.now() < expiresAt) {
        await Bun.sleep(interval * 1000);
        process.stdout.write(".");

        const result = await pollDeviceToken(deviceCode.device_code);

        if (result.status === "completed" && result.access_token && result.user) {
          console.log(" ✓\n");

          // Save auth state
          const authState: AuthState = {
            token: result.access_token,
            user: {
              id: result.user.id,
              provider: result.user.provider,
              name: result.user.name,
              email: result.user.email,
              avatar_url: result.user.avatar_url,
            },
          };
          saveAuth(authState);

          console.log(`Logged in as: ${result.user.name || result.user.email || result.user.id} (GitHub)`);
          console.log("Token saved to ~/.claude-roam/state.json");
          return;
        } else if (result.status === "expired") {
          console.log(" ✗\n");
          console.error("Error: Authorization expired. Please try again.");
          process.exit(1);
        }
        // status === "pending" -> continue polling
      }

      console.log(" ✗\n");
      console.error("Error: Authorization timed out. Please try again.");
      process.exit(1);
    } catch (err) {
      console.error(`\nError: ${err}`);
      process.exit(1);
    }
  });

// Logout command
program
  .command("logout")
  .description("Logout and clear stored credentials")
  .action(() => {
    const auth = getAuth();

    if (!auth) {
      console.log("Not logged in.");
      return;
    }

    clearAuth();
    console.log(`Logged out from ${auth.user.name || auth.user.email || auth.user.id}`);
  });

// Whoami command
program
  .command("whoami")
  .description("Show current logged in user")
  .action(async () => {
    const auth = getAuth();

    if (!auth) {
      console.log("Not logged in.");
      console.log("\nUse 'claude-roam login' to login with GitHub.");
      return;
    }

    console.log("Current user:");
    console.log(`  Name:     ${auth.user.name || "(not set)"}`);
    console.log(`  Email:    ${auth.user.email || "(not set)"}`);
    console.log(`  Provider: ${auth.user.provider}`);
    console.log(`  ID:       ${auth.user.id}`);

    // Optionally verify token with server
    if (process.env.ROAM_API) {
      const user = await getCurrentUser(auth.token);
      if (!user) {
        console.log("\n⚠️  Token may be expired. Use 'claude-roam login' to re-authenticate.");
      }
    }
  });

// Export command - export current directory's all sessions to a .roam file
program
  .command("export")
  .description("Export current directory's all sessions to a .roam file")
  .option("-o, --output <file>", "Output file path")
  .option("--no-repair", "Skip broken link check")
  .action(async (options) => {
    const currentDir = process.cwd();
    const encodedDir = encodePathForClaude(currentDir);
    const sessions = scanLocalSessions();

    // Find sessions for current directory
    const dirSessions = sessions.filter((s) => s.encodedDir === encodedDir);

    if (dirSessions.length === 0) {
      console.error("No sessions found for current directory.");
      console.log(`\nCurrent directory: ${currentDir}`);
      console.log("Make sure you have Claude Code sessions in this directory.");
      process.exit(1);
    }

    // Check for broken links
    if (options.repair !== false) {
      await checkAndPromptRepair(dirSessions);
    }

    const state = loadState();

    // Read all session contents
    const sessionsData = dirSessions.map((session) => ({
      id: session.sessionId,
      lineCount: session.lineCount,
      modifiedAt: session.modifiedAt.toISOString(),
      data: readSessionContent(session.filePath),
    }));

    // Create export bundle with all sessions
    const bundle = {
      version: 2,  // New version for multi-session format
      exportedAt: new Date().toISOString(),
      source: {
        machineId: state.machine_id,
        machineName: state.machine_name,
        originalPath: currentDir,
      },
      sessions: sessionsData,
    };

    // Determine output file - include machine name, directory and timestamp
    const dirName = path.basename(currentDir);
    const machineShort = state.machine_name.replace(/[^a-zA-Z0-9-]/g, '').slice(0, 20);
    const now = new Date();
    const timestamp = `${now.toISOString().slice(0, 10).replace(/-/g, '')}_${now.toTimeString().slice(0, 8).replace(/:/g, '')}`;  // YYYYMMDD_HHMMSS
    const defaultFileName = `${machineShort}_${dirName}_${timestamp}.roam`;
    const outputFile = options.output || defaultFileName;
    const outputPath = path.isAbsolute(outputFile) ? outputFile : path.join(currentDir, outputFile);

    // Write bundle as JSON
    fs.writeFileSync(outputPath, JSON.stringify(bundle, null, 2));

    console.log(`✓ Exported ${sessionsData.length} session(s) to: ${outputPath}`);
    console.log(`  Source: ${state.machine_name}:${currentDir}`);
    sessionsData.forEach((s) => {
      console.log(`  - ${s.id} (${s.lineCount} lines)`);
    });
    console.log(`\nTo import on another machine:`);
    console.log(`  cd /path/to/target/directory`);
    console.log(`  claude-roam import ${path.basename(outputPath)}`);
  });

// Import command - import a .roam file and establish mapping
program
  .command("import <file>")
  .description("Import a .roam file and establish directory mapping")
  .option("--no-mapping", "Don't create directory mapping")
  .action(async (file, options) => {
    const currentDir = process.cwd();

    // Read the bundle file
    const filePath = path.isAbsolute(file) ? file : path.join(currentDir, file);

    if (!fs.existsSync(filePath)) {
      console.error(`File not found: ${filePath}`);
      process.exit(1);
    }

    let bundle;
    try {
      const content = fs.readFileSync(filePath, "utf-8");
      bundle = JSON.parse(content);
    } catch (err) {
      console.error("Failed to parse .roam file:", err);
      process.exit(1);
    }

    // Validate bundle - support both v1 (single session) and v2 (multi session)
    if (!bundle.version || !bundle.source) {
      console.error("Invalid .roam file format");
      process.exit(1);
    }

    console.log(`Importing from: ${bundle.source.machineName}:${bundle.source.originalPath}`);

    // Determine target directory in ~/.claude/projects/
    const targetDir = getSessionTargetDir(currentDir);

    // Ensure target directory exists
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }

    // Handle both v1 (single session) and v2 (multi session) formats
    let sessionsToImport: Array<{ id: string; lineCount: number; data: string }> = [];

    if (bundle.version === 1 && bundle.session && bundle.data) {
      // v1 format: single session
      sessionsToImport = [{
        id: bundle.session.id,
        lineCount: bundle.session.lineCount,
        data: bundle.data,
      }];
    } else if (bundle.version === 2 && bundle.sessions) {
      // v2 format: multiple sessions
      sessionsToImport = bundle.sessions;
    } else {
      console.error("Invalid .roam file format: unknown version or missing data");
      process.exit(1);
    }

    console.log(`  ${sessionsToImport.length} session(s) to import`);

    // Write session files
    let imported = 0;
    let skipped = 0;
    for (const session of sessionsToImport) {
      const targetFile = path.join(targetDir, `${session.id}.jsonl`);

      if (fs.existsSync(targetFile)) {
        console.log(`  ⚠️  Skipping ${session.id} (already exists)`);
        skipped++;
      } else {
        fs.writeFileSync(targetFile, session.data);
        console.log(`  ✓ ${session.id} (${session.lineCount} lines)`);
        imported++;
      }
    }

    // Create directory mapping if requested
    if (options.mapping !== false) {
      const remoteDir = `${bundle.source.machineName}:${bundle.source.originalPath}`;
      const existingMapping = getDirMapping(currentDir);

      if (existingMapping) {
        if (existingMapping === remoteDir) {
          console.log(`✓ Directory mapping already exists: ${remoteDir}`);
        } else {
          console.log(`\n⚠️  Directory already mapped to: ${existingMapping}`);
          console.log(`Cannot add new mapping to: ${remoteDir}`);
          console.log("Remove existing mapping first with 'claude-roam map remove'");
        }
      } else {
        addDirMapping(currentDir, remoteDir);
        console.log(`✓ Directory mapping created: ${currentDir} -> ${remoteDir}`);
      }
    }

    console.log(`\n✓ Import complete! (${imported} imported, ${skipped} skipped)`);
    console.log(`You can now use 'claude-roam push' and 'claude-roam pull' to sync.`);
  });

/**
 * Try to find and launch the Tauri desktop app
 * Returns true if app was launched, false if not found
 */
async function tryLaunchTauriApp(): Promise<boolean> {
  const platform = process.platform;
  const { exec, execSync } = await import("child_process");

  // Platform-specific app paths
  const appPaths: string[] = [];

  if (platform === "darwin") {
    // macOS: Check common installation locations
    appPaths.push(
      "/Applications/Claude Roam.app",
      path.join(os.homedir(), "Applications/Claude Roam.app"),
      // Development build location
      path.join(__dirname, "../../src-tauri/target/release/bundle/macos/Claude Roam.app"),
    );
  } else if (platform === "win32") {
    // Windows: Check Program Files and AppData
    const programFiles = process.env.PROGRAMFILES || "C:\\Program Files";
    const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData\\Local");
    appPaths.push(
      path.join(programFiles, "Claude Roam\\Claude Roam.exe"),
      path.join(localAppData, "Claude Roam\\Claude Roam.exe"),
    );
  } else {
    // Linux: Check common locations
    appPaths.push(
      "/usr/bin/claude-roam",
      "/usr/local/bin/claude-roam",
      path.join(os.homedir(), ".local/bin/claude-roam"),
      path.join(os.homedir(), ".local/share/applications/claude-roam"),
    );
  }

  // Find the first existing app
  for (const appPath of appPaths) {
    if (fs.existsSync(appPath)) {
      try {
        if (platform === "darwin") {
          // macOS: Use 'open' command
          exec(`open "${appPath}"`, (err) => {
            if (err) {
              console.error("Failed to launch app:", err.message);
            }
          });
        } else if (platform === "win32") {
          // Windows: Run the executable
          exec(`"${appPath}"`, (err) => {
            if (err) {
              console.error("Failed to launch app:", err.message);
            }
          });
        } else {
          // Linux: Run the binary
          exec(`"${appPath}"`, (err) => {
            if (err) {
              console.error("Failed to launch app:", err.message);
            }
          });
        }
        return true;
      } catch {
        // Continue to next path
      }
    }
  }

  // macOS: Also try using 'open -a' which searches registered apps
  if (platform === "darwin") {
    try {
      execSync('open -a "Claude Roam"', { stdio: 'ignore' });
      return true;
    } catch {
      // App not registered, continue
    }
  }

  return false;
}

// Preview command - open sessions in Tauri app
program
  .command("preview")
  .description("Preview sessions (launches Claude Roam desktop app)")
  .action(async () => {
    const currentDir = process.cwd();

    console.log("Looking for Claude Roam desktop app...");

    const launched = await tryLaunchTauriApp();
    if (launched) {
      console.log("✓ Launched Claude Roam desktop app");
      console.log(`  The app will show sessions from: ~/.claude/projects/`);
      console.log(`\nTip: Use the project filter in the app to view sessions for:`);
      console.log(`  ${currentDir}`);
    } else {
      console.error("Claude Roam desktop app not found.");
      console.log("\nPlease install the desktop app first:");
      console.log("  1. Build: cd src-tauri && cargo tauri build");
      console.log("  2. Install the .app or .dmg from target/release/bundle/");
    }
  });

// Backup command - backup all sessions locally
const backupCommand = program
  .command("backup")
  .description("Backup Claude Code sessions locally (prevents data loss from auto-cleanup)");

backupCommand
  .command("run")
  .description("Run backup now (auto-detects full vs incremental)")
  .option("-d, --directory <path>", "Backup directory (default: ~/.claude-roam/backups)")
  .option("--full", "Force full backup")
  .option("--incremental", "Force incremental backup")
  .option("--quiet", "Suppress output (for cron jobs)")
  .action(async (options) => {
    const config = getBackupConfig();
    const backupDir = options.directory || config.directory;
    const quiet = options.quiet || false;

    // Ensure backup directory exists
    if (!fs.existsSync(backupDir)) {
      fs.mkdirSync(backupDir, { recursive: true });
    }

    const sessions = scanLocalSessions();
    if (sessions.length === 0) {
      if (!quiet) console.log("No sessions to backup.");
      return;
    }

    // Determine backup type
    let doFullBackup = false;
    if (options.full) {
      doFullBackup = true;
    } else if (options.incremental) {
      doFullBackup = false;
    } else {
      // Auto-detect: do full backup if never done or if interval exceeded
      const lastFull = config.lastFullBackup;
      if (!lastFull) {
        doFullBackup = true;
      } else {
        const daysSinceLastFull = (Date.now() - new Date(lastFull).getTime()) / (1000 * 60 * 60 * 24);
        doFullBackup = daysSinceLastFull >= config.fullIntervalDays;
      }
    }

    const state = loadState();
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const backupType = doFullBackup ? "full" : "incr";
    const backupFile = path.join(backupDir, `backup-${backupType}-${state.machine_name}-${timestamp}.json`);

    // Get previous snapshots for incremental comparison
    const prevSnapshots = config.sessionSnapshots || {};

    // Group sessions by encoded directory
    const sessionsByDir = new Map<string, LocalSession[]>();
    for (const session of sessions) {
      const dir = session.encodedDir;
      if (!sessionsByDir.has(dir)) {
        sessionsByDir.set(dir, []);
      }
      sessionsByDir.get(dir)!.push(session);
    }

    // Create backup bundle
    const bundle = {
      version: 3,
      type: doFullBackup ? "full-backup" : "incremental-backup",
      createdAt: new Date().toISOString(),
      basedOn: doFullBackup ? null : config.lastFullBackup,  // Reference to base full backup
      source: {
        machineId: state.machine_id,
        machineName: state.machine_name,
      },
      directories: [] as Array<{
        encodedDir: string;
        originalPath: string;
        sessions: Array<{
          id: string;
          lineCount: number;
          modifiedAt: string;
          data: string;
        }>;
      }>,
    };

    let totalSessions = 0;
    let totalLines = 0;
    let changedSessions = 0;
    const newSnapshots: Record<string, { lineCount: number; modifiedAt: string }> = {};

    for (const [encodedDir, dirSessions] of sessionsByDir) {
      const sessionsData: Array<{
        id: string;
        lineCount: number;
        modifiedAt: string;
        data: string;
      }> = [];

      for (const session of dirSessions) {
        const sessionKey = `${encodedDir}/${session.sessionId}`;
        const prevSnapshot = prevSnapshots[sessionKey];
        const currentModified = session.modifiedAt.toISOString();

        // Update snapshot for next time
        newSnapshots[sessionKey] = {
          lineCount: session.lineCount,
          modifiedAt: currentModified,
        };

        // For incremental: only include if changed
        if (!doFullBackup && prevSnapshot) {
          const isChanged = prevSnapshot.lineCount !== session.lineCount ||
                           prevSnapshot.modifiedAt !== currentModified;
          if (!isChanged) {
            continue;  // Skip unchanged sessions in incremental backup
          }
        }

        const data = readSessionContent(session.filePath);
        totalLines += session.lineCount;
        changedSessions++;

        sessionsData.push({
          id: session.sessionId,
          lineCount: session.lineCount,
          modifiedAt: currentModified,
          data,
        });
      }

      if (sessionsData.length > 0) {
        bundle.directories.push({
          encodedDir,
          originalPath: dirSessions[0].directory,
          sessions: sessionsData,
        });
        totalSessions += sessionsData.length;
      }
    }

    // For incremental: if nothing changed, skip creating backup file
    if (!doFullBackup && totalSessions === 0) {
      if (!quiet) console.log("No changes detected, skipping incremental backup.");
      updateLastBackup('incremental');
      return;
    }

    // Write backup file
    fs.writeFileSync(backupFile, JSON.stringify(bundle));
    updateLastBackup(doFullBackup ? 'full' : 'incremental');
    updateSessionSnapshots(newSnapshots);

    if (!quiet) {
      const typeLabel = doFullBackup ? "Full backup" : "Incremental backup";
      console.log(`✓ ${typeLabel} complete: ${backupFile}`);
      if (doFullBackup) {
        console.log(`  Sessions: ${totalSessions} | Lines: ${totalLines} | Directories: ${bundle.directories.length}`);
      } else {
        console.log(`  Changed sessions: ${changedSessions} | Lines: ${totalLines}`);
      }
    }

    // Clean up old backups based on retention policy
    const retentionDays = config.retentionDays;
    const cutoffDate = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
    let deleted = 0;

    try {
      const files = fs.readdirSync(backupDir);
      for (const file of files) {
        if (!file.startsWith("backup-") || !file.endsWith(".json")) continue;

        const filePath = path.join(backupDir, file);
        const stats = fs.statSync(filePath);

        if (stats.mtime < cutoffDate) {
          fs.unlinkSync(filePath);
          deleted++;
        }
      }
    } catch {
      // Ignore cleanup errors
    }

    if (!quiet && deleted > 0) {
      console.log(`  Cleaned up ${deleted} old backup(s) (>${retentionDays} days)`);
    }
  });

backupCommand
  .command("config")
  .description("Configure backup settings")
  .option("-e, --enable", "Enable automatic backup")
  .option("--disable", "Disable automatic backup")
  .option("-d, --directory <path>", "Set backup directory")
  .option("-r, --retention <days>", "Set retention period in days")
  .option("-i, --interval <hours>", "Set incremental backup interval in hours")
  .option("-f, --full-interval <days>", "Set full backup interval in days")
  .action((options) => {
    const config = getBackupConfig();

    if (options.enable) {
      saveBackupConfig({ enabled: true });
      console.log("✓ Automatic backup enabled");
    }
    if (options.disable) {
      saveBackupConfig({ enabled: false });
      console.log("✓ Automatic backup disabled");
    }
    if (options.directory) {
      const dir = path.isAbsolute(options.directory)
        ? options.directory
        : path.resolve(options.directory);
      saveBackupConfig({ directory: dir });
      console.log(`✓ Backup directory set to: ${dir}`);
    }
    if (options.retention) {
      const days = parseInt(options.retention);
      if (isNaN(days) || days < 1) {
        console.error("Error: Retention must be a positive number of days");
        process.exit(1);
      }
      saveBackupConfig({ retentionDays: days });
      console.log(`✓ Retention period set to ${days} days`);
    }
    if (options.interval) {
      const hours = parseInt(options.interval);
      if (isNaN(hours) || hours < 1) {
        console.error("Error: Interval must be a positive number of hours");
        process.exit(1);
      }
      saveBackupConfig({ intervalHours: hours });
      console.log(`✓ Incremental backup interval set to ${hours} hours`);
    }
    if (options.fullInterval) {
      const days = parseInt(options.fullInterval);
      if (isNaN(days) || days < 1) {
        console.error("Error: Full interval must be a positive number of days");
        process.exit(1);
      }
      saveBackupConfig({ fullIntervalDays: days });
      console.log(`✓ Full backup interval set to ${days} days`);
    }

    // If no options specified, show current config
    if (!options.enable && !options.disable && !options.directory && !options.retention && !options.interval && !options.fullInterval) {
      const currentConfig = getBackupConfig();
      console.log("Backup Configuration:\n");
      console.log(`  Enabled:           ${currentConfig.enabled ? "Yes" : "No"}`);
      console.log(`  Directory:         ${currentConfig.directory}`);
      console.log(`  Retention:         ${currentConfig.retentionDays} days`);
      console.log(`  Incremental:       every ${currentConfig.intervalHours} hours`);
      console.log(`  Full backup:       every ${currentConfig.fullIntervalDays} days`);
      if (currentConfig.lastBackup) {
        const lastBackup = new Date(currentConfig.lastBackup);
        const ago = Math.round((Date.now() - lastBackup.getTime()) / (1000 * 60 * 60));
        console.log(`  Last incremental:  ${currentConfig.lastBackup} (${ago}h ago)`);
      } else {
        console.log(`  Last incremental:  Never`);
      }
      if (currentConfig.lastFullBackup) {
        const lastFull = new Date(currentConfig.lastFullBackup);
        const daysAgo = Math.round((Date.now() - lastFull.getTime()) / (1000 * 60 * 60 * 24));
        console.log(`  Last full:         ${currentConfig.lastFullBackup} (${daysAgo}d ago)`);
      } else {
        console.log(`  Last full:         Never`);
      }
    }
  });

backupCommand
  .command("list")
  .description("List available backups")
  .option("-n, --limit <n>", "Limit results", "10")
  .action((options) => {
    const config = getBackupConfig();
    const backupDir = config.directory;
    const limit = parseInt(options.limit) || 10;

    if (!fs.existsSync(backupDir)) {
      console.log("No backups found.");
      console.log(`\nBackup directory: ${backupDir}`);
      console.log("Run 'claude-roam backup run' to create a backup.");
      return;
    }

    const files = fs.readdirSync(backupDir)
      .filter(f => f.startsWith("backup-") && f.endsWith(".json"))
      .map(f => {
        const filePath = path.join(backupDir, f);
        const stats = fs.statSync(filePath);
        return { name: f, path: filePath, size: stats.size, mtime: stats.mtime };
      })
      .sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

    if (files.length === 0) {
      console.log("No backups found.");
      console.log(`\nBackup directory: ${backupDir}`);
      console.log("Run 'claude-roam backup run' to create a backup.");
      return;
    }

    console.log(`Backups (${Math.min(files.length, limit)} of ${files.length}):\n`);

    for (const file of files.slice(0, limit)) {
      const sizeMB = (file.size / (1024 * 1024)).toFixed(2);
      console.log(`  ${file.name}`);
      console.log(`    Size: ${sizeMB} MB | Created: ${file.mtime.toISOString()}`);
    }

    if (files.length > limit) {
      console.log(`\n  ... and ${files.length - limit} more`);
    }

    console.log(`\nBackup directory: ${backupDir}`);
  });

backupCommand
  .command("restore <backup-file>")
  .description("Restore sessions from a backup file (supports both full and incremental)")
  .option("-y, --yes", "Skip confirmation")
  .option("--overwrite", "Overwrite existing sessions")
  .action(async (backupFile, options) => {
    const filePath = path.isAbsolute(backupFile) ? backupFile : path.join(process.cwd(), backupFile);

    if (!fs.existsSync(filePath)) {
      // Try backup directory
      const config = getBackupConfig();
      const altPath = path.join(config.directory, backupFile);
      if (fs.existsSync(altPath)) {
        backupFile = altPath;
      } else {
        console.error(`File not found: ${filePath}`);
        process.exit(1);
      }
    } else {
      backupFile = filePath;
    }

    let bundle;
    try {
      const content = fs.readFileSync(backupFile, "utf-8");
      bundle = JSON.parse(content);
    } catch (err) {
      console.error("Failed to parse backup file:", err);
      process.exit(1);
    }

    // Support both full-backup and incremental-backup types
    if (!bundle.directories || (bundle.type !== "full-backup" && bundle.type !== "incremental-backup")) {
      console.error("Invalid backup file format");
      process.exit(1);
    }

    const isIncremental = bundle.type === "incremental-backup";
    const typeLabel = isIncremental ? "Incremental backup" : "Full backup";

    console.log(`Restoring from: ${backupFile}`);
    console.log(`  Type: ${typeLabel}`);
    console.log(`  Created: ${bundle.createdAt}`);
    console.log(`  Source: ${bundle.source.machineName}`);
    console.log(`  Directories: ${bundle.directories.length}`);

    let totalSessions = 0;
    for (const dir of bundle.directories) {
      totalSessions += dir.sessions.length;
    }
    console.log(`  Sessions: ${totalSessions}`);

    if (isIncremental && bundle.basedOn) {
      console.log(`\n⚠️  This is an incremental backup based on: ${bundle.basedOn}`);
      console.log("   For complete restoration, restore the full backup first.");
    }

    // Confirm restoration
    if (!options.yes) {
      process.stdout.write("\nRestore these sessions? [y/N] ");

      const answer = await new Promise<string>((resolve) => {
        let input = "";
        process.stdin.setRawMode?.(true);
        process.stdin.resume();
        process.stdin.setEncoding("utf8");

        const onData = (key: string) => {
          if (key === "\r" || key === "\n") {
            process.stdin.setRawMode?.(false);
            process.stdin.pause();
            process.stdin.removeListener("data", onData);
            console.log();
            resolve(input.trim().toLowerCase());
          } else if (key === "\u0003") {
            process.stdin.setRawMode?.(false);
            process.exit(0);
          } else if (key === "\u007F") {
            input = input.slice(0, -1);
          } else {
            input += key;
            process.stdout.write(key);
          }
        };

        process.stdin.on("data", onData);
      });

      if (answer !== "y" && answer !== "yes") {
        console.log("Aborted.");
        return;
      }
    }

    // Restore sessions
    const claudeDir = path.join(os.homedir(), ".claude", "projects");
    let restored = 0;
    let skipped = 0;

    for (const dir of bundle.directories) {
      const targetDir = path.join(claudeDir, dir.encodedDir);

      if (!fs.existsSync(targetDir)) {
        fs.mkdirSync(targetDir, { recursive: true });
      }

      for (const session of dir.sessions) {
        const targetFile = path.join(targetDir, `${session.id}.jsonl`);

        if (fs.existsSync(targetFile) && !options.overwrite) {
          skipped++;
          continue;
        }

        fs.writeFileSync(targetFile, session.data);
        restored++;
      }
    }

    console.log(`\n✓ Restore complete: ${restored} restored, ${skipped} skipped`);
    if (skipped > 0 && !options.overwrite) {
      console.log("  Use --overwrite to replace existing sessions");
    }
  });

backupCommand
  .command("setup-cron")
  .description("Setup automatic backup cron job (macOS/Linux)")
  .action(async () => {
    const platform = process.platform;

    if (platform === "darwin") {
      // macOS: use launchd
      const plistPath = path.join(os.homedir(), "Library/LaunchAgents/com.claude-roam.backup.plist");
      const config = getBackupConfig();

      // Find the claude-roam executable
      let execPath = process.argv[1];
      if (execPath.includes("index.ts")) {
        // Running in development mode
        execPath = "bun run " + execPath;
      }

      const plistContent = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.claude-roam.backup</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string>
    <string>-c</string>
    <string>claude-roam backup run --quiet</string>
  </array>
  <key>StartInterval</key>
  <integer>${config.intervalHours * 3600}</integer>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${path.join(os.homedir(), ".claude-roam", "backup.log")}</string>
  <key>StandardErrorPath</key>
  <string>${path.join(os.homedir(), ".claude-roam", "backup.error.log")}</string>
</dict>
</plist>`;

      // Ensure LaunchAgents directory exists
      const launchAgentsDir = path.join(os.homedir(), "Library/LaunchAgents");
      if (!fs.existsSync(launchAgentsDir)) {
        fs.mkdirSync(launchAgentsDir, { recursive: true });
      }

      fs.writeFileSync(plistPath, plistContent);
      console.log(`✓ Created launchd plist: ${plistPath}`);
      console.log(`  Backup interval: ${config.intervalHours} hours`);
      console.log(`  Backup directory: ${config.directory}`);

      console.log("\nTo activate the backup service:");
      console.log(`  launchctl load ${plistPath}`);

      console.log("\nTo check status:");
      console.log(`  launchctl list | grep claude-roam`);

      console.log("\nTo deactivate:");
      console.log(`  launchctl unload ${plistPath}`);

      // Enable backup in config
      saveBackupConfig({ enabled: true });
    } else if (platform === "linux") {
      // Linux: use crontab
      const config = getBackupConfig();
      const cronExpression = `0 */${config.intervalHours} * * *`;
      const cronLine = `${cronExpression} claude-roam backup run --quiet >> ${path.join(os.homedir(), ".claude-roam", "backup.log")} 2>&1`;

      console.log("To setup cron backup on Linux, add this line to your crontab:");
      console.log(`  ${cronLine}`);
      console.log("\nTo edit crontab:");
      console.log("  crontab -e");

      // Also provide systemd timer option
      const timerPath = path.join(os.homedir(), ".config/systemd/user/claude-roam-backup.timer");
      const servicePath = path.join(os.homedir(), ".config/systemd/user/claude-roam-backup.service");

      const serviceContent = `[Unit]
Description=Claude Roam Backup Service

[Service]
Type=oneshot
ExecStart=/usr/bin/env claude-roam backup run --quiet

[Install]
WantedBy=default.target`;

      const timerContent = `[Unit]
Description=Claude Roam Backup Timer

[Timer]
OnBootSec=10min
OnUnitActiveSec=${config.intervalHours}h

[Install]
WantedBy=timers.target`;

      console.log("\n--- OR use systemd user timer ---");
      console.log("\n1. Create service file:");
      console.log(`   mkdir -p ~/.config/systemd/user`);
      console.log(`   cat > ${servicePath} << 'EOF'`);
      console.log(serviceContent);
      console.log("EOF");

      console.log("\n2. Create timer file:");
      console.log(`   cat > ${timerPath} << 'EOF'`);
      console.log(timerContent);
      console.log("EOF");

      console.log("\n3. Enable and start:");
      console.log("   systemctl --user daemon-reload");
      console.log("   systemctl --user enable --now claude-roam-backup.timer");

      saveBackupConfig({ enabled: true });
    } else {
      console.log("Automatic backup setup is not supported on Windows yet.");
      console.log("\nYou can manually run 'claude-roam backup run' periodically.");
      console.log("Or use Windows Task Scheduler to create a scheduled task.");
    }
  });

// ============ Merge Command ============

interface MergeCandidate {
  childSessionId: string;
  parentSessionId: string;
  leafUuid: string;  // The uuid that connects them
  childFilePath: string;
  parentFilePath: string;
  childMessageCount: number;
  parentMessageCount: number;
  childSummary: string;
}

/**
 * Orphan link: A session whose first message's parentUuid points to a non-existent uuid,
 * but we can infer the parent session based on timestamp proximity.
 */
interface OrphanLink {
  childSessionId: string;
  childFilePath: string;
  childMessageCount: number;
  childFirstTimestamp: string;
  orphanParentUuid: string;  // The non-existent parentUuid
  // Inferred parent session
  inferredParentSessionId: string;
  inferredParentFilePath: string;
  inferredParentMessageCount: number;
  inferredParentLastUuid: string;
  inferredParentLastTimestamp: string;
  timeDiffMs: number;  // Time difference between child first and parent last
}

/**
 * A chain of sessions that should be merged together.
 * The chain goes from root (oldest) to leaf (newest).
 */
interface MergeChain {
  rootSessionId: string;
  rootFilePath: string;
  rootMessageCount: number;
  // Sessions in order from root's direct child to the leaf
  chain: Array<{
    sessionId: string;
    filePath: string;
    messageCount: number;
    leafUuid: string;  // The uuid in parent that this session connects to
    summary: string;
  }>;
  totalMessageCount: number;
}

/**
 * Detect sessions that can be merged.
 * Two types of links are detected:
 * 1. Summary-based: child session's summary.leafUuid points to parent session's message
 * 2. ParentUuid-based: child session's first message's parentUuid points to parent session's message
 */
function detectMergeableSessions(sessions: LocalSession[]): MergeCandidate[] {
  const candidates: MergeCandidate[] = [];

  // Build a map of all message uuids to their session
  const uuidToSession = new Map<string, LocalSession>();
  const sessionMessages = new Map<string, Set<string>>();
  const sessionSummaries = new Map<string, { leafUuid: string; summary: string }>();
  const sessionFirstMessage = new Map<string, { uuid: string; parentUuid: string | null }>();

  for (const session of sessions) {
    const content = fs.readFileSync(session.filePath, "utf-8");
    const lines = content.split("\n").filter((l) => l.trim());
    const uuids = new Set<string>();
    let firstMessageFound = false;

    for (const line of lines) {
      try {
        const obj = JSON.parse(line);
        if (obj.uuid) {
          uuids.add(obj.uuid);
          uuidToSession.set(obj.uuid, session);

          // Track first message with uuid
          if (!firstMessageFound) {
            sessionFirstMessage.set(session.sessionId, {
              uuid: obj.uuid,
              parentUuid: obj.parentUuid || null,
            });
            firstMessageFound = true;
          }
        }
        if (obj.type === "summary" && obj.leafUuid) {
          // Only record the first summary (most relevant one)
          if (!sessionSummaries.has(session.sessionId)) {
            sessionSummaries.set(session.sessionId, {
              leafUuid: obj.leafUuid,
              summary: obj.summary || "(no summary)",
            });
          }
        }
      } catch {
        // Skip
      }
    }
    sessionMessages.set(session.sessionId, uuids);
  }

  const addedChildIds = new Set<string>();

  // Type 1: Find sessions where summary.leafUuid points to another session's message
  for (const [childSessionId, summaryInfo] of sessionSummaries) {
    const parentSession = uuidToSession.get(summaryInfo.leafUuid);
    if (parentSession && parentSession.sessionId !== childSessionId) {
      const childSession = sessions.find((s) => s.sessionId === childSessionId)!;
      candidates.push({
        childSessionId,
        parentSessionId: parentSession.sessionId,
        leafUuid: summaryInfo.leafUuid,
        childFilePath: childSession.filePath,
        parentFilePath: parentSession.filePath,
        childMessageCount: sessionMessages.get(childSessionId)?.size || 0,
        parentMessageCount: sessionMessages.get(parentSession.sessionId)?.size || 0,
        childSummary: summaryInfo.summary,
      });
      addedChildIds.add(childSessionId);
    }
  }

  // Type 2: Find sessions where first message's parentUuid points to another session's message
  // (but only if not already covered by summary-based detection)
  for (const [childSessionId, firstMsg] of sessionFirstMessage) {
    if (addedChildIds.has(childSessionId)) continue;
    if (!firstMsg.parentUuid) continue;

    const parentSession = uuidToSession.get(firstMsg.parentUuid);
    if (parentSession && parentSession.sessionId !== childSessionId) {
      const childSession = sessions.find((s) => s.sessionId === childSessionId)!;
      candidates.push({
        childSessionId,
        parentSessionId: parentSession.sessionId,
        leafUuid: firstMsg.parentUuid,
        childFilePath: childSession.filePath,
        parentFilePath: parentSession.filePath,
        childMessageCount: sessionMessages.get(childSessionId)?.size || 0,
        parentMessageCount: sessionMessages.get(parentSession.sessionId)?.size || 0,
        childSummary: "(linked by parentUuid)",
      });
      addedChildIds.add(childSessionId);
    }
  }

  return candidates;
}

/**
 * Build merge chains from individual merge candidates.
 * This finds all sessions that form a chain and groups them together,
 * so we can merge an entire chain (A -> B -> C) into the root session A.
 */
function buildMergeChains(sessions: LocalSession[]): MergeChain[] {
  // First, get all the individual parent-child relationships
  const candidates = detectMergeableSessions(sessions);

  if (candidates.length === 0) {
    return [];
  }

  // Build maps for traversal
  const sessionMap = new Map(sessions.map(s => [s.sessionId, s]));
  const childToParent = new Map<string, MergeCandidate>();
  const parentToChildren = new Map<string, MergeCandidate[]>();
  const sessionMessageCounts = new Map<string, number>();

  // Count messages for each session
  for (const session of sessions) {
    const content = fs.readFileSync(session.filePath, "utf-8");
    const lines = content.split("\n").filter(l => l.trim());
    let count = 0;
    for (const line of lines) {
      try {
        const obj = JSON.parse(line);
        if (obj.uuid) count++;
      } catch {
        // Skip
      }
    }
    sessionMessageCounts.set(session.sessionId, count);
  }

  for (const candidate of candidates) {
    childToParent.set(candidate.childSessionId, candidate);
    if (!parentToChildren.has(candidate.parentSessionId)) {
      parentToChildren.set(candidate.parentSessionId, []);
    }
    parentToChildren.get(candidate.parentSessionId)!.push(candidate);
  }

  // Find root sessions (sessions that are parents but not children)
  const childSessionIds = new Set(candidates.map(c => c.childSessionId));
  const rootSessionIds = new Set<string>();

  for (const candidate of candidates) {
    if (!childSessionIds.has(candidate.parentSessionId)) {
      rootSessionIds.add(candidate.parentSessionId);
    }
  }

  // Build chains starting from each root
  const chains: MergeChain[] = [];

  for (const rootId of rootSessionIds) {
    const rootSession = sessionMap.get(rootId);
    if (!rootSession) continue;

    // Find all chains from this root (there might be branches)
    const buildChainFromRoot = (currentId: string, currentChain: MergeChain["chain"]): void => {
      const children = parentToChildren.get(currentId) || [];

      if (children.length === 0) {
        // This is a leaf - we have a complete chain
        if (currentChain.length > 0) {
          const totalMessages = (sessionMessageCounts.get(rootId) || 0) +
            currentChain.reduce((sum, c) => sum + c.messageCount, 0);

          chains.push({
            rootSessionId: rootId,
            rootFilePath: rootSession.filePath,
            rootMessageCount: sessionMessageCounts.get(rootId) || 0,
            chain: [...currentChain],
            totalMessageCount: totalMessages,
          });
        }
        return;
      }

      // Continue building chain for each child
      for (const child of children) {
        const childSession = sessionMap.get(child.childSessionId);
        if (!childSession) continue;

        const newChain = [
          ...currentChain,
          {
            sessionId: child.childSessionId,
            filePath: childSession.filePath,
            messageCount: sessionMessageCounts.get(child.childSessionId) || 0,
            leafUuid: child.leafUuid,
            summary: child.childSummary,
          },
        ];

        buildChainFromRoot(child.childSessionId, newChain);
      }
    };

    buildChainFromRoot(rootId, []);
  }

  return chains;
}

/**
 * Merge an entire chain into the root session.
 * Returns the total number of lines merged.
 */
function mergeChain(chain: MergeChain): { mergedCount: number; deletedFiles: string[] } {
  let totalMerged = 0;
  const deletedFiles: string[] = [];

  // Merge each session in the chain, in order
  for (const item of chain.chain) {
    const childContent = fs.readFileSync(item.filePath, "utf-8");
    const childLines = childContent.split("\n").filter(l => l.trim());

    const messagesToMerge: string[] = [];
    let firstRealMessage = true;

    for (const line of childLines) {
      try {
        const obj = JSON.parse(line);

        // Skip summary
        if (obj.type === "summary") {
          continue;
        }

        // For messages with uuid, potentially fix the parentUuid
        if (obj.uuid) {
          if (firstRealMessage && obj.parentUuid === null) {
            // This is the first message, connect it to the leaf
            obj.parentUuid = item.leafUuid;
            firstRealMessage = false;
          }
          messagesToMerge.push(JSON.stringify(obj));
        } else if (obj.type === "file-history-snapshot") {
          // Keep snapshots but only after first real message
          if (!firstRealMessage) {
            messagesToMerge.push(line);
          }
        } else {
          // Other types
          messagesToMerge.push(line);
        }
      } catch {
        messagesToMerge.push(line);
      }
    }

    if (messagesToMerge.length > 0) {
      // Append to root file
      const rootContent = fs.readFileSync(chain.rootFilePath, "utf-8");
      const newContent = rootContent.trimEnd() + "\n" + messagesToMerge.join("\n") + "\n";
      fs.writeFileSync(chain.rootFilePath, newContent);
      totalMerged += messagesToMerge.length;
    }

    deletedFiles.push(item.filePath);
  }

  return { mergedCount: totalMerged, deletedFiles };
}

/**
 * Detect orphan links: sessions whose first message's parentUuid points to a non-existent uuid.
 * We try to infer the parent session based on timestamp proximity.
 */
function detectOrphanLinks(sessions: LocalSession[]): OrphanLink[] {
  const orphanLinks: OrphanLink[] = [];

  // Build a global map of all message uuids across all sessions
  const allUuids = new Set<string>();
  interface SessionInfo {
    session: LocalSession;
    firstMessage: { uuid: string; parentUuid: string | null; timestamp: string } | null;
    lastMessage: { uuid: string; timestamp: string } | null;
    messageCount: number;
  }
  const sessionInfos: SessionInfo[] = [];

  for (const session of sessions) {
    const content = fs.readFileSync(session.filePath, "utf-8");
    const lines = content.split("\n").filter((l) => l.trim());

    let firstMessage: SessionInfo["firstMessage"] = null;
    let lastMessage: SessionInfo["lastMessage"] = null;
    let lastMessageTime = 0;
    let messageCount = 0;

    for (const line of lines) {
      try {
        const obj = JSON.parse(line);
        if (obj.uuid) {
          allUuids.add(obj.uuid);
          messageCount++;

          // Track first message with uuid
          if (!firstMessage) {
            firstMessage = {
              uuid: obj.uuid,
              parentUuid: obj.parentUuid || null,
              timestamp: obj.timestamp || "",
            };
          }

          // Track last message with uuid and timestamp (by timestamp, not file order)
          if (obj.timestamp) {
            const msgTime = new Date(obj.timestamp).getTime();
            if (!isNaN(msgTime) && msgTime > lastMessageTime) {
              lastMessageTime = msgTime;
              lastMessage = {
                uuid: obj.uuid,
                timestamp: obj.timestamp,
              };
            }
          }
        }
      } catch {
        // Skip
      }
    }

    sessionInfos.push({
      session,
      firstMessage,
      lastMessage,
      messageCount,
    });
  }

  // Find sessions with orphan first message (parentUuid exists but points to non-existent uuid)
  for (const info of sessionInfos) {
    const first = info.firstMessage;
    if (!first || !first.parentUuid || !first.timestamp) continue;

    // Check if parentUuid exists in any session
    if (allUuids.has(first.parentUuid)) continue;

    // This is an orphan link - parentUuid points to non-existent uuid
    // Try to find a parent session based on timestamp proximity
    const childTime = new Date(first.timestamp).getTime();
    if (isNaN(childTime)) continue;

    // Find the session whose last message is closest in time BEFORE the child's first message
    let bestParent: SessionInfo | null = null;
    let bestTimeDiff = Infinity;

    for (const parentInfo of sessionInfos) {
      if (parentInfo.session.sessionId === info.session.sessionId) continue;
      if (!parentInfo.lastMessage || !parentInfo.lastMessage.timestamp) continue;

      const parentTime = new Date(parentInfo.lastMessage.timestamp).getTime();
      if (isNaN(parentTime)) continue;

      // Parent's last message should be BEFORE child's first message
      const timeDiff = childTime - parentTime;
      if (timeDiff > 0 && timeDiff < bestTimeDiff) {
        // Within 10 minutes is a reasonable threshold for context handoff
        if (timeDiff <= 10 * 60 * 1000) {
          bestTimeDiff = timeDiff;
          bestParent = parentInfo;
        }
      }
    }

    if (bestParent && bestParent.lastMessage) {
      orphanLinks.push({
        childSessionId: info.session.sessionId,
        childFilePath: info.session.filePath,
        childMessageCount: info.messageCount,
        childFirstTimestamp: first.timestamp,
        orphanParentUuid: first.parentUuid,
        inferredParentSessionId: bestParent.session.sessionId,
        inferredParentFilePath: bestParent.session.filePath,
        inferredParentMessageCount: bestParent.messageCount,
        inferredParentLastUuid: bestParent.lastMessage.uuid,
        inferredParentLastTimestamp: bestParent.lastMessage.timestamp,
        timeDiffMs: bestTimeDiff,
      });
    }
  }

  return orphanLinks;
}

/**
 * Link an orphan session to its inferred parent by updating the first message's parentUuid
 */
function linkOrphanSession(orphan: OrphanLink): boolean {
  const content = fs.readFileSync(orphan.childFilePath, "utf-8");
  const lines = content.split("\n");

  let fixed = false;
  const fixedLines: string[] = [];

  for (const line of lines) {
    if (!line.trim()) {
      fixedLines.push(line);
      continue;
    }

    try {
      const obj = JSON.parse(line);
      // Find the first message with the orphan parentUuid and fix it
      if (!fixed && obj.uuid && obj.parentUuid === orphan.orphanParentUuid) {
        obj.parentUuid = orphan.inferredParentLastUuid;
        fixedLines.push(JSON.stringify(obj));
        fixed = true;
      } else {
        fixedLines.push(line);
      }
    } catch {
      fixedLines.push(line);
    }
  }

  if (fixed) {
    fs.writeFileSync(orphan.childFilePath, fixedLines.join("\n"));
  }

  return fixed;
}

/**
 * Merge child session into parent session
 * - The child's first real message's parentUuid becomes the leaf uuid (which is in parent session)
 * - All child messages are appended to parent file
 * - Returns the number of messages merged
 */
function mergeSessionFiles(candidate: MergeCandidate): { mergedCount: number; firstMessageUuid: string } {
  const childContent = fs.readFileSync(candidate.childFilePath, "utf-8");
  const childLines = childContent.split("\n").filter((l) => l.trim());

  // Find all messages to merge (skip summary and file-history-snapshot at the start)
  const messagesToMerge: string[] = [];
  let firstRealMessage = true;
  let firstMessageUuid = "";

  for (const line of childLines) {
    try {
      const obj = JSON.parse(line);

      // Skip summary
      if (obj.type === "summary") {
        continue;
      }

      // For messages with uuid, potentially fix the parentUuid
      if (obj.uuid) {
        if (firstRealMessage && obj.parentUuid === null) {
          // This is the first message, connect it to the leaf
          obj.parentUuid = candidate.leafUuid;
          firstMessageUuid = obj.uuid;
          firstRealMessage = false;
        }
        messagesToMerge.push(JSON.stringify(obj));
      } else if (obj.type === "file-history-snapshot") {
        // Keep snapshots but only after first real message
        if (!firstRealMessage) {
          messagesToMerge.push(line);
        }
      } else {
        // Other types (like system messages without uuid)
        messagesToMerge.push(line);
      }
    } catch {
      // Keep unparseable lines
      messagesToMerge.push(line);
    }
  }

  if (messagesToMerge.length === 0) {
    return { mergedCount: 0, firstMessageUuid: "" };
  }

  // Append to parent file
  const parentContent = fs.readFileSync(candidate.parentFilePath, "utf-8");
  const newContent = parentContent.trimEnd() + "\n" + messagesToMerge.join("\n") + "\n";
  fs.writeFileSync(candidate.parentFilePath, newContent);

  return { mergedCount: messagesToMerge.length, firstMessageUuid };
}

program
  .command("merge [session-id]")
  .description("Detect and merge sessions that were split by Claude Code context handoff")
  .option("-y, --yes", "Skip confirmation prompt")
  .option("--dry-run", "Only show what would be merged")
  .option("--keep", "Keep child session files after merge (default: delete)")
  .option("--link-only", "Only link orphan sessions (don't merge into single file)")
  .option("--flat", "Merge one level at a time (default: merge entire chains)")
  .action(async (sessionId, options) => {
    const currentDir = process.cwd();
    const encodedDir = encodePathForClaude(currentDir);
    const allSessions = scanLocalSessions();

    // Filter to current directory
    const sessions = sessionId
      ? allSessions.filter((s) => s.sessionId === sessionId || s.sessionId.startsWith(sessionId))
      : allSessions.filter((s) => s.encodedDir === encodedDir);

    if (sessions.length === 0) {
      console.error("No sessions found.");
      process.exit(1);
    }

    console.log(`Analyzing ${sessions.length} session(s) for merge candidates...\n`);

    // Detect orphan links first
    const orphanLinks = detectOrphanLinks(sessions);

    // Build merge chains (or flat candidates)
    const chains = buildMergeChains(sessions);
    const flatCandidates = options.flat ? detectMergeableSessions(sessions) : [];

    // Filter out orphans that are already covered by merge chains/candidates
    const mergeChildIds = new Set<string>();
    for (const chain of chains) {
      for (const item of chain.chain) {
        mergeChildIds.add(item.sessionId);
      }
    }
    for (const c of flatCandidates) {
      mergeChildIds.add(c.childSessionId);
    }
    const filteredOrphans = orphanLinks.filter(o => !mergeChildIds.has(o.childSessionId));

    const hasWork = chains.length > 0 || flatCandidates.length > 0 || filteredOrphans.length > 0;

    if (!hasWork) {
      console.log("✓ No mergeable sessions or orphan links found.");
      console.log("\nSessions are considered mergeable when:");
      console.log("  - A session starts with a summary record pointing to another session");
      console.log("  - A session's first message has a parentUuid that doesn't exist (orphan link)");
      console.log("  (This happens when Claude Code performs context handoff)");
      return;
    }

    // Display merge chains
    if (!options.flat && chains.length > 0) {
      console.log(`Found ${chains.length} merge chain(s):\n`);

      for (const chain of chains) {
        console.log(`Root: ${chain.rootSessionId.slice(0, 8)}... (${chain.rootMessageCount} messages)`);
        console.log(`Chain (${chain.chain.length} session(s) to merge):`);
        for (let i = 0; i < chain.chain.length; i++) {
          const item = chain.chain[i];
          const prefix = i === chain.chain.length - 1 ? "└──" : "├──";
          console.log(`  ${prefix} ${item.sessionId.slice(0, 8)}... (${item.messageCount} msgs) "${item.summary.slice(0, 40)}${item.summary.length > 40 ? '...' : ''}"`);
        }
        console.log(`  Total after merge: ~${chain.totalMessageCount} messages`);
        console.log();
      }
    }

    // Display flat candidates (if --flat mode)
    if (options.flat && flatCandidates.length > 0) {
      console.log(`Found ${flatCandidates.length} merge candidate(s) (flat mode):\n`);

      for (const candidate of flatCandidates) {
        console.log(`Child:  ${candidate.childSessionId.slice(0, 8)}... (${candidate.childMessageCount} messages)`);
        console.log(`Parent: ${candidate.parentSessionId.slice(0, 8)}... (${candidate.parentMessageCount} messages)`);
        console.log(`  Summary: "${candidate.childSummary.slice(0, 60)}${candidate.childSummary.length > 60 ? '...' : ''}"`);
        console.log(`  Connection: child connects to ${candidate.leafUuid.slice(0, 8)}... in parent`);
        console.log(`  After merge: ~${candidate.childMessageCount + candidate.parentMessageCount} messages`);
        console.log();
      }
    }

    // Display orphan links
    if (filteredOrphans.length > 0) {
      console.log(`Found ${filteredOrphans.length} orphan link(s) (timestamp-inferred):\n`);

      for (const orphan of filteredOrphans) {
        const timeDiffSec = Math.round(orphan.timeDiffMs / 1000);
        const timeDiffStr = timeDiffSec < 60 ? `${timeDiffSec}s` : `${Math.round(timeDiffSec / 60)}m ${timeDiffSec % 60}s`;

        console.log(`Orphan: ${orphan.childSessionId.slice(0, 8)}... (${orphan.childMessageCount} messages)`);
        console.log(`  First message at: ${orphan.childFirstTimestamp}`);
        console.log(`  parentUuid ${orphan.orphanParentUuid.slice(0, 8)}... does NOT exist in any session`);
        console.log(`Inferred parent: ${orphan.inferredParentSessionId.slice(0, 8)}... (${orphan.inferredParentMessageCount} messages)`);
        console.log(`  Last message at: ${orphan.inferredParentLastTimestamp}`);
        console.log(`  Time gap: ${timeDiffStr}`);
        console.log(`  Will link to: ${orphan.inferredParentLastUuid.slice(0, 8)}...`);
        console.log();
      }
    }

    if (options.dryRun) {
      console.log("[DRY-RUN] No changes made.");
      return;
    }

    // Handle orphan links first (link-only mode or normal mode)
    if (filteredOrphans.length > 0) {
      let shouldLink = options.yes;
      if (!shouldLink) {
        shouldLink = await promptYesNo("Link orphan sessions to their inferred parents? [y/N]: ");
      }

      if (shouldLink) {
        let linked = 0;
        for (const orphan of filteredOrphans) {
          if (linkOrphanSession(orphan)) {
            linked++;
            console.log(`✓ Linked ${orphan.childSessionId.slice(0, 8)}... to ${orphan.inferredParentSessionId.slice(0, 8)}...`);
            console.log(`  ${orphan.orphanParentUuid.slice(0, 8)}... -> ${orphan.inferredParentLastUuid.slice(0, 8)}...`);
          }
        }
        console.log(`\n✓ Linked ${linked} orphan session(s).`);
      }
    }

    // If link-only mode, stop here
    if (options.linkOnly) {
      return;
    }

    // Handle merge (chains or flat)
    if (!options.flat && chains.length > 0) {
      // Chain merge mode
      let shouldMerge = options.yes;
      if (!shouldMerge) {
        shouldMerge = await promptYesNo("Merge entire chains (combine files)? [y/N]: ");
      }

      if (!shouldMerge) {
        console.log("Merge skipped.");
        return;
      }

      // Perform chain merges
      let totalMerged = 0;
      const allDeletedFiles: string[] = [];

      for (const chain of chains) {
        const { mergedCount, deletedFiles } = mergeChain(chain);
        totalMerged += mergedCount;
        allDeletedFiles.push(...deletedFiles);

        console.log(`✓ Merged chain into ${chain.rootSessionId.slice(0, 8)}...`);
        for (const item of chain.chain) {
          console.log(`    <- ${item.sessionId.slice(0, 8)}...`);
        }
      }

      console.log(`\n✓ Total: ${totalMerged} lines merged.`);

      // Delete merged session files
      if (!options.keep && allDeletedFiles.length > 0) {
        console.log();
        for (const filePath of allDeletedFiles) {
          try {
            fs.unlinkSync(filePath);
            console.log(`✓ Deleted ${path.basename(filePath)}`);
          } catch (err) {
            console.error(`✗ Failed to delete ${path.basename(filePath)}: ${err}`);
          }
        }
      } else if (options.keep && allDeletedFiles.length > 0) {
        console.log("\nChild session files preserved (--keep). You can manually delete:");
        for (const filePath of allDeletedFiles) {
          console.log(`  rm "${filePath}"`);
        }
      }
    } else if (options.flat && flatCandidates.length > 0) {
      // Flat merge mode (one level at a time)
      let shouldMerge = options.yes;
      if (!shouldMerge) {
        shouldMerge = await promptYesNo("Merge sessions (combine files)? [y/N]: ");
      }

      if (!shouldMerge) {
        console.log("Merge skipped.");
        return;
      }

      // Perform flat merges
      let totalMerged = 0;
      const mergedChildren: string[] = [];

      for (const candidate of flatCandidates) {
        const { mergedCount, firstMessageUuid } = mergeSessionFiles(candidate);
        if (mergedCount > 0) {
          totalMerged += mergedCount;
          mergedChildren.push(candidate.childFilePath);
          console.log(`✓ Merged ${mergedCount} lines from ${candidate.childSessionId.slice(0, 8)}... into ${candidate.parentSessionId.slice(0, 8)}...`);
          console.log(`  First message ${firstMessageUuid.slice(0, 8)}... now connects to ${candidate.leafUuid.slice(0, 8)}...`);
        }
      }

      console.log(`\n✓ Total: ${totalMerged} lines merged.`);

      // Delete child sessions by default (unless --keep is specified)
      if (!options.keep && mergedChildren.length > 0) {
        console.log();
        for (const filePath of mergedChildren) {
          try {
            fs.unlinkSync(filePath);
            console.log(`✓ Deleted ${path.basename(filePath)}`);
          } catch (err) {
            console.error(`✗ Failed to delete ${path.basename(filePath)}: ${err}`);
          }
        }
      } else if (options.keep && mergedChildren.length > 0) {
        console.log("\nChild session files preserved (--keep). You can manually delete:");
        for (const filePath of mergedChildren) {
          console.log(`  rm "${filePath}"`);
        }
      }
    }
  });

program
  .command("merge-into <child-session> <parent-session>")
  .description("Manually merge a child session into a parent session")
  .option("-y, --yes", "Skip confirmation prompt")
  .option("--dry-run", "Only show what would be merged")
  .option("--keep", "Keep child session file after merge (default: delete)")
  .action(async (childId, parentId, options) => {
    const allSessions = scanLocalSessions();

    // Find sessions (support partial ID match)
    const childSession = allSessions.find(
      (s) => s.sessionId === childId || s.sessionId.startsWith(childId)
    );
    const parentSession = allSessions.find(
      (s) => s.sessionId === parentId || s.sessionId.startsWith(parentId)
    );

    if (!childSession) {
      console.error(`Child session not found: ${childId}`);
      process.exit(1);
    }
    if (!parentSession) {
      console.error(`Parent session not found: ${parentId}`);
      process.exit(1);
    }
    if (childSession.sessionId === parentSession.sessionId) {
      console.error("Cannot merge a session into itself.");
      process.exit(1);
    }

    // Read both sessions
    const childContent = fs.readFileSync(childSession.filePath, "utf-8");
    const childLines = childContent.split("\n").filter((l) => l.trim());
    const parentContent = fs.readFileSync(parentSession.filePath, "utf-8");
    const parentLines = parentContent.split("\n").filter((l) => l.trim());

    // Analyze sessions
    let childMsgCount = 0;
    let parentMsgCount = 0;
    let parentLastUuid = "";
    let parentLastTs = 0;

    for (const line of childLines) {
      try {
        if (JSON.parse(line).uuid) childMsgCount++;
      } catch { /* skip */ }
    }

    for (const line of parentLines) {
      try {
        const obj = JSON.parse(line);
        if (obj.uuid) {
          parentMsgCount++;
          if (obj.timestamp) {
            const ts = new Date(obj.timestamp).getTime();
            if (!isNaN(ts) && ts > parentLastTs) {
              parentLastTs = ts;
              parentLastUuid = obj.uuid;
            }
          }
        }
      } catch { /* skip */ }
    }

    console.log("Manual merge:\n");
    console.log(`Child:  ${childSession.sessionId} (${childMsgCount} messages)`);
    console.log(`Parent: ${parentSession.sessionId} (${parentMsgCount} messages)`);
    console.log(`\nChild will be appended to parent.`);
    console.log(`First message linked to: ${parentLastUuid.slice(0, 8)}...`);
    console.log(`After merge: ~${childMsgCount + parentMsgCount} messages`);

    if (options.dryRun) {
      console.log("\n[DRY-RUN] No changes made.");
      return;
    }

    if (!options.yes) {
      const confirm = await promptYesNo("\nProceed? [y/N]: ");
      if (!confirm) {
        console.log("Aborted.");
        return;
      }
    }

    // Merge
    const toMerge: string[] = [];
    let first = true;
    let firstUuid = "";

    for (const line of childLines) {
      try {
        const obj = JSON.parse(line);
        if (obj.type === "summary") continue;

        if (obj.uuid) {
          if (first) {
            obj.parentUuid = parentLastUuid;
            firstUuid = obj.uuid;
            first = false;
          }
          toMerge.push(JSON.stringify(obj));
        } else if (obj.type !== "file-history-snapshot" || !first) {
          toMerge.push(line);
        }
      } catch {
        toMerge.push(line);
      }
    }

    if (toMerge.length > 0) {
      fs.writeFileSync(parentSession.filePath, parentContent.trimEnd() + "\n" + toMerge.join("\n") + "\n");
      console.log(`\n✓ Merged ${toMerge.length} lines`);
      console.log(`  ${firstUuid.slice(0, 8)}... -> ${parentLastUuid.slice(0, 8)}...`);
    }

    if (!options.keep) {
      fs.unlinkSync(childSession.filePath);
      console.log(`✓ Deleted ${path.basename(childSession.filePath)}`);
    } else {
      console.log(`\nKept child file: ${childSession.filePath}`);
    }
  });

// ============ Repair Command ============

interface BrokenLink {
  messageUuid: string;
  oldParentUuid: string;
  newParentUuid: string;
  currentChainLength: number;
  historyChainLength: number;
}

interface SessionAnalysis {
  filePath: string;
  sessionId: string;
  totalMessages: number;
  brokenLinks: BrokenLink[];
}

function analyzeSession(filePath: string): SessionAnalysis {
  const content = fs.readFileSync(filePath, "utf-8");
  const lines = content.split("\n").filter((l) => l.trim());

  // Collect data
  const snapshotIdMap = new Map<string, string>(); // snapshot messageId -> inner messageId
  const messageMap = new Map<string, { parentUuid?: string; timestamp?: string }>();

  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      if (obj.type === "file-history-snapshot") {
        const messageId = obj.messageId;
        const innerMessageId = obj.snapshot?.messageId;
        if (messageId && innerMessageId) {
          snapshotIdMap.set(messageId, innerMessageId);
        }
      }
      if (obj.uuid) {
        messageMap.set(obj.uuid, {
          parentUuid: obj.parentUuid,
          timestamp: obj.timestamp,
        });
      }
    } catch {
      // Skip
    }
  }

  // Find broken links
  const brokenLinks: BrokenLink[] = [];

  for (const [uuid, msg] of messageMap) {
    const parentUuid = msg.parentUuid;
    if (parentUuid && snapshotIdMap.has(parentUuid) && !messageMap.has(parentUuid)) {
      const newParent = snapshotIdMap.get(parentUuid)!;

      // Calculate chain lengths
      const currentChainLength = countChainFromLeaf(uuid, messageMap);
      const historyChainLength = messageMap.has(newParent)
        ? countChainToRoot(newParent, messageMap)
        : 0;

      brokenLinks.push({
        messageUuid: uuid,
        oldParentUuid: parentUuid,
        newParentUuid: newParent,
        currentChainLength,
        historyChainLength,
      });
    }
  }

  return {
    filePath,
    sessionId: path.basename(filePath, ".jsonl"),
    totalMessages: messageMap.size,
    brokenLinks,
  };
}

function countChainFromLeaf(
  uuid: string,
  messageMap: Map<string, { parentUuid?: string }>
): number {
  // Find all descendants of this uuid and count the longest chain
  const children = new Map<string, string[]>();
  for (const [id, msg] of messageMap) {
    const parent = msg.parentUuid || "ROOT";
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent)!.push(id);
  }

  // Find leaves that descend from uuid
  const visited = new Set<string>();
  const queue = [uuid];
  let maxDepth = 0;

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (visited.has(current)) continue;
    visited.add(current);

    const kids = children.get(current) || [];
    if (kids.length === 0) {
      // This is a leaf, count depth from uuid
      let depth = 0;
      let node: string | undefined = current;
      while (node && node !== uuid && messageMap.has(node)) {
        depth++;
        node = messageMap.get(node)?.parentUuid;
      }
      if (node === uuid) depth++;
      maxDepth = Math.max(maxDepth, depth);
    } else {
      queue.push(...kids);
    }
  }

  return maxDepth || 1;
}

function countChainToRoot(
  uuid: string,
  messageMap: Map<string, { parentUuid?: string }>
): number {
  let count = 0;
  let current: string | undefined = uuid;
  while (current && messageMap.has(current)) {
    count++;
    current = messageMap.get(current)?.parentUuid;
  }
  return count;
}

function repairSessionFile(filePath: string, linksToRepair: BrokenLink[]): number {
  const content = fs.readFileSync(filePath, "utf-8");
  const lines = content.split("\n");

  const repairMap = new Map<string, string>();
  for (const link of linksToRepair) {
    repairMap.set(link.messageUuid, link.newParentUuid);
  }

  let fixCount = 0;
  const fixedLines: string[] = [];

  for (const line of lines) {
    if (!line.trim()) {
      fixedLines.push(line);
      continue;
    }

    try {
      const obj = JSON.parse(line);
      if (obj.uuid && repairMap.has(obj.uuid)) {
        obj.parentUuid = repairMap.get(obj.uuid);
        fixedLines.push(JSON.stringify(obj));
        fixCount++;
      } else {
        fixedLines.push(line);
      }
    } catch {
      fixedLines.push(line);
    }
  }

  fs.writeFileSync(filePath, fixedLines.join("\n"));
  return fixCount;
}

async function promptYesNo(question: string): Promise<boolean> {
  const readline = await import("readline");
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.toLowerCase() === "y" || answer.toLowerCase() === "yes");
    });
  });
}

/**
 * Check sessions for broken links and prompt user to repair
 * Returns true if user chose to continue (or no issues found), false if aborted
 */
async function checkAndPromptRepair(sessions: LocalSession[]): Promise<boolean> {
  const sessionsWithIssues: SessionAnalysis[] = [];
  let totalBrokenLinks = 0;

  for (const session of sessions) {
    const analysis = analyzeSession(session.filePath);
    if (analysis.brokenLinks.length > 0) {
      sessionsWithIssues.push(analysis);
      totalBrokenLinks += analysis.brokenLinks.length;
    }
  }

  if (totalBrokenLinks === 0) {
    return true; // No issues, continue
  }

  // Display findings
  console.log(`\n⚠️  Found ${totalBrokenLinks} broken link(s) in ${sessionsWithIssues.length} session(s):\n`);

  for (const analysis of sessionsWithIssues) {
    for (const link of analysis.brokenLinks) {
      console.log(`  Session ${analysis.sessionId.slice(0, 8)}...:`);
      console.log(`    Can connect ${link.currentChainLength} messages to ${link.historyChainLength} history messages`);
    }
  }

  console.log();
  const shouldRepair = await promptYesNo("Repair broken links before continuing? [Y/n]: ");

  if (shouldRepair) {
    let totalFixed = 0;
    for (const analysis of sessionsWithIssues) {
      const fixed = repairSessionFile(analysis.filePath, analysis.brokenLinks);
      totalFixed += fixed;
    }
    console.log(`✓ Repaired ${totalFixed} broken link(s).\n`);
  }

  return true; // Continue regardless of repair choice
}

program
  .command("repair [session-id]")
  .description("Detect and repair broken message chains in session history")
  .option("--yes, -y", "Skip confirmation prompt")
  .option("--dry-run", "Only show what would be repaired")
  .action(async (sessionId, options) => {
    const currentDir = process.cwd();
    const encodedDir = encodePathForClaude(currentDir);
    const sessions = scanLocalSessions();

    let sessionsToAnalyze: LocalSession[];

    if (sessionId) {
      const session = sessions.find(
        (s) => s.sessionId === sessionId || s.sessionId.startsWith(sessionId)
      );
      if (!session) {
        console.error(`Session not found: ${sessionId}`);
        process.exit(1);
      }
      sessionsToAnalyze = [session];
    } else {
      sessionsToAnalyze = sessions.filter((s) => s.encodedDir === encodedDir);
      if (sessionsToAnalyze.length === 0) {
        console.error("No sessions found for current directory.");
        process.exit(1);
      }
    }

    console.log(`Analyzing ${sessionsToAnalyze.length} session(s)...\n`);

    let totalBrokenLinks = 0;
    const sessionsWithIssues: SessionAnalysis[] = [];

    for (const session of sessionsToAnalyze) {
      const analysis = analyzeSession(session.filePath);
      if (analysis.brokenLinks.length > 0) {
        sessionsWithIssues.push(analysis);
        totalBrokenLinks += analysis.brokenLinks.length;
      }
    }

    if (totalBrokenLinks === 0) {
      console.log("✓ No broken links found. All sessions are healthy.");
      return;
    }

    // Display findings
    console.log(`Found ${totalBrokenLinks} broken link(s) in ${sessionsWithIssues.length} session(s):\n`);

    for (const analysis of sessionsWithIssues) {
      console.log(`Session: ${analysis.sessionId.slice(0, 8)}...`);
      console.log(`  Total messages: ${analysis.totalMessages}`);

      for (const link of analysis.brokenLinks) {
        console.log(`\n  Broken link detected:`);
        console.log(`    Message: ${link.messageUuid.slice(0, 8)}...`);
        console.log(`    Current parent: ${link.oldParentUuid.slice(0, 8)}... (snapshot, not a message)`);
        console.log(`    Can connect to: ${link.newParentUuid.slice(0, 8)}... (valid message)`);
        console.log(`    Current chain: ~${link.currentChainLength} messages`);
        console.log(`    History chain: ~${link.historyChainLength} messages`);
        console.log(`    After repair: ~${link.currentChainLength + link.historyChainLength} messages`);
      }
      console.log();
    }

    if (options.dryRun) {
      console.log("[DRY-RUN] No changes made.");
      return;
    }

    // Confirm
    let shouldRepair = options.yes;
    if (!shouldRepair) {
      shouldRepair = await promptYesNo("Repair these broken links? [y/N]: ");
    }

    if (!shouldRepair) {
      console.log("Aborted.");
      return;
    }

    // Perform repair
    let totalFixed = 0;
    for (const analysis of sessionsWithIssues) {
      const fixed = repairSessionFile(analysis.filePath, analysis.brokenLinks);
      totalFixed += fixed;
      console.log(`✓ Repaired ${fixed} link(s) in ${analysis.sessionId.slice(0, 8)}...`);
    }

    console.log(`\n✓ Total: ${totalFixed} broken link(s) repaired.`);
  });

program.parse();
