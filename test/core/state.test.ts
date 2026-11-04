import { describe, it, expect, beforeEach } from "bun:test";
import {
  getConfigs,
  setConfigs,
  getPluginConfig,
  setPluginConfig,
  getClient,
  setClient,
  getCallState,
  setCallState,
  deleteCallState,
  getReturnState,
  setReturnState,
  hasReturnState,
  deleteReturnState,
  pushReturnStack,
  peekReturnStack,
  popReturnStack,
  hasReturnStack,
  shiftReturnStack,
  clearReturnStack,
  getPendingReturn,
  setPendingReturn,
  hasPendingReturn,
  deletePendingReturn,
  getAllPendingReturns,
  getPendingNonSubtaskReturns,
  setPendingNonSubtaskReturns,
  deletePendingNonSubtaskReturns,
  getPipedArgsQueue,
  setPipedArgsQueue,
  deletePipedArgsQueue,
  getReturnArgsState,
  deleteReturnArgsState,
  getSessionMainCommand,
  setSessionMainCommand,
  hasProcessedS2Message,
  addProcessedS2Message,
  hasExecutedReturn,
  addExecutedReturn,
  deleteExecutedReturn,
  getFirstReturnPrompt,
  setFirstReturnPrompt,
  getSubtaskParentSession,
  setSubtaskParentSession,
  deleteSubtaskParentSession,
  registerPendingParentForPrompt,
  consumePendingParentForPrompt,
  getHasActiveSubtask,
  setHasActiveSubtask,
  getPendingModelOverride,
  setPendingModelOverride,
  deletePendingModelOverride,
  getPendingAgentOverride,
  setPendingAgentOverride,
  deletePendingAgentOverride,
  // Named subtask results
  registerPendingMainSessionCapture,
  consumePendingMainSessionCapture,
  getDeferredReturnPrompt,
  setDeferredReturnPrompt,
  consumeDeferredReturnPrompt,
  registerPendingResultCaptureByPrompt,
  consumePendingResultCaptureByPrompt,
  registerPendingResultCapture,
  getPendingResultCapture,
  captureSubtaskResult,
  getSubtaskResult,
  getAllSubtaskResults,
  storeSubtaskResult,
  resolveResultReferences,
  clearSubtaskResults,
  promptSession,
  getSessionMessages,
  setPluginContext,
  OPENCODE_GENERIC,
} from "../../src/core/state";

