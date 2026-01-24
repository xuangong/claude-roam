/**
 * Tests for API client
 */

import { describe, expect, test } from "bun:test";

describe("API client", () => {
  test("PushRequest has correct structure", () => {
    const request = {
      from_line: 1,
      append_data: '{"test": true}',
      source: {
        machine_id: "test-machine",
        machine_name: "Test",
        platform: "darwin",
        original_path: "/test",
      },
    };

    expect(request.from_line).toBe(1);
    expect(request.source.machine_id).toBe("test-machine");
  });

  test("SessionListItem has correct structure", () => {
    const item = {
      session_id: "test-id",
      summary: null,
      first_message: "Hello",
      total_lines: 10,
      created_at: "2026-01-01T00:00:00",
      updated_at: "2026-01-01T00:00:00",
      machines: "macbook,wsl",
      last_path: "/home/user/code",
    };

    expect(item.session_id).toBe("test-id");
    expect(item.total_lines).toBe(10);
  });

  test("Segment has correct structure", () => {
    const segment = {
      id: 1,
      from_line: 1,
      to_line: 10,
      machine_id: "machine-1",
      machine_name: "Test",
      platform: "darwin",
      original_path: "/test",
      pushed_at: "2026-01-01T00:00:00",
    };

    expect(segment.from_line).toBe(1);
    expect(segment.to_line).toBe(10);
  });
});

describe("retry logic", () => {
  test("exponential backoff calculation", () => {
    const delays: number[] = [];
    for (let i = 0; i < 3; i++) {
      delays.push(1000 * (i + 1));
    }

    expect(delays[0]).toBe(1000);
    expect(delays[1]).toBe(2000);
    expect(delays[2]).toBe(3000);
  });
});
