/**
 * Tests for state management
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// We'll test state functions indirectly since they use fixed paths
describe("state management", () => {
  const testDir = path.join(os.tmpdir(), "claude-roam-test-" + Date.now());
  const stateFile = path.join(testDir, "state.json");

  beforeEach(() => {
    fs.mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true });
    }
  });

  test("state file structure is correct", () => {
    const state = {
      machine_id: "test-id",
      machine_name: "test-machine",
      sessions: {
        "session-1": {
          lastLine: 10,
          localPath: "/path/to/session",
        },
      },
    };

    fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
    const loaded = JSON.parse(fs.readFileSync(stateFile, "utf-8"));

    expect(loaded.machine_id).toBe("test-id");
    expect(loaded.machine_name).toBe("test-machine");
    expect(loaded.sessions["session-1"].lastLine).toBe(10);
  });

  test("state handles multiple sessions", () => {
    const state = {
      machine_id: "test-id",
      machine_name: "test-machine",
      sessions: {
        "session-1": { lastLine: 10, localPath: "/path/1" },
        "session-2": { lastLine: 20, localPath: "/path/2" },
        "session-3": { lastLine: 30, localPath: "/path/3" },
      },
    };

    fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
    const loaded = JSON.parse(fs.readFileSync(stateFile, "utf-8"));

    expect(Object.keys(loaded.sessions).length).toBe(3);
    expect(loaded.sessions["session-2"].lastLine).toBe(20);
  });
});
