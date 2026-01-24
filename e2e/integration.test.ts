/**
 * End-to-end integration tests for Claude Roam
 *
 * These tests verify the complete flow:
 * 1. Server API operations
 * 2. CLI push/pull operations
 * 3. Data integrity across components
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { spawn, type Subprocess } from "bun";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const TEST_PORT = 3099;
const API_BASE = `http://localhost:${TEST_PORT}/api`;

let serverProcess: Subprocess | null = null;
let testDbPath: string;

/**
 * Wait for server to be ready
 */
async function waitForServer(
  url: string,
  timeout = 10000
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      const response = await fetch(url);
      if (response.ok) return true;
    } catch {
      // Server not ready yet
    }
    await Bun.sleep(100);
  }
  return false;
}

describe("End-to-End Integration Tests", () => {
  beforeAll(async () => {
    // Create temporary database
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-roam-e2e-"));
    testDbPath = path.join(tempDir, "test.db");

    // Start server
    serverProcess = spawn({
      cmd: [
        "uv",
        "run",
        "uvicorn",
        "app.main:app",
        "--host",
        "127.0.0.1",
        "--port",
        TEST_PORT.toString(),
      ],
      cwd: path.join(import.meta.dir, "../server"),
      env: {
        ...process.env,
        // Note: Database path is set in app/db.py, would need modification
        // to support env var configuration for testing
      },
      stdout: "ignore",
      stderr: "ignore",
    });

    // Wait for server
    const ready = await waitForServer(`${API_BASE}/health`);
    if (!ready) {
      throw new Error("Server failed to start");
    }
  });

  afterAll(async () => {
    if (serverProcess) {
      serverProcess.kill();
    }
    // Cleanup temp files
    if (testDbPath && fs.existsSync(path.dirname(testDbPath))) {
      fs.rmSync(path.dirname(testDbPath), { recursive: true });
    }
  });

  describe("Server Health", () => {
    test("health endpoint returns ok", async () => {
      const response = await fetch(`${API_BASE}/health`);
      expect(response.ok).toBe(true);

      const data = await response.json();
      expect(data.status).toBe("ok");
    });
  });

  describe("Session Lifecycle", () => {
    const sessionId = `e2e-test-${Date.now()}`;

    test("creates new session via push", async () => {
      const response = await fetch(`${API_BASE}/sessions/${sessionId}/push`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          from_line: 1,
          append_data:
            '{"type": "human", "message": {"content": [{"type": "text", "text": "E2E test message"}]}}',
          source: {
            machine_id: "e2e-test-machine",
            machine_name: "E2E Test",
            platform: "darwin",
            original_path: "/tmp/e2e-test",
          },
        }),
      });

      expect(response.ok).toBe(true);
      const data = await response.json();
      expect(data.ok).toBe(true);
    });

    test("retrieves session via pull", async () => {
      const response = await fetch(`${API_BASE}/sessions/${sessionId}/pull`);
      expect(response.ok).toBe(true);

      const data = await response.json();
      expect(data.meta.session_id).toBe(sessionId);
      expect(data.meta.total_lines).toBe(1);
      expect(data.meta.first_message).toBe("E2E test message");
    });

    test("incremental push appends content", async () => {
      // Push more content
      const response = await fetch(`${API_BASE}/sessions/${sessionId}/push`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          from_line: 2,
          append_data:
            '{"type": "assistant", "message": {"content": "Response from assistant"}}',
          source: {
            machine_id: "e2e-test-machine",
            machine_name: "E2E Test",
            platform: "darwin",
            original_path: "/tmp/e2e-test",
          },
        }),
      });

      expect(response.ok).toBe(true);

      // Verify total lines
      const pullResponse = await fetch(
        `${API_BASE}/sessions/${sessionId}/pull`
      );
      const data = await pullResponse.json();
      expect(data.meta.total_lines).toBe(2);
    });

    test("lists session in list endpoint", async () => {
      const response = await fetch(`${API_BASE}/sessions`);
      expect(response.ok).toBe(true);

      const data = await response.json();
      const found = data.sessions.find(
        (s: { session_id: string }) => s.session_id === sessionId
      );
      expect(found).toBeDefined();
    });

    test("gets session detail", async () => {
      const response = await fetch(`${API_BASE}/sessions/${sessionId}`);
      expect(response.ok).toBe(true);

      const data = await response.json();
      expect(data.session.session_id).toBe(sessionId);
      expect(data.segments.length).toBeGreaterThan(0);
    });

    test("deletes session", async () => {
      const response = await fetch(`${API_BASE}/sessions/${sessionId}`, {
        method: "DELETE",
      });
      expect(response.ok).toBe(true);

      // Verify deleted
      const pullResponse = await fetch(
        `${API_BASE}/sessions/${sessionId}/pull`
      );
      expect(pullResponse.status).toBe(404);
    });
  });

  describe("Conflict Resolution", () => {
    const conflictSessionId = `e2e-conflict-${Date.now()}`;

    test("handles last-write-wins conflict", async () => {
      // Initial push from Machine A
      await fetch(`${API_BASE}/sessions/${conflictSessionId}/push`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          from_line: 1,
          append_data: '{"line": 1}\n{"line": 2}\n{"line": 3}\n{"line": 4}\n{"line": 5}',
          source: {
            machine_id: "machine-A",
            machine_name: "Machine A",
            platform: "darwin",
            original_path: "/path/a",
          },
        }),
      });

      // Conflicting push from Machine B (overwrites from line 3)
      const conflictResponse = await fetch(
        `${API_BASE}/sessions/${conflictSessionId}/push`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            from_line: 3,
            append_data: '{"new_line": 3}\n{"new_line": 4}\n{"new_line": 5}\n{"new_line": 6}',
            source: {
              machine_id: "machine-B",
              machine_name: "Machine B",
              platform: "linux",
              original_path: "/path/b",
            },
          }),
        }
      );

      expect(conflictResponse.ok).toBe(true);

      // Verify result
      const pullResponse = await fetch(
        `${API_BASE}/sessions/${conflictSessionId}/pull`
      );
      const data = await pullResponse.json();

      // Should have 2 lines from A + 4 lines from B = 6 total
      expect(data.meta.total_lines).toBe(6);

      // Verify segments
      const detailResponse = await fetch(
        `${API_BASE}/sessions/${conflictSessionId}`
      );
      const detailData = await detailResponse.json();

      expect(detailData.segments.length).toBe(2);
      expect(detailData.segments[0].machine_name).toBe("Machine A");
      expect(detailData.segments[0].to_line).toBe(2);
      expect(detailData.segments[1].machine_name).toBe("Machine B");

      // Cleanup
      await fetch(`${API_BASE}/sessions/${conflictSessionId}`, {
        method: "DELETE",
      });
    });
  });

  describe("Search Functionality", () => {
    const searchSessionId = `e2e-search-${Date.now()}`;

    test("creates session with searchable content", async () => {
      await fetch(`${API_BASE}/sessions/${searchSessionId}/push`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          from_line: 1,
          append_data:
            '{"type": "human", "message": {"content": "unique_search_term_xyz"}}',
          source: {
            machine_id: "search-test",
            machine_name: "Search Test",
            platform: "darwin",
            original_path: "/search/test",
          },
        }),
      });
    });

    test("finds session via search", async () => {
      const response = await fetch(
        `${API_BASE}/sessions?q=unique_search_term_xyz`
      );
      expect(response.ok).toBe(true);

      const data = await response.json();
      const found = data.sessions.find(
        (s: { session_id: string }) => s.session_id === searchSessionId
      );
      expect(found).toBeDefined();

      // Cleanup
      await fetch(`${API_BASE}/sessions/${searchSessionId}`, {
        method: "DELETE",
      });
    });
  });
});
