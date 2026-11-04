import { describe, it, expect, beforeEach } from "bun:test";
import {
  setClient,
  setPluginContext,
  createChildSession,
  runSessionCommand,
  promptSession,
  registerPendingResultCapture,
  getSubtaskResult,
  clearSubtaskResults,
  setConfigs,
  getPendingReturn,
} from "../../src/core/state";
import { chatMessagesTransform } from "../../src/hooks/message-hooks";
import { toolExecuteBeforeV1, toolExecuteAfterV1 } from "../../src/hooks/tool-hooks";
import { server as serverV1 } from "../../src/v1/server";
import {
  getAllPendingEvaluations,
  clearPendingEvaluation,
} from "../../src/loop";

function resetLoopState() {
  for (const sessionID of getAllPendingEvaluations().keys()) {
    clearPendingEvaluation(sessionID);
  }
}

describe("V1 SDK Contract Conformance", () => {
  beforeEach(() => {
    setPluginContext(null as any);
    setClient(null as any);
    resetLoopState();
  });

  describe("promptSession V1", () => {
    it("sends { path: { id }, body: { parts: [{ type: 'text', text }] } }", async () => {
      const calls: any[] = [];
      setClient({
        session: {
          prompt: async (args: any) => {
            calls.push(args);
            return { ok: true, data: args };
          },
        },
      } as any);

      await promptSession("sess-v1-123", "Run test command");
      expect(calls).toHaveLength(1);
      expect(calls[0]).toEqual({
        path: { id: "sess-v1-123" },
        body: {
          parts: [{ type: "text", text: "Run test command" }],
        },
      });
    });
  });

  describe("experimental.chat.messages.transform V1", () => {
    it("handles input: {} and derives sessionID from output.messages", async () => {
      const output = {
        messages: [
          {
            info: { id: "m1", sessionID: "v1-session-xyz", role: "user" },
            parts: [{ type: "text", text: "hello" }],
          },
          {
            info: { id: "m2", sessionID: "v1-session-xyz", role: "assistant" },
            parts: [{ type: "text", text: "world" }],
          },
        ],
      };

      // Call chatMessagesTransform with empty input object
      await chatMessagesTransform({}, output);

      // Verify it did not crash and gracefully processed output messages
      expect(output.messages).toHaveLength(2);
    });

    it("handles empty output.messages gracefully without throwing", async () => {
      const output = { messages: [] };
      await chatMessagesTransform({}, output);
      expect(output.messages).toHaveLength(0);
    });

    it("works via serverV1 registration handler and performs actual transformation", async () => {
      const mockClient = {
        session: {
          messages: async () => ({ data: [] }),
        },
      };
      const plugin = await serverV1({ client: mockClient as any, directory: "/tmp" });
      const transformHook = plugin["experimental.chat.messages.transform"];
      expect(typeof transformHook).toBe("function");

      const sessionID = "v1-sess-hook";
      const output = {
        messages: [
          {
            info: { id: "msg-1", sessionID, role: "user" },
            parts: [{ type: "text", text: "Summarize the task tool output above and continue with your task." }],
          },
        ],
      };

      // Set a pending return for this session to prove transform changes the message text
      const { setPendingReturn } = await import("../../src/core/state");
      setPendingReturn(sessionID, "Custom substituted return prompt");

      await transformHook({}, output);
      expect(output.messages).toHaveLength(1);
      expect(output.messages[0].parts[0].text).toBe("Custom substituted return prompt");
    });
  });

  describe("session.create V1 contract", () => {
    it("sends { body: { parentID, title } } and extracts data from response.data", async () => {
      const createCalls: any[] = [];
      setClient({
        session: {
          create: async (args: any) => {
            createCalls.push(args);
            return {
              data: {
                id: "child-session-001",
                sessionID: "child-session-001",
                parentID: args.body.parentID,
                title: args.body.title,
              },
            };
          },
        },
      } as any);

      const child = await createChildSession({
        parentID: "parent-v1",
        title: "Child V1 Task",
      });

      expect(createCalls).toHaveLength(1);
      expect(createCalls[0]).toEqual({
        body: {
          parentID: "parent-v1",
          title: "Child V1 Task",
        },
      });
      expect(child.id).toBe("child-session-001");
    });

    it("sends agent and model in body when provided", async () => {
      const createCalls: any[] = [];
      setClient({
        session: {
          create: async (args: any) => {
            createCalls.push(args);
            return {
              data: {
                id: "child-session-001",
                sessionID: "child-session-001",
                parentID: args.body.parentID,
                title: args.body.title,
                agent: args.body.agent,
                model: args.body.model,
              },
            };
          },
        },
      } as any);

      const child = await createChildSession({
        parentID: "parent-v1",
        title: "Child V1 Task",
        agent: "explore",
        model: { providerID: "anthropic", modelID: "claude-3-5-sonnet" },
      });

      expect(createCalls).toHaveLength(1);
      expect(createCalls[0]).toEqual({
        body: {
          parentID: "parent-v1",
          title: "Child V1 Task",
          agent: "explore",
          model: { providerID: "anthropic", modelID: "claude-3-5-sonnet" },
        },
      });
      expect(child.id).toBe("child-session-001");
      expect(child.agent).toBe("explore");
      expect(child.model).toEqual({
        providerID: "anthropic",
        modelID: "claude-3-5-sonnet",
      });
    });
  });

  describe("session.command V1 contract", () => {
    it("sends { path: { id }, body: { command, arguments } }", async () => {
      const commandCalls: any[] = [];
      setClient({
        session: {
          command: async (args: any) => {
            commandCalls.push(args);
            return { success: true };
          },
        },
      } as any);

      await runSessionCommand({
        sessionID: "v1-session-cmd",
        command: "custom-cmd",
        arguments: "--foo bar",
      });

      expect(commandCalls).toHaveLength(1);
      expect(commandCalls[0]).toEqual({
        path: { id: "v1-session-cmd" },
        body: {
          command: "custom-cmd",
          arguments: "--foo bar",
        },
      });
    });
  });

  describe("tool.execute.after V1 result reading", () => {
    it("reads result text from output.output and uses metadata.sessionID for child session", async () => {
      const parentSession = "parent-tool-session";
      const childSession = "child-tool-session";
      clearSubtaskResults(parentSession);

      registerPendingResultCapture(childSession, parentSession, "extractedResult");

      await toolExecuteAfterV1(
        {
          tool: "task",
          sessionID: parentSession,
          callID: "call-1",
        },
        {
          title: "Task result",
          output: "This is the final answer string from output.output",
          metadata: {
            sessionID: childSession,
          },
        }
      );

      const captured = getSubtaskResult(parentSession, "extractedResult");
      expect(captured).toBe("This is the final answer string from output.output");
    });

    it("sequential regression test: toolExecuteBeforeV1 followed by toolExecuteAfterV1 with return chain and child session result", async () => {
      const parentSession = "parent-workflow-sess";
      const childSession = "child-session-id";
      const callID = "call-seq-123";

      clearSubtaskResults(parentSession);

      setConfigs({
        "review-cmd": {
          return: ["Review complete"],
          parallel: [],
        },
      });

      // 1. Run toolExecuteBeforeV1 with command that has returns
      const beforeInput = {
        tool: "task",
        sessionID: parentSession,
        callID,
      };
      const beforeOutput = {
        args: {
          command: "review-cmd",
          prompt: "Please review the PR",
        },
      };

      // Register capture for child session under parent
      registerPendingResultCapture(childSession, parentSession, "reviewResult");

      await toolExecuteBeforeV1(beforeInput, beforeOutput);

      // 2. Run toolExecuteAfterV1 with child session output and metadata
      const afterInput = {
        tool: "task",
        sessionID: parentSession,
        callID,
      };
      const afterOutput = {
        output: "actual answer",
        metadata: {
          sessionID: childSession,
        },
      };

      await toolExecuteAfterV1(afterInput, afterOutput);

      // Verify first return is scheduled on parent session
      const pendingRet = getPendingReturn(parentSession);
      expect(pendingRet).toBe("Review complete");

      // Verify capture is stored in parent session
      const captured = getSubtaskResult(parentSession, "reviewResult");
      expect(captured).toBe("actual answer");
    });

    it("regression: parallel subtasks with as: on same parent session resolve correctly by callID", async () => {
      const parentSession = "parent-parallel-sess";
      clearSubtaskResults(parentSession);

      // Overlapping invocation: before call-A, before call-B
      const beforeInputA = {
        tool: "task",
        sessionID: parentSession,
        callID: "call-A",
      };
      const beforeOutputA = {
        args: {
          prompt: "{as:A} prompt for task A",
        },
      };

      const beforeInputB = {
        tool: "task",
        sessionID: parentSession,
        callID: "call-B",
      };
      const beforeOutputB = {
        args: {
          prompt: "{as:B} prompt for task B",
        },
      };

      await toolExecuteBeforeV1(beforeInputA, beforeOutputA);
      await toolExecuteBeforeV1(beforeInputB, beforeOutputB);

      // Completion order: call-A then call-B
      const afterInputA = {
        tool: "task",
        sessionID: parentSession,
        callID: "call-A",
      };
      const afterOutputA = {
        output: "answer-A",
        metadata: {
          sessionID: "child-session-A",
        },
      };

      const afterInputB = {
        tool: "task",
        sessionID: parentSession,
        callID: "call-B",
      };
      const afterOutputB = {
        output: "answer-B",
        metadata: {
          sessionID: "child-session-B",
        },
      };

      await toolExecuteAfterV1(afterInputA, afterOutputA);
      await toolExecuteAfterV1(afterInputB, afterOutputB);

      expect(getSubtaskResult(parentSession, "A")).toBe("answer-A");
      expect(getSubtaskResult(parentSession, "B")).toBe("answer-B");
    });

    it("regression: parallel subtasks with as: with reversed completion order (call-B then call-A)", async () => {
      const parentSession = "parent-parallel-rev-sess";
      clearSubtaskResults(parentSession);

      // Overlapping invocation: before call-A, before call-B
      const beforeInputA = {
        tool: "task",
        sessionID: parentSession,
        callID: "call-A-rev",
      };
      const beforeOutputA = {
        args: {
          prompt: "{as:A} prompt for task A",
        },
      };

      const beforeInputB = {
        tool: "task",
        sessionID: parentSession,
        callID: "call-B-rev",
      };
      const beforeOutputB = {
        args: {
          prompt: "{as:B} prompt for task B",
        },
      };

      await toolExecuteBeforeV1(beforeInputA, beforeOutputA);
      await toolExecuteBeforeV1(beforeInputB, beforeOutputB);

      // Reversed completion order: call-B finishes first, then call-A
      const afterInputB = {
        tool: "task",
        sessionID: parentSession,
        callID: "call-B-rev",
      };
      const afterOutputB = {
        output: "answer-B",
        metadata: {
          sessionID: "child-session-B",
        },
      };

      const afterInputA = {
        tool: "task",
        sessionID: parentSession,
        callID: "call-A-rev",
      };
      const afterOutputA = {
        output: "answer-A",
        metadata: {
          sessionID: "child-session-A",
        },
      };

      await toolExecuteAfterV1(afterInputB, afterOutputB);
      await toolExecuteAfterV1(afterInputA, afterOutputA);

      expect(getSubtaskResult(parentSession, "A")).toBe("answer-A");
      expect(getSubtaskResult(parentSession, "B")).toBe("answer-B");
    });
  });
});
