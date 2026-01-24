/**
 * Tests for UUID generation
 */

import { describe, expect, test } from "bun:test";
import { v4 } from "../uuid";

describe("v4 UUID", () => {
  test("generates valid UUID v4 format", () => {
    const uuid = v4();
    // UUID v4 format: xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
    const uuidRegex =
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    expect(uuid).toMatch(uuidRegex);
  });

  test("generates unique UUIDs", () => {
    const uuids = new Set<string>();
    for (let i = 0; i < 100; i++) {
      uuids.add(v4());
    }
    expect(uuids.size).toBe(100);
  });

  test("version byte is correct", () => {
    const uuid = v4();
    // The 13th character should be '4' (version 4)
    expect(uuid[14]).toBe("4");
  });

  test("variant byte is correct", () => {
    const uuid = v4();
    // The 19th character should be 8, 9, a, or b
    const variantChar = uuid[19].toLowerCase();
    expect(["8", "9", "a", "b"]).toContain(variantChar);
  });
});
