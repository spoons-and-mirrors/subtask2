// experimental.text.complete hook
import {
  log,
  getReturnState,
  setReturnState,
  deleteReturnState,
  getPendingNonSubtaskReturns,
  deletePendingNonSubtaskReturns,
  cleanupSession,
} from "../state";
import { executeReturn } from "../features/returns";

export const textComplete = async (input: any, output: any) => {
  const sessionID = input.sessionID;
  log("text.complete", sessionID);

  // First check for non-subtask command returns
  const nonSubtaskReturns = getPendingNonSubtaskReturns(sessionID);
  if (nonSubtaskReturns && nonSubtaskReturns.length > 0) {
    const next = nonSubtaskReturns.shift()!;

    if (nonSubtaskReturns.length === 0) {
      deletePendingNonSubtaskReturns(sessionID);
    }

    log("Executing non-subtask return:", next.slice(0, 50));
    await executeReturn(next, sessionID);
    return output;
  }

  // Check returnState for remaining returns
  const returns = getReturnState(sessionID);
  if (returns && returns.length > 0) {
    const next = returns.shift()!;

    if (returns.length === 0) {
      deleteReturnState(sessionID);
    } else {
      setReturnState(sessionID, returns);
    }

    log("Executing return:", next.slice(0, 50));
    await executeReturn(next, sessionID);
    return output;
  }

  // No more returns - check if we should cleanup
  // Only cleanup if there's no pending state for this session
  const hasPendingState =
    getReturnState(sessionID)?.length ||
    getPendingNonSubtaskReturns(sessionID)?.length;

  if (!hasPendingState) {
    cleanupSession(sessionID);
  }

  return output;
};
