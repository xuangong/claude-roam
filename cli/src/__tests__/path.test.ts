/**
 * Tests for path utilities
 */

import { describe, expect, test } from "bun:test";
import {
  encodePathForClaude,
  decodeClaudePath,
  detectPlatform,
} from "../path";

describe("encodePathForClaude", () => {
  test("encodes Unix path correctly", () => {
    expect(encodePathForClaude("/home/user/code")).toBe("-home-user-code");
  });

  test("encodes path with nested directories", () => {
    expect(encodePathForClaude("/Users/alice/projects/myapp")).toBe(
      "-Users-alice-projects-myapp"
    );
  });

  test("encodes Windows path correctly", () => {
    expect(encodePathForClaude("C:\\Users\\alice\\code")).toBe(
      "C--Users-alice-code"
    );
  });

  test("encodes Windows path with forward slashes", () => {
    expect(encodePathForClaude("C:/Users/alice/code")).toBe(
      "C--Users-alice-code"
    );
  });

  test("handles single directory", () => {
    expect(encodePathForClaude("/tmp")).toBe("-tmp");
  });

  test("preserves hyphens in path names", () => {
    // Note: This means paths with hyphens cannot be perfectly decoded
    expect(encodePathForClaude("/home/user/my-project")).toBe("-home-user-my-project");
  });
});

describe("decodeClaudePath", () => {
  test("decodes Unix path correctly", () => {
    expect(decodeClaudePath("-home-user-code")).toBe("/home/user/code");
  });

  test("decodes nested directories", () => {
    // Path without hyphens in names
    expect(decodeClaudePath("-Users-alice-projects-myapp")).toBe(
      "/Users/alice/projects/myapp"
    );
  });

  test("decodes Windows path correctly", () => {
    expect(decodeClaudePath("C--Users-alice-code")).toBe("C:/Users/alice/code");
  });

  test("handles single directory", () => {
    expect(decodeClaudePath("-tmp")).toBe("/tmp");
  });

  test("decoding is lossy for paths with hyphens", () => {
    // This is a known limitation - hyphens in path names become slashes
    const encoded = "-home-user-my-project";
    const decoded = decodeClaudePath(encoded);
    // The hyphen becomes a slash, so this is lossy
    expect(decoded).toBe("/home/user/my/project");
  });
});

describe("detectPlatform", () => {
  test("returns a valid platform string", () => {
    const platform = detectPlatform();
    expect(["darwin", "linux", "wsl", "win32"]).toContain(platform);
  });
});

describe("path roundtrip", () => {
  test("Unix paths without hyphens encode and decode correctly", () => {
    const original = "/home/user/myproject";
    const encoded = encodePathForClaude(original);
    const decoded = decodeClaudePath(encoded);
    expect(decoded).toBe(original);
  });

  test("Windows paths without hyphens encode and decode correctly", () => {
    const original = "C:/Users/alice/code";
    const encoded = encodePathForClaude(original);
    const decoded = decodeClaudePath(encoded);
    expect(decoded).toBe(original);
  });

  test("paths with hyphens do not roundtrip perfectly", () => {
    // This documents the known limitation
    const original = "/home/user/my-project";
    const encoded = encodePathForClaude(original);
    const decoded = decodeClaudePath(encoded);
    // Not equal because hyphens become slashes
    expect(decoded).not.toBe(original);
  });
});
