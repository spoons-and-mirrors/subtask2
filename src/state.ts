// State management for Subtask2 plugin
// Each Map has ONE setter and ONE consumer to prevent races

// === Command Tracking ===
// Maps tool callID to command name for identification
const callState = new Map<string, string>();
// Tracks which command initiated a session
const sessionMainCommand = new Map<string, string>();

// === Return Processing ===
// First return (consumed by messages.transform)
const pendingReturns = new Map<string, string>();
// Remaining returns (consumed by text.complete)
const returnState = new Map<string, string[]>();
// Returns for non-subtask commands
const pendingNonSubtaskReturns = new Map<string, string[]>();
// Deduplication
const executedReturns = new Set<string>();

// === Parent/Child Session ===
// Maps subtask session to parent session
const subtaskParentSession = new Map<string, string>();

// === Result Capture ===
// Pending capture by parent session (set in command.before, consumed in tool.after)
const pendingCaptureByParent = new Map<string, string>(); // parentSID → captureName
// Stored results by parent session
const subtaskResults = new Map<string, Map<string, string>>();

// === Logging ===
export const log = (...args: unknown[]) => {
  if (process.env.DEBUG) {
    console.log("[subtask2]", ...args);
  }
};

// === Getters and Setters ===

// Call State
export const getCallState = (callID: string) => callState.get(callID);
export const setCallState = (callID: string, commandName: string) =>
  callState.set(callID, commandName);
export const deleteCallState = (callID: string) => callState.delete(callID);

// Session Main Command
export const getSessionMainCommand = (sessionID: string) =>
  sessionMainCommand.get(sessionID);
export const setSessionMainCommand = (sessionID: string, cmdName: string) =>
  sessionMainCommand.set(sessionID, cmdName);

// Pending Returns (first return)
export const getPendingReturn = (sessionID: string) =>
  pendingReturns.get(sessionID);
export const setPendingReturn = (sessionID: string, ret: string) =>
  pendingReturns.set(sessionID, ret);
export const deletePendingReturn = (sessionID: string) =>
  pendingReturns.delete(sessionID);

// Return State (remaining returns)
export const getReturnState = (sessionID: string) => returnState.get(sessionID);
export const setReturnState = (sessionID: string, returns: string[]) =>
  returnState.set(sessionID, returns);
export const deleteReturnState = (sessionID: string) =>
  returnState.delete(sessionID);

// Pending Non-Subtask Returns
export const getPendingNonSubtaskReturns = (sessionID: string) =>
  pendingNonSubtaskReturns.get(sessionID);
export const setPendingNonSubtaskReturns = (
  sessionID: string,
  returns: string[]
) => pendingNonSubtaskReturns.set(sessionID, returns);
export const deletePendingNonSubtaskReturns = (sessionID: string) =>
  pendingNonSubtaskReturns.delete(sessionID);

// Executed Returns (deduplication)
export const hasExecutedReturn = (key: string) => executedReturns.has(key);
export const markReturnExecuted = (key: string) => executedReturns.add(key);

// Subtask Parent Session
export const getSubtaskParent = (subtaskSID: string) =>
  subtaskParentSession.get(subtaskSID);
export const setSubtaskParent = (subtaskSID: string, parentSID: string) =>
  subtaskParentSession.set(subtaskSID, parentSID);

// Pending Capture By Parent (simpler approach)
export const getPendingCaptureByParent = (parentSID: string) =>
  pendingCaptureByParent.get(parentSID);
export const setPendingCaptureByParent = (parentSID: string, name: string) =>
  pendingCaptureByParent.set(parentSID, name);
export const deletePendingCaptureByParent = (parentSID: string) =>
  pendingCaptureByParent.delete(parentSID);

// Subtask Results
export const getSubtaskResult = (parentSID: string, name: string) =>
  subtaskResults.get(parentSID)?.get(name);
export const setSubtaskResult = (
  parentSID: string,
  name: string,
  result: string
) => {
  if (!subtaskResults.has(parentSID)) {
    subtaskResults.set(parentSID, new Map());
  }
  subtaskResults.get(parentSID)!.set(name, result);
};
export const getSubtaskResults = (parentSID: string) =>
  subtaskResults.get(parentSID);

// === Session Cleanup ===
export const cleanupSession = (sessionID: string) => {
  log("cleanupSession", sessionID);

  returnState.delete(sessionID);
  pendingReturns.delete(sessionID);
  pendingNonSubtaskReturns.delete(sessionID);
  sessionMainCommand.delete(sessionID);
  subtaskResults.delete(sessionID);
  pendingCaptureByParent.delete(sessionID);

  // Clean subtaskParentSession entries where parent is sessionID
  for (const [child, parent] of subtaskParentSession) {
    if (parent === sessionID) {
      subtaskParentSession.delete(child);
    }
  }

  // Clean executedReturns for this session
  for (const key of executedReturns) {
    if (key.startsWith(`${sessionID}:`)) {
      executedReturns.delete(key);
    }
  }
};
