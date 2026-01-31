import { expect, test, describe, mock, beforeEach } from "bun:test";
import { resolveResults } from "../src/features/results";
import { resolveTurns, setClient } from "../src/features/turns";
import { setSubtaskResult, cleanupSession } from "../src/state";

describe("Features: $RESULT Resolution", () => {
  const sid = "session-result";

  beforeEach(() => {
    cleanupSession(sid);
  });

  test("should resolve existing results", () => {
    setSubtaskResult(sid, "analysis", "The code is fine");
    const text = "Based on $RESULT[analysis], we can proceed";
    expect(resolveResults(text, sid)).toBe(
      "Based on The code is fine, we can proceed"
    );
  });

  test("should handle missing results", () => {
    const text = "Result: $RESULT[missing]";
    expect(resolveResults(text, sid)).toBe(
      "Result: [Result 'missing' not found]"
    );
  });

  test("should handle multiple results", () => {
    setSubtaskResult(sid, "r1", "one");
    setSubtaskResult(sid, "r2", "two");
    const text = "$RESULT[r1] and $RESULT[r2]";
    expect(resolveResults(text, sid)).toBe("one and two");
  });
});

describe("Features: $TURN Resolution", () => {
  const sid = "session-turns";

  const mockMessages = [
    {
      info: { role: "user" },
      parts: [{ type: "text", text: "Hello" }],
    },
    {
      info: { role: "assistant" },
      parts: [{ type: "text", text: "Hi there" }],
    },
    {
      info: { role: "user" },
      parts: [{ type: "text", text: "What time is it?" }],
    },
    {
      info: { role: "assistant" },
      parts: [
        { type: "text", text: "It is noon" },
        {
          type: "tool-invocation",
          tool: { name: "task" },
          input: { description: "check clock" },
          state: { output: "Clock says 12:00" },
        },
      ],
    },
  ];

  const mockClient = {
    session: {
      messages: mock(async () => ({ data: mockMessages })),
    },
  };

  beforeEach(() => {
    setClient(mockClient);
  });

  test("should resolve $TURN[1]", async () => {
    const text = "Last turn: $TURN[1]";
    const resolved = await resolveTurns(text, sid);
    expect(resolved).toContain("--- ASSISTANT (TASK: check clock) ---");
    expect(resolved).toContain("Clock says 12:00");
  });

  test("should resolve $TURN[2]", async () => {
    const text = "$TURN[2]";
    const resolved = await resolveTurns(text, sid);
    expect(resolved).toContain("--- ASSISTANT ---");
    expect(resolved).toContain("It is noon");
    expect(resolved).toContain("--- ASSISTANT (TASK: check clock) ---");
  });

  test("should resolve $TURN[*]", async () => {
    const resolved = await resolveTurns("$TURN[*]", sid);
    expect(resolved).toContain("--- USER ---");
    expect(resolved).toContain("Hello");
  });

  test("should resolve $TURN[:4]", async () => {
    const resolved = await resolveTurns("$TURN[:4]", sid);
    expect(resolved).toContain("Hello");
  });
});
