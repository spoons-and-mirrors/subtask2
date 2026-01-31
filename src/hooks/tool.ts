// tool.execute.before and tool.execute.after hooks
import {
  log,
  setCallState,
  getCallState,
  deleteCallState,
  setSubtaskParent,
  getPendingCaptureByParent,
  deletePendingCaptureByParent,
  setSubtaskResult,
  setPendingReturn,
  getReturnState,
  setReturnState,
  deleteReturnState,
} from "../state";

export const toolExecuteBefore = async (input: any, output: any) => {
  const tool = input.tool;

  // Only process task tool
  if (tool !== "task") return output;

  log("tool.execute.before", tool);

  const callID = input.callID;
  const sessionID = input.sessionID;

  // Store call mapping: callID → parent sessionID
  setCallState(callID, sessionID);

  return output;
};

export const toolExecuteAfter = async (input: any, output: any) => {
  const tool = input.tool;

  // Only process task tool
  if (tool !== "task") return output;

  log("tool.execute.after", tool);

  const callID = input.callID;
  const parentSessionID = getCallState(callID);

  if (!parentSessionID) {
    log("No parent session found for call", callID);
    return output;
  }

  // Clean up call state
  deleteCallState(callID);

  // Get subtask session ID from output
  const subtaskSessionID = output?.state?.sessionID;

  if (subtaskSessionID) {
    // Map subtask to parent
    setSubtaskParent(subtaskSessionID, parentSessionID);
  }

  // Check if there's a pending result capture for the parent session
  const captureName = getPendingCaptureByParent(parentSessionID);
  if (captureName) {
    // Get the result from output (allow empty strings)
    const result = output?.state?.output ?? output?.title ?? "";
    if (typeof result === "string") {
      setSubtaskResult(parentSessionID, captureName, result);
      log("Captured result:", captureName);
    }
    deletePendingCaptureByParent(parentSessionID);
  }

  // Handle first return - shift from returnState to pendingReturns
  const returns = getReturnState(parentSessionID);
  log(
    "tool.after checking returns for",
    parentSessionID,
    "found:",
    returns?.length ?? 0
  );

  if (returns && returns.length > 0) {
    const firstReturn = returns.shift()!;
    log("Setting pendingReturn:", firstReturn.slice(0, 50));
    setPendingReturn(parentSessionID, firstReturn);

    if (returns.length === 0) {
      // Clean up empty array properly
      deleteReturnState(parentSessionID);
    } else {
      setReturnState(parentSessionID, returns);
    }
  }

  return output;
};
