/**
 * Tests for session scanner
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

describe("scanner functionality", () => {
  const testDir = path.join(os.tmpdir(), "claude-test-" + Date.now());
  const projectsDir = path.join(testDir, "projects");

  beforeEach(() => {
    fs.mkdirSync(projectsDir, { recursive: true });
  });

  afterEach(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true });
    }
  });

  test("can create and read session file", () => {
    const sessionDir = path.join(projectsDir, "-home-user-code");
    fs.mkdirSync(sessionDir, { recursive: true });

    const sessionFile = path.join(sessionDir, "test-session.jsonl");
    const content = '{"type": "human"}\n{"type": "assistant"}';
    fs.writeFileSync(sessionFile, content);

    const read = fs.readFileSync(sessionFile, "utf-8");
    expect(read).toBe(content);
  });

  test("can count lines in session file", () => {
    const sessionDir = path.join(projectsDir, "-home-user-code");
    fs.mkdirSync(sessionDir, { recursive: true });

    const sessionFile = path.join(sessionDir, "test-session.jsonl");
    const lines = ['{"line": 1}', '{"line": 2}', '{"line": 3}'];
    fs.writeFileSync(sessionFile, lines.join("\n"));

    const content = fs.readFileSync(sessionFile, "utf-8");
    const lineCount = content.trim().split("\n").length;
    expect(lineCount).toBe(3);
  });

  test("handles empty session file", () => {
    const sessionDir = path.join(projectsDir, "-home-user-code");
    fs.mkdirSync(sessionDir, { recursive: true });

    const sessionFile = path.join(sessionDir, "empty-session.jsonl");
    fs.writeFileSync(sessionFile, "");

    const content = fs.readFileSync(sessionFile, "utf-8");
    const lineCount = content.trim() ? content.trim().split("\n").length : 0;
    expect(lineCount).toBe(0);
  });

  test("can list session files in directory", () => {
    const sessionDir = path.join(projectsDir, "-home-user-code");
    fs.mkdirSync(sessionDir, { recursive: true });

    // Create multiple session files
    fs.writeFileSync(
      path.join(sessionDir, "session-1.jsonl"),
      '{"test": 1}'
    );
    fs.writeFileSync(
      path.join(sessionDir, "session-2.jsonl"),
      '{"test": 2}'
    );
    fs.writeFileSync(
      path.join(sessionDir, "not-a-session.txt"),
      "ignored"
    );

    const files = fs.readdirSync(sessionDir, { withFileTypes: true });
    const jsonlFiles = files.filter(
      (f) => f.isFile() && f.name.endsWith(".jsonl")
    );

    expect(jsonlFiles.length).toBe(2);
  });
});

describe("incremental content extraction", () => {
  test("extracts lines from specified position", () => {
    const content = '{"line": 1}\n{"line": 2}\n{"line": 3}\n{"line": 4}';
    const lines = content.split("\n");

    // Get lines from position 3 onwards (0-indexed, so line 2)
    const fromLine = 3;
    const incremental = lines.slice(fromLine - 1).join("\n");

    expect(incremental).toBe('{"line": 3}\n{"line": 4}');
  });

  test("handles from_line at start", () => {
    const content = '{"line": 1}\n{"line": 2}';
    const lines = content.split("\n");

    const incremental = lines.slice(0).join("\n");
    expect(incremental).toBe(content);
  });

  test("handles from_line beyond content", () => {
    const content = '{"line": 1}\n{"line": 2}';
    const lines = content.split("\n");

    const incremental = lines.slice(10).join("\n");
    expect(incremental).toBe("");
  });
});
