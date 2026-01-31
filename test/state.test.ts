import { expect, test, describe, beforeEach } from "bun:test";
import {
  setCallState,
  getCallState,
  deleteCallState,
  setSessionMainCommand,
  getSessionMainCommand,
  setPendingReturn,
  getPendingReturn,
  deletePendingReturn,
  setReturnState,
  getReturnState,
  deleteReturnState,
  setSubtaskParent,
  getSubtaskParent,
  setSubtaskResult,
  getSubtaskResult,
  cleanupSession,
  markReturnExecuted,
  hasExecutedReturn,
} from "../src/state";

describe("State Management", () => {
  test("should manage call state", () => {
    const callID = "call-123";
    setCallState(callID, "mycmd");
    expect(getCallState(callID)).toBe("mycmd");
    deleteCallState(callID);
    expect(getCallState(callID)).toBeUndefined();
  });

  test("should manage session main command", () => {
    const sid = "session-123";
    setSessionMainCommand(sid, "maincmd");
    expect(getSessionMainCommand(sid)).toBe("maincmd");
  });

  test("should manage pending returns", () => {
    const sid = "session-456";
    setPendingReturn(sid, "prompt 1");
    expect(getPendingReturn(sid)).toBe("prompt 1");
    deletePendingReturn(sid);
    expect(getPendingReturn(sid)).toBeUndefined();
  });

  test("should manage subtask results", () => {
    const sid = "parent-sid";
    setSubtaskResult(sid, "res1", "value 1");
    expect(getSubtaskResult(sid, "res1")).toBe("value 1");
  });

  test("should manage return deduplication", () => {
    const key = "session:prompt";
    expect(hasExecutedReturn(key)).toBe(false);
    markReturnExecuted(key);
    expect(hasExecutedReturn(key)).toBe(true);
  });

  test("should cleanup session completely", () => {
    const sid = "cleanup-sid";
    const childSid = "child-sid";

    setSessionMainCommand(sid, "cmd");
    setPendingReturn(sid, "ret");
    setReturnState(sid, ["ret2"]);
    setSubtaskParent(childSid, sid);
    setSubtaskResult(sid, "res", "val");
    markReturnExecuted(`${sid}:something`);

    cleanupSession(sid);

    expect(getSessionMainCommand(sid)).toBeUndefined();
    expect(getPendingReturn(sid)).toBeUndefined();
    expect(getReturnState(sid)).toBeUndefined();
    expect(getSubtaskParent(childSid)).toBeUndefined();
    expect(getSubtaskResult(sid, "res")).toBeUndefined();
    expect(hasExecutedReturn(`${sid}:something`)).toBe(false);
  });
});
