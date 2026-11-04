import { describe, it, expect, beforeEach } from "bun:test";
import { handleSessionIdle } from "../../src/hooks/session-idle-hook";
import {
  setClient,
  registerPendingMainSessionCapture,
  getSubtaskResult,
  clearSubtaskResults,
  setSubtaskParentSession,
  getReturnState,
  deleteReturnState,
} from "../../src/core/state";
import { startLoop, getLoopState, clearLoop } from "../../src/loop";

describe("session idle main result capture", () => {
  const sessionID = "main-session";

  beforeEach(() => {
    clearSubtaskResults(sessionID);
    clearLoop(sessionID);
    deleteReturnState(sessionID);
  });

  it("stores main session result using info.role", async () => {
    setClient({
      session: {
        messages: async () => ({
          data: [
            {
              info: { role: "assistant" },
              parts: [{ type: "text", text: "Main result" }],
            },
          ],
        }),
      },
    });

    registerPendingMainSessionCapture(sessionID, "summary");
    await handleSessionIdle(sessionID);

    expect(getSubtaskResult(sessionID, "summary")).toBe("Main result");
  });

  it("advances active loop when child session is idle and condition not met", async () => {
    const parentID = "parent-loop-session";
    const childID = "child-loop-session";
    clearLoop(parentID);

    const createdChildren: any[] = [];
    const prompted: any[] = [];

    setClient({
      session: {
        create: async (args: any) => {
          const id = `child-iter-${createdChildren.length + 2}`;
          createdChildren.push({ ...args, id });
          return { data: { id } };
        },
        prompt: async (args: any) => {
          prompted.push(args);
          return { ok: true };
        },
        messages: async () => ({
          data: [
            {
              role: "assistant",
              parts: [{ type: "text", text: "Still running, condition not met yet" }],
            },
          ],
        }),
      },
    });

    setSubtaskParentSession(childID, parentID);
    startLoop(
      parentID,
      { max: 3, until: "tests pass" },
      "_inline_subtask_",
      "run tests"
    );

    // Initial iteration was 1
    expect(getLoopState(parentID)?.iteration).toBe(1);

    // Child finishes and becomes idle
    await handleSessionIdle(childID);

    // Should have incremented iteration to 2 and created next iteration subtask
    expect(getLoopState(parentID)?.iteration).toBe(2);
    expect(createdChildren.length).toBe(1);
    expect(prompted.length).toBe(1);
  });

  it("breaks active loop when child session is idle and break condition received", async () => {
    const parentID = "parent-break-session";
    const childID = "child-break-session";
    clearLoop(parentID);
    deleteReturnState(parentID);

    const executedPrompts: any[] = [];
    setClient({
      session: {
        prompt: async (args: any) => {
          executedPrompts.push(args);
          return { ok: true };
        },
        messages: async () => ({
          data: [
            {
              role: "assistant",
              parts: [{ type: "text", text: "All tests pass! <subtask2 loop=break/>" }],
            },
          ],
        }),
      },
    });

    setSubtaskParentSession(childID, parentID);
    startLoop(
      parentID,
      { max: 5, until: "tests pass" },
      "_inline_subtask_",
      "run tests",
      undefined,
      undefined,
      ["Chained follow up prompt"]
    );

    await handleSessionIdle(childID);

    // Loop should be cleared (broken)
    expect(getLoopState(parentID)).toBeUndefined();
    // In handleSessionIdle, deferredReturns was pushed onto return stack and then Step 4C executed next from return stack!
    expect(executedPrompts.length).toBe(1);
    expect(executedPrompts[0].text || executedPrompts[0].body?.parts?.[0]?.text).toBe("Chained follow up prompt");
  });
});
