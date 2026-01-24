/**
 * Additional tests for path utilities to increase coverage
 */

import { describe, expect, test } from "bun:test";
import {
  detectPlatform,
  getClaudeProjectsDir,
  getSessionTargetDir,
  getSessionFilePath,
} from "../path";
import * as os from "node:os";
import * as path from "node:path";

describe("getClaudeProjectsDir", () => {
  test("returns correct path on current platform", () => {
    const projectsDir = getClaudeProjectsDir();
    expect(projectsDir).toContain(".claude");
    expect(projectsDir).toContain("projects");
    expect(projectsDir).toBe(path.join(os.homedir(), ".claude", "projects"));
  });
});

describe("getSessionTargetDir", () => {
  test("encodes current directory correctly", () => {
    const targetDir = getSessionTargetDir("/tmp/test");
    expect(targetDir).toContain(".claude/projects");
    expect(targetDir).toContain("-tmp-test");
  });

  test("handles relative path by resolving it", () => {
    const targetDir = getSessionTargetDir(".");
    expect(targetDir).toContain(".claude/projects");
  });
});

describe("getSessionFilePath", () => {
  test("returns correct file path", () => {
    const filePath = getSessionFilePath("test-session-123", "/tmp/test");
    expect(filePath).toContain("test-session-123.jsonl");
    expect(filePath).toContain("-tmp-test");
  });
});

describe("detectPlatform", () => {
  test("returns current platform", () => {
    const platform = detectPlatform();
    // On macOS it should be darwin
    if (process.platform === "darwin") {
      expect(platform).toBe("darwin");
    } else if (process.platform === "win32") {
      expect(platform).toBe("win32");
    } else {
      // Linux or WSL
      expect(["linux", "wsl"]).toContain(platform);
    }
  });
});