describe("state management", () => {
  const sessionId = "test-session";

  describe("configs", () => {
    it("sets and gets configs", () => {
      const configs = { plan: { return: ["done"], parallel: [] } };
      setConfigs(configs);
      expect(getConfigs()).toEqual(configs);
    });

    it("returns empty object initially", () => {
      setConfigs({});
      expect(getConfigs()).toEqual({});
    });
  });

  describe("pluginConfig", () => {
    it("sets and gets plugin config", () => {
      setPluginConfig({ replace_generic: true, generic_return: "custom" });
      const config = getPluginConfig();
      expect(config.replace_generic).toBe(true);
      expect(config.generic_return).toBe("custom");
    });

    it("defaults to replace_generic true", () => {
      setPluginConfig({ replace_generic: true });
      expect(getPluginConfig().replace_generic).toBe(true);
    });
  });

  describe("client", () => {
    it("sets and gets client", () => {
      const mockClient = { session: { command: () => {} } };
      setClient(mockClient);
      expect(getClient()).toBe(mockClient);
    });

    it("can set null client", () => {
      setClient(null);
      expect(getClient()).toBe(null);
    });
  });

  describe("call state", () => {
    const callId = "call-123";

    it("sets and gets call state", () => {
      setCallState(callId, "plan");
      expect(getCallState(callId)).toBe("plan");
    });

    it("deletes call state", () => {
      setCallState(callId, "cmd");
      deleteCallState(callId);
      expect(getCallState(callId)).toBeUndefined();
    });

    it("returns undefined for non-existent", () => {
      expect(getCallState("non-existent")).toBeUndefined();
    });

    it("overwrites existing call state", () => {
      setCallState(callId, "first");
      setCallState(callId, "second");
      expect(getCallState(callId)).toBe("second");
    });
  });

  describe("return state", () => {
    beforeEach(() => {
      deleteReturnState(sessionId);
    });

    it("sets and gets return state", () => {
      setReturnState(sessionId, ["step1", "step2"]);
      expect(getReturnState(sessionId)).toEqual(["step1", "step2"]);
    });

    it("hasReturnState returns correctly", () => {
      expect(hasReturnState(sessionId)).toBe(false);
      setReturnState(sessionId, ["x"]);
      expect(hasReturnState(sessionId)).toBe(true);
    });

    it("deletes return state", () => {
      setReturnState(sessionId, ["x"]);
      deleteReturnState(sessionId);
      expect(hasReturnState(sessionId)).toBe(false);
    });

    it("handles empty array", () => {
      setReturnState(sessionId, []);
      expect(getReturnState(sessionId)).toEqual([]);
      expect(hasReturnState(sessionId)).toBe(true);
    });
  });

  describe("return stack", () => {
    beforeEach(() => {
      clearReturnStack(sessionId);
    });

    it("pushes and peeks return chain", () => {
      pushReturnStack(sessionId, ["a", "b"]);
      expect(peekReturnStack(sessionId)).toEqual(["a", "b"]);
    });

    it("supports multiple stacked chains", () => {
      pushReturnStack(sessionId, ["outer1", "outer2"]);
      pushReturnStack(sessionId, ["inner1", "inner2"]);
      expect(peekReturnStack(sessionId)).toEqual(["inner1", "inner2"]);
    });

    it("pops return chain", () => {
      pushReturnStack(sessionId, ["outer"]);
      pushReturnStack(sessionId, ["inner"]);
      popReturnStack(sessionId);
      expect(peekReturnStack(sessionId)).toEqual(["outer"]);
    });

    it("hasReturnStack returns correctly", () => {
      expect(hasReturnStack(sessionId)).toBe(false);
      pushReturnStack(sessionId, ["x"]);
      expect(hasReturnStack(sessionId)).toBe(true);
    });

    it("shiftReturnStack removes first item from current chain", () => {
      pushReturnStack(sessionId, ["a", "b", "c"]);
      expect(shiftReturnStack(sessionId)).toBe("a");
      expect(peekReturnStack(sessionId)).toEqual(["b", "c"]);
    });

    it("shiftReturnStack pops chain when empty", () => {
      pushReturnStack(sessionId, ["outer"]);
      pushReturnStack(sessionId, ["only"]);
      expect(shiftReturnStack(sessionId)).toBe("only");
      expect(peekReturnStack(sessionId)).toEqual(["outer"]);
    });

    it("shiftReturnStack returns undefined when chain is already empty", () => {
      pushReturnStack(sessionId, []);
      expect(shiftReturnStack(sessionId)).toBeUndefined();
    });

    it("shiftReturnStack returns undefined when no stack", () => {
      expect(shiftReturnStack(sessionId)).toBeUndefined();
    });

    it("clearReturnStack removes all chains", () => {
      pushReturnStack(sessionId, ["a"]);
      pushReturnStack(sessionId, ["b"]);
      clearReturnStack(sessionId);
      expect(hasReturnStack(sessionId)).toBe(false);
    });

    it("popReturnStack is safe on empty stack", () => {
      expect(() => popReturnStack(sessionId)).not.toThrow();
    });

    it("popReturnStack deletes map entry when last chain removed", () => {
      pushReturnStack(sessionId, ["only"]);
      popReturnStack(sessionId);
      expect(hasReturnStack(sessionId)).toBe(false);
    });

    it("returns undefined for empty chain in stack", () => {
      pushReturnStack(sessionId, ["x"]);
      shiftReturnStack(sessionId);
      expect(peekReturnStack(sessionId)).toBeUndefined();
    });

    it("handles deeply nested stacks", () => {
      pushReturnStack(sessionId, ["level1"]);
      pushReturnStack(sessionId, ["level2"]);
      pushReturnStack(sessionId, ["level3"]);
      expect(shiftReturnStack(sessionId)).toBe("level3");
      expect(shiftReturnStack(sessionId)).toBe("level2");
      expect(shiftReturnStack(sessionId)).toBe("level1");
      expect(hasReturnStack(sessionId)).toBe(false);
    });
  });

  describe("pending returns", () => {
    beforeEach(() => {
      deletePendingReturn(sessionId);
    });

    it("sets and gets pending return", () => {
      setPendingReturn(sessionId, "Do the thing");
      expect(getPendingReturn(sessionId)).toBe("Do the thing");
    });

    it("hasPendingReturn returns correctly", () => {
      expect(hasPendingReturn(sessionId)).toBe(false);
      setPendingReturn(sessionId, "x");
      expect(hasPendingReturn(sessionId)).toBe(true);
    });

    it("deletes pending return", () => {
      setPendingReturn(sessionId, "x");
      deletePendingReturn(sessionId);
      expect(hasPendingReturn(sessionId)).toBe(false);
    });

    it("getAllPendingReturns returns iterator", () => {
      setPendingReturn(sessionId, "first");
      setPendingReturn("other-session", "second");
      const entries = Array.from(getAllPendingReturns());
      expect(entries.length).toBeGreaterThanOrEqual(2);
    });

    it("overwrites existing pending return", () => {
      setPendingReturn(sessionId, "first");
      setPendingReturn(sessionId, "second");
      expect(getPendingReturn(sessionId)).toBe("second");
    });
  });

  describe("pending non-subtask returns", () => {
    beforeEach(() => {
      deletePendingNonSubtaskReturns(sessionId);
    });

    it("sets and gets pending non-subtask returns", () => {
      setPendingNonSubtaskReturns(sessionId, ["step1", "step2"]);
      expect(getPendingNonSubtaskReturns(sessionId)).toEqual([
        "step1",
        "step2",
      ]);
    });

    it("deletes pending non-subtask returns", () => {
      setPendingNonSubtaskReturns(sessionId, ["x"]);
      deletePendingNonSubtaskReturns(sessionId);
      expect(getPendingNonSubtaskReturns(sessionId)).toBeUndefined();
    });

    it("returns undefined for non-existent", () => {
      expect(getPendingNonSubtaskReturns("non-existent")).toBeUndefined();
    });
  });

  describe("piped args queue", () => {
    beforeEach(() => {
      deletePipedArgsQueue(sessionId);
    });

    it("sets and gets piped args", () => {
      setPipedArgsQueue(sessionId, ["arg1", "arg2", "arg3"]);
      expect(getPipedArgsQueue(sessionId)).toEqual(["arg1", "arg2", "arg3"]);
    });

    it("deletes piped args", () => {
      setPipedArgsQueue(sessionId, ["x"]);
      deletePipedArgsQueue(sessionId);
      expect(getPipedArgsQueue(sessionId)).toBeUndefined();
    });

    it("handles empty array", () => {
      setPipedArgsQueue(sessionId, []);
      expect(getPipedArgsQueue(sessionId)).toEqual([]);
    });
  });

  describe("return args state (alias for piped args)", () => {
    beforeEach(() => {
      deleteReturnArgsState(sessionId);
    });

    it("returns undefined for non-existent", () => {
      expect(getReturnArgsState(sessionId)).toBeUndefined();
    });

    it("deletes return args state", () => {
      expect(() => deleteReturnArgsState(sessionId)).not.toThrow();
    });

    it("shares state with piped args queue", () => {
      setPipedArgsQueue(sessionId, ["shared"]);
      expect(getReturnArgsState(sessionId)).toEqual(["shared"]);
    });
  });

  describe("session main command", () => {
    it("sets and gets session main command", () => {
      setSessionMainCommand(sessionId, "plan");
      expect(getSessionMainCommand(sessionId)).toBe("plan");
    });

    it("returns undefined for non-existent", () => {
      expect(getSessionMainCommand("non-existent")).toBeUndefined();
    });

    it("overwrites existing command", () => {
      setSessionMainCommand(sessionId, "first");
      setSessionMainCommand(sessionId, "second");
      expect(getSessionMainCommand(sessionId)).toBe("second");
    });
  });

  describe("processed S2 messages", () => {
    const msgId = "msg-123";

    it("tracks processed messages", () => {
      expect(hasProcessedS2Message(msgId)).toBe(false);
      addProcessedS2Message(msgId);
      expect(hasProcessedS2Message(msgId)).toBe(true);
    });

    it("adding same message twice is idempotent", () => {
      addProcessedS2Message(msgId);
      addProcessedS2Message(msgId);
      expect(hasProcessedS2Message(msgId)).toBe(true);
    });
  });

  describe("executed returns", () => {
    const key = "session:return-key";

    it("tracks executed returns", () => {
      expect(hasExecutedReturn(key)).toBe(false);
      addExecutedReturn(key);
      expect(hasExecutedReturn(key)).toBe(true);
    });

    it("deletes executed return", () => {
      addExecutedReturn(key);
      deleteExecutedReturn(key);
      expect(hasExecutedReturn(key)).toBe(false);
    });

    it("delete is safe on non-existent key", () => {
      expect(() => deleteExecutedReturn("non-existent")).not.toThrow();
    });
  });

  describe("first return prompt", () => {
    it("sets and gets first return prompt", () => {
      setFirstReturnPrompt(sessionId, "Initial prompt");
      expect(getFirstReturnPrompt(sessionId)).toBe("Initial prompt");
    });

    it("returns undefined for non-existent", () => {
      expect(getFirstReturnPrompt("non-existent")).toBeUndefined();
    });

    it("overwrites existing prompt", () => {
      setFirstReturnPrompt(sessionId, "first");
      setFirstReturnPrompt(sessionId, "second");
      expect(getFirstReturnPrompt(sessionId)).toBe("second");
    });
  });

  describe("subtask parent session", () => {
    beforeEach(() => {
      deleteSubtaskParentSession(sessionId);
    });

    it("sets and gets parent session", () => {
      setSubtaskParentSession(sessionId, "parent-id");
      expect(getSubtaskParentSession(sessionId)).toBe("parent-id");
    });

    it("deletes parent session", () => {
      setSubtaskParentSession(sessionId, "parent");
      deleteSubtaskParentSession(sessionId);
      expect(getSubtaskParentSession(sessionId)).toBeUndefined();
    });

    it("returns undefined for non-existent", () => {
      expect(getSubtaskParentSession("non-existent")).toBeUndefined();
    });
  });

  describe("pending parent for prompt", () => {
    const prompt = "Do the task";
    const parentSession = "parent-123";

    it("registers and consumes parent session", () => {
      registerPendingParentForPrompt(prompt, parentSession);
      expect(consumePendingParentForPrompt(prompt)).toBe(parentSession);
    });

    it("consumes removes the mapping", () => {
      registerPendingParentForPrompt(prompt, parentSession);
      consumePendingParentForPrompt(prompt);
      expect(consumePendingParentForPrompt(prompt)).toBeNull();
    });

    it("returns null for unknown prompt", () => {
      expect(consumePendingParentForPrompt("unknown")).toBeNull();
    });

    it("overwrites existing registration", () => {
      registerPendingParentForPrompt(prompt, "first-parent");
      registerPendingParentForPrompt(prompt, "second-parent");
      expect(consumePendingParentForPrompt(prompt)).toBe("second-parent");
    });
  });

  describe("has active subtask", () => {
    it("sets and gets active subtask flag", () => {
      setHasActiveSubtask(false);
      expect(getHasActiveSubtask()).toBe(false);
      setHasActiveSubtask(true);
      expect(getHasActiveSubtask()).toBe(true);
    });

    it("toggles correctly", () => {
      setHasActiveSubtask(true);
      setHasActiveSubtask(false);
      setHasActiveSubtask(true);
      expect(getHasActiveSubtask()).toBe(true);
    });
  });

  describe("pending model override", () => {
    beforeEach(() => {
      deletePendingModelOverride(sessionId);
    });

    it("sets and gets model override", () => {
      setPendingModelOverride(sessionId, "openai/gpt-4o");
      expect(getPendingModelOverride(sessionId)).toBe("openai/gpt-4o");
    });

    it("deletes model override", () => {
      setPendingModelOverride(sessionId, "x");
      deletePendingModelOverride(sessionId);
      expect(getPendingModelOverride(sessionId)).toBeUndefined();
    });

    it("returns undefined for non-existent", () => {
      expect(getPendingModelOverride("non-existent")).toBeUndefined();
    });
  });

  describe("pending agent override", () => {
    beforeEach(() => {
      deletePendingAgentOverride(sessionId);
    });

    it("sets and gets agent override", () => {
      setPendingAgentOverride(sessionId, "explore");
      expect(getPendingAgentOverride(sessionId)).toBe("explore");
    });

    it("deletes agent override", () => {
      setPendingAgentOverride(sessionId, "x");
      deletePendingAgentOverride(sessionId);
      expect(getPendingAgentOverride(sessionId)).toBeUndefined();
    });

    it("returns undefined for non-existent", () => {
      expect(getPendingAgentOverride("non-existent")).toBeUndefined();
    });
  });

  describe("deferred return prompt", () => {
    beforeEach(() => {
      consumeDeferredReturnPrompt(sessionId);
    });

    it("sets and gets deferred return", () => {
      setDeferredReturnPrompt(sessionId, "return later");
      expect(getDeferredReturnPrompt(sessionId)).toBe("return later");
    });

    it("does not overwrite existing deferred return", () => {
      setDeferredReturnPrompt(sessionId, "first");
      setDeferredReturnPrompt(sessionId, "second");
      expect(getDeferredReturnPrompt(sessionId)).toBe("first");
    });

    it("consumes deferred return", () => {
      setDeferredReturnPrompt(sessionId, "consume me");
      expect(consumeDeferredReturnPrompt(sessionId)).toBe("consume me");
      expect(getDeferredReturnPrompt(sessionId)).toBeUndefined();
    });
  });

  // ============================================================================
  // Named Subtask Results ($RESULT[name])
  // ============================================================================

  describe("pending main session capture", () => {
    beforeEach(() => {
      consumePendingMainSessionCapture(sessionId);
    });

    it("registers and consumes capture name", () => {
      registerPendingMainSessionCapture(sessionId, "my-result");
      expect(consumePendingMainSessionCapture(sessionId)).toBe("my-result");
    });

    it("consume removes the mapping", () => {
      registerPendingMainSessionCapture(sessionId, "my-result");
      consumePendingMainSessionCapture(sessionId);
      expect(consumePendingMainSessionCapture(sessionId)).toBeUndefined();
    });

    it("returns undefined for non-existent", () => {
      expect(consumePendingMainSessionCapture("unknown")).toBeUndefined();
    });

    it("overwrites existing registration", () => {
      registerPendingMainSessionCapture(sessionId, "first");
      registerPendingMainSessionCapture(sessionId, "second");
      expect(consumePendingMainSessionCapture(sessionId)).toBe("second");
    });
  });

  describe("pending result capture by prompt", () => {
    const prompt = "Run analysis";
    const parentSession = "parent-123";

    it("registers and consumes by prompt", () => {
      registerPendingResultCaptureByPrompt(prompt, parentSession, "analysis");
      const result = consumePendingResultCaptureByPrompt(prompt);
      expect(result).toEqual({
        parentSessionID: parentSession,
        name: "analysis",
      });
    });

    it("consume removes the mapping", () => {
      registerPendingResultCaptureByPrompt(prompt, parentSession, "test");
      consumePendingResultCaptureByPrompt(prompt);
      expect(consumePendingResultCaptureByPrompt(prompt)).toBeUndefined();
    });

    it("returns undefined for unknown prompt", () => {
      expect(consumePendingResultCaptureByPrompt("unknown")).toBeUndefined();
    });

    it("overwrites existing registration", () => {
      registerPendingResultCaptureByPrompt(prompt, "parent1", "first");
      registerPendingResultCaptureByPrompt(prompt, "parent2", "second");
      const result = consumePendingResultCaptureByPrompt(prompt);
      expect(result).toEqual({ parentSessionID: "parent2", name: "second" });
    });
  });

  describe("pending result capture by session ID", () => {
    const subtaskSession = "subtask-123";
    const parentSession = "parent-456";

    beforeEach(() => {
      // Clean up by capturing if pending
      captureSubtaskResult(subtaskSession, "");
    });

    it("registers pending capture", () => {
      registerPendingResultCapture(subtaskSession, parentSession, "my-result");
      const pending = getPendingResultCapture(subtaskSession);
      expect(pending).toEqual({
        parentSessionID: parentSession,
        name: "my-result",
      });
    });

    it("returns undefined for non-existent", () => {
      expect(getPendingResultCapture("unknown")).toBeUndefined();
    });
  });

  describe("capture and retrieve subtask results", () => {
    const subtaskSession = "subtask-789";
    const parentSession = "parent-xyz";

    beforeEach(() => {
      clearSubtaskResults(parentSession);
    });

    it("captures result when pending exists", () => {
      registerPendingResultCapture(subtaskSession, parentSession, "analysis");
      captureSubtaskResult(subtaskSession, "Analysis complete: all tests pass");
      expect(getSubtaskResult(parentSession, "analysis")).toBe(
        "Analysis complete: all tests pass"
      );
    });

    it("does nothing if no pending capture", () => {
      captureSubtaskResult("unknown-session", "Some result");
      // Should not throw, just no-op
    });

    it("removes pending entry after capture", () => {
      registerPendingResultCapture(subtaskSession, parentSession, "test");
      captureSubtaskResult(subtaskSession, "Result");
      expect(getPendingResultCapture(subtaskSession)).toBeUndefined();
    });

    it("returns undefined for non-existent result name", () => {
      expect(getSubtaskResult(parentSession, "unknown")).toBeUndefined();
    });

    it("returns undefined for non-existent session", () => {
      expect(getSubtaskResult("unknown-session", "test")).toBeUndefined();
    });

    it("stores result directly for a session", () => {
      storeSubtaskResult(parentSession, "direct", "Direct result");
      expect(getSubtaskResult(parentSession, "direct")).toBe("Direct result");
    });
  });

  describe("getAllSubtaskResults", () => {
    const parentSession = "parent-results";

    beforeEach(() => {
      clearSubtaskResults(parentSession);
    });

    it("returns all results for session", () => {
      registerPendingResultCapture("sub1", parentSession, "first");
      registerPendingResultCapture("sub2", parentSession, "second");
      captureSubtaskResult("sub1", "Result 1");
      captureSubtaskResult("sub2", "Result 2");

      const results = getAllSubtaskResults(parentSession);
      expect(results).toBeDefined();
      expect(results!.get("first")).toBe("Result 1");
      expect(results!.get("second")).toBe("Result 2");
    });

    it("returns undefined for session with no results", () => {
      expect(getAllSubtaskResults("empty-session")).toBeUndefined();
    });
  });

  describe("resolveResultReferences", () => {
    const parentSession = "resolve-session";

    beforeEach(() => {
      clearSubtaskResults(parentSession);
    });

    it("resolves $RESULT[name] in text", () => {
      registerPendingResultCapture("sub1", parentSession, "plan");
      captureSubtaskResult("sub1", "Build the auth system");

      const text = "Implement based on $RESULT[plan]";
      const resolved = resolveResultReferences(text, parentSession);
      expect(resolved).toBe("Implement based on Build the auth system");
    });

    it("resolves multiple references", () => {
      registerPendingResultCapture("sub1", parentSession, "plan");
      registerPendingResultCapture("sub2", parentSession, "review");
      captureSubtaskResult("sub1", "Plan A");
      captureSubtaskResult("sub2", "Looks good");

      const text = "Combine $RESULT[plan] with feedback: $RESULT[review]";
      const resolved = resolveResultReferences(text, parentSession);
      expect(resolved).toBe("Combine Plan A with feedback: Looks good");
    });

    it("keeps unresolved references intact", () => {
      const text = "Use $RESULT[unknown] for this";
      const resolved = resolveResultReferences(text, parentSession);
      expect(resolved).toBe("Use $RESULT[unknown] for this");
    });

    it("returns original text if no results exist", () => {
      const text = "No results: $RESULT[test]";
      const resolved = resolveResultReferences(text, "no-results-session");
      expect(resolved).toBe("No results: $RESULT[test]");
    });

    it("handles text with no references", () => {
      registerPendingResultCapture("sub1", parentSession, "test");
      captureSubtaskResult("sub1", "Value");

      const text = "Plain text without references";
      const resolved = resolveResultReferences(text, parentSession);
      expect(resolved).toBe("Plain text without references");
    });
  });

  describe("clearSubtaskResults", () => {
    const parentSession = "clear-session";

    it("clears all results for session", () => {
      registerPendingResultCapture("sub1", parentSession, "test");
      captureSubtaskResult("sub1", "Value");

      expect(getSubtaskResult(parentSession, "test")).toBe("Value");
      clearSubtaskResults(parentSession);
      expect(getSubtaskResult(parentSession, "test")).toBeUndefined();
    });

    it("is safe on session with no results", () => {
      expect(() => clearSubtaskResults("empty")).not.toThrow();
    });
  });

  describe("OPENCODE_GENERIC constant", () => {
    it("is defined and non-empty", () => {
      expect(typeof OPENCODE_GENERIC).toBe("string");
      expect(OPENCODE_GENERIC.length).toBeGreaterThan(0);
    });

    it("contains expected text", () => {
      expect(OPENCODE_GENERIC).toContain("Summarize");
      expect(OPENCODE_GENERIC).toContain("task");
    });
  });

  describe("promptSession and getSessionMessages helpers", () => {
    it("works with V2 pluginContext", async () => {
      const mockCtx: any = {
        session: {
          prompt: async (args: any) => ({ prompted: true, ...args }),
          context: async (args: any) => [{ role: "assistant", text: "V2 context" }],
        },
      };
      setPluginContext(mockCtx);
      setClient(null);

      const promptRes = await promptSession("s-v2", "hello v2");
      expect(promptRes).toEqual({ prompted: true, sessionID: "s-v2", text: "hello v2" });

      const msgs = await getSessionMessages("s-v2");
      expect(msgs).toEqual([{ role: "assistant", text: "V2 context" }]);
    });

    it("works with V1 client", async () => {
      setPluginContext(null as any);
      const calls: any[] = [];
      const mockClient: any = {
        session: {
          prompt: async (args: any) => {
            calls.push(args);
            return { promptedV1: true, ...args };
          },
          messages: async (args: any) => ({ data: [{ role: "assistant", text: "V1 msg" }] }),
        },
      };
      setClient(mockClient);

      const promptRes = await promptSession("s-v1", "hello v1");
      expect(calls).toHaveLength(1);
      expect(calls[0]).toEqual({
        path: { id: "s-v1" },
        body: { parts: [{ type: "text", text: "hello v1" }] },
      });
      expect(promptRes).toEqual({
        promptedV1: true,
        path: { id: "s-v1" },
        body: { parts: [{ type: "text", text: "hello v1" }] },
      });

      const msgs = await getSessionMessages("s-v1");
      expect(msgs).toEqual([{ role: "assistant", text: "V1 msg" }]);
    });

    it("createChildSession and runSessionCommand adapt to V1 client contracts", async () => {
      setPluginContext(null as any);
      const createCalls: any[] = [];
      const commandCalls: any[] = [];
      const mockClient: any = {
        session: {
          create: async (args: any) => {
            createCalls.push(args);
            return { data: { id: "child-v1-id", title: args.body.title } };
          },
          command: async (args: any) => {
            commandCalls.push(args);
            return { ok: true, ...args };
          },
        },
      };
      setClient(mockClient);

      const { createChildSession, runSessionCommand } = await import("../../src/core/state");

      const child = await createChildSession({
        parentID: "p-1",
        title: "Test Child",
      });
      expect(createCalls).toHaveLength(1);
      expect(createCalls[0]).toEqual({
        body: { parentID: "p-1", title: "Test Child" },
      });
      expect(child.id).toBe("child-v1-id");

      const cmdRes = await runSessionCommand({
        sessionID: "s-cmd",
        command: "review",
        arguments: "arg1 arg2",
      });
      expect(commandCalls).toHaveLength(1);
      expect(commandCalls[0]).toEqual({
        path: { id: "s-cmd" },
        body: { command: "review", arguments: "arg1 arg2" },
      });
      expect(cmdRes.ok).toBe(true);
    });
  });
});
