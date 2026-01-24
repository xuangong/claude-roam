#!/usr/bin/env bun
/**
 * Claude Roam CLI - Main entry point
 */

import { Command } from "commander";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  pullSession as pullSessionApi,
  pushSession as pushSessionApi,
  listSessions,
  listSessionsByDir,
  listSessionsGrouped,
  healthCheck,
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
  .option("--force", "Force push even if no changes (only for current directory, not with --all)")
  .option("-c, --concurrency <n>", "Max concurrent uploads", "20")
  .action(async (options) => {
    const state = loadState();
    const concurrency = parseInt(options.concurrency) || 20;

    if (!process.env.ROAM_API) {
      console.error("Error: ROAM_API environment variable not set");
      process.exit(1);
    }

    // --force 和 --all 不能同时使用
    if (options.force && options.all) {
      console.error("Error: --force cannot be used with --all");
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

    // Prepare sessions to push
    interface PushTask {
      session: LocalSession;
      fromLine: number;
      appendData: string;
      originalPath: string;
    }

    const tasks: PushTask[] = [];
    for (const session of sessions) {
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

program.parse();
