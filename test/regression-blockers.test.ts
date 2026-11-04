import { describe, it, expect, beforeEach } from "bun:test";
import { executeInlineSubtask, buildInlineSubtaskPart } from "../src/features/inline-subtasks";
import { chatMessagesTransform } from "../src/hooks/message-hooks";
import {
  setClient,
  setPluginContext,
  getReturnState,
  deleteReturnState,
  setPendingReturn,
  deletePendingReturn,
  getSubtaskParentSession,
  setSubtaskParentSession,
} from "../src/core/state";
import { clearLoop, setPendingEvaluation } from "../src/loop";

describe("Regression Blockers Verification", () => {
  beforeEach(() => {
    setPluginContext(null as any);
    setClient(null as any);
    deleteReturnState("parent-1");
    deleteReturnState("session-a");
    deleteReturnState("session-b");
    deletePendingReturn("session-a");
    deletePendingReturn("session-b");
    clearLoop("session-a");
    clearLoop("session-b");
    clearLoop("parent-1");
  });

  describe("Blocker 1 & 3: Inline subtask with return without loop", () => {
    it("schedules return state and registers child-to-parent mapping", async () => {
      let createdChildId = "";
      setClient({
        session: {
          create: async (args: any) => {
            createdChildId = "child-sess-456";
            return { data: { id: createdChildId } };
          },
          prompt: async () => ({ ok: true }),
        },
      });

      const parsed = {
        prompt: "Run child task",
        overrides: {
          return: ["Follow-up prompt 1", "Follow-up prompt 2"],
        },
      };

      await executeInlineSubtask(parsed, "parent-1");

      // Verify return state is saved to parent session
      const returns = getReturnState("parent-1");
      expect(returns).toEqual(["Follow-up prompt 1", "Follow-up prompt 2"]);

      // Verify child to parent session mapping is registered
      expect(getSubtaskParentSession(createdChildId)).toBe("parent-1");
    });

    it("buildInlineSubtaskPart sets return state when return present without loop", async () => {
      const parsed = {
        prompt: "Run inline V1 part",
        overrides: {
          return: ["V1 Follow-up 1", "V1 Follow-up 2"],
        },
      };

      await buildInlineSubtaskPart(parsed, "parent-1");
      const returns = getReturnState("parent-1");
      expect(returns).toEqual(["V1 Follow-up 1", "V1 Follow-up 2"]);
    });
  });

  describe("Blocker 4: Session isolation for returns (Session A vs Session B)", () => {
    it("does not inject Session A's return or evaluation into Session B's context", async () => {
      // Set pending return and loop evaluation on Session A
      setPendingReturn("session-a", "Session A Exclusive Return");
      setPendingEvaluation("session-a", {
        config: { max: 3, until: "done-a" },
        iteration: 1,
        commandName: "cmd-a",
        arguments: "",
      });

      // Output messages belonging to Session B
      const outputB = {
        messages: [
          {
            info: { id: "msg-b1", sessionID: "session-b", role: "user" },
            parts: [{ type: "text", text: "Summarize the task tool output above and continue with your task." }],
          },
        ],
      };

      // Transform messages for Session B
      await chatMessagesTransform({ sessionID: "session-b" }, outputB);

      // Session B should NOT receive Session A's return prompt or evaluation
      expect(outputB.messages[0].parts[0].text).not.toBe("Session A Exclusive Return");
      expect(outputB.messages[0].parts[0].text).not.toContain("done-a");

      // Verify Session A's pending return is still intact (not consumed by Session B)
      const { getPendingReturn: checkRetA } = await import("../src/core/state");
      expect(checkRetA("session-a")).toBe("Session A Exclusive Return");
    });
  });
});
