import {
  getConfigs,
  setSessionMainCommand,
  getSessionMainCommand,
  setCallState,
  deleteCallState,
  getCallState,
  setReturnState,
  setPipedArgsQueue,
  setFirstReturnPrompt,
  deletePendingNonSubtaskReturns,
  setPendingReturn,
  hasPendingReturn,
  consumePendingParentForPrompt,
  setSubtaskParentSession,
  deleteSubtaskParentSession,
  getSubtaskParentSession,
  pushReturnStack,
  setHasActiveSubtask,
  consumePendingResultCaptureByPrompt,
  registerPendingResultCapture,
  registerPendingResultCaptureByPrompt,
  getPendingResultCapture,
  captureSubtaskResult,
  setDeferredReturnPrompt,
} from "../core/state";
import { getConfig } from "../commands/resolver";
import { log } from "../utils/logger";
import { hasTurnReferences } from "../parsing";
import { resolveTurnReferences } from "../features/turns";
import {
  getLoopState,
  setPendingEvaluation,
  clearLoop,
  clearPendingEvaluation,
  isMaxIterationsReached,
} from "../loop";

/**
 * Hook: tool.execute.before
 * Handles task tool initialization and $TURN resolution
 */
export async function toolExecuteBefore(input: any, output: any) {
  if (input.tool !== "task") return;

  const taskSession =
    output?.state?.sessionID ?? output?.state?.sessionId ?? input.sessionID;

  // Mark that we have an active subtask (for generic return replacement)
  setHasActiveSubtask(true);

  const cmd = output.args?.command;
  const prompt = output.args?.prompt;
  const description = output.args?.description;
  const configs = getConfigs();
  let mainCmd = getSessionMainCommand(input.sessionID);

  // Look up parent session by prompt content (race-safe approach)
  const pendingParentSession = prompt
    ? consumePendingParentForPrompt(prompt)
    : null;

  log(
    `tool.before: taskSession=${taskSession}, prompt="${prompt?.substring(0, 30) || "(none)"}...", pendingParentSession=${pendingParentSession || "NOT FOUND"}`
  );

  // Track parent session for inline subtasks (so tool.execute.after can find the loop state)
  if (pendingParentSession && pendingParentSession !== taskSession) {
    setSubtaskParentSession(taskSession, pendingParentSession);
    log(
      `tool.before: mapped subtask ${taskSession} -> parent ${pendingParentSession}`
    );
  }

  // Check for pending result capture (as: override)
  // NOTE: We no longer consume here - session.idle will handle inline subtask captures
  // because output.state is undefined for inline subtasks in tool.after
  if (prompt) {
    const pendingCapture = consumePendingResultCaptureByPrompt(prompt);
    if (pendingCapture) {
      // Re-register by prompt so session.idle can match it
      // We also register by session for non-inline subtasks that have output.state
      registerPendingResultCapture(
        taskSession,
        pendingCapture.parentSessionID,
        pendingCapture.name
      );
      // Re-register by prompt for session.idle to match inline subtasks
      registerPendingResultCaptureByPrompt(
        prompt,
        pendingCapture.parentSessionID,
        pendingCapture.name
      );
      log(
        `tool.before: registered result capture for session ${taskSession} as "${pendingCapture.name}"`
      );
    }
  }

  log(
    `tool.before: callID=${
      input.callID
    }, cmd=${cmd}, desc="${description?.substring(0, 30)}", mainCmd=${mainCmd}`
  );

  // If mainCmd is not set (command.execute.before didn't fire - no PR),
  // set the first subtask command as the main command
  if (!mainCmd && cmd && getConfig(configs, cmd)) {
    setSessionMainCommand(input.sessionID, cmd);
    mainCmd = cmd;
    const cmdConfig = getConfig(configs, cmd)!;

    // Parse piped args from prompt if present (fallback for non-PR)
    if (prompt && prompt.includes("||")) {
      const pipeMatch = prompt.match(/\|\|(.+)/);
      if (pipeMatch) {
        const pipedPart = pipeMatch[1];
        const pipedArgs = pipedPart
          .split("||")
          .map((s: string) => s.trim())
          .filter(Boolean);
        if (pipedArgs.length) {
          setPipedArgsQueue(input.sessionID, pipedArgs);
          output.args.prompt = prompt.replace(/\s*\|\|.+$/, "").trim();
        }
      }
    }

    // Also set up return state since command.execute.before didn't run
    // Only do this once per session
    if (cmdConfig.return.length > 0) {
      // Store the first return prompt (replaces "Summarize..." in $TURN)
      setFirstReturnPrompt(input.sessionID, cmdConfig.return[0]);
      if (cmdConfig.return.length > 1) {
        setReturnState(input.sessionID, [...cmdConfig.return.slice(1)]);
        log(`Set returnState: ${cmdConfig.return.slice(1).length} items`);
      }
    }
  }

  // Resolve $TURN[n] in the prompt for ANY subtask
  // Use parent session if this command was triggered via executeReturn
  if (prompt && hasTurnReferences(prompt)) {
    const resolveFromSession = pendingParentSession || input.sessionID;
    log(
      `tool.execute.before: resolving $TURN in prompt (from ${
        pendingParentSession ? "parent" : "current"
      } session ${resolveFromSession})`
    );
    output.args.prompt = await resolveTurnReferences(
      prompt,
      resolveFromSession
    );
    log(
      `tool.execute.before: resolved prompt (${output.args.prompt.length} chars)`
    );
    // Note: consumePendingParentForPrompt already removed the entry
  }

  if (cmd && getConfig(configs, cmd)) {
    const cmdConfig = getConfig(configs, cmd)!;
    if (cmd === mainCmd) {
      deletePendingNonSubtaskReturns(input.sessionID);
    }

    setCallState(input.callID, cmd);

    if (cmd === mainCmd && cmdConfig.return.length > 1) {
      setReturnState(input.sessionID, [...cmdConfig.return.slice(1)]);
    }
  }
}

/**
 * Hook: tool.execute.after
 * Handles task completion, loop evaluation setup, and return triggers
 */
export async function toolExecuteAfter(input: any, output: any) {
  if (input.tool !== "task") return;
  const taskSession =
    output?.state?.sessionID ?? output?.state?.sessionId ?? input.sessionID;
  const cmd = getCallState(input.callID);

  log(`tool.after: callID=${input.callID}, cmd=${cmd}, wasTracked=${!!cmd}`);

  // Check for active retry loop - inline subtasks have cmd=undefined
  // For inline subtasks, the loop state is on the PARENT session, not the subtask session
  const parentSession = getSubtaskParentSession(taskSession);
  const loopSession = parentSession || taskSession;
  const retryLoop = getLoopState(loopSession);
  const isInlineLoopIteration = retryLoop?.commandName === "_inline_subtask_";
  const returnSession = isInlineLoopIteration ? loopSession : taskSession;

  log(
    `tool.after: parentSession=${parentSession}, loopSession=${loopSession}, hasLoop=${!!retryLoop}, isInlineLoop=${isInlineLoopIteration}`
  );

  // Check if this is a frontmatter loop iteration (cmd may be undefined for subtask:true commands)
  const isFrontmatterLoop =
    retryLoop && retryLoop.commandName !== "_inline_subtask_";

  const pendingCapture = getPendingResultCapture(taskSession);

  if (!cmd && !isInlineLoopIteration && !isFrontmatterLoop && !pendingCapture) {
    // Already processed or not our command (and not a loop iteration)
    return;
  }
  if (cmd) {
    deleteCallState(input.callID);
  }
  // Clean up parent session mapping
  if (parentSession) {
    deleteSubtaskParentSession(taskSession);
  }

  // Capture result if this subtask has an `as:` name
  // IMPORTANT: Only use output.state.output - don't scan messages as that would
  // pick up results from other subtasks in the same parent session
  if (pendingCapture) {
    log(`tool.after: output.state = ${JSON.stringify(output?.state)}`);
    const direct = output?.state?.output;
    if (typeof direct === "string") {
      const resultText = direct
        .replace(/<task_metadata>[\s\S]*?<\/task_metadata>/g, "")
        .trim();
      if (resultText) {
        captureSubtaskResult(taskSession, resultText);
        log(
          `tool.after: captured result for "${pendingCapture.name}" (${resultText.length} chars)`
        );
      } else {
        log(`tool.after: output.state.output was empty after cleanup`);
      }
    } else {
      log(
        `tool.after: no output.state.output for "${pendingCapture.name}" capture`
      );
    }
  }

  const mainCmd =
    getSessionMainCommand(loopSession) ||
    getSessionMainCommand(input.sessionID);
  const configs = getConfigs();
  const cmdConfig = cmd ? getConfig(configs, cmd) : undefined;
  const loopCommandName = cmd || mainCmd;
  const loopCommandConfig = loopCommandName
    ? getConfig(configs, loopCommandName)
    : undefined;

  log(
    `tool.after: cmd=${cmd}, mainCmd=${mainCmd}, isMain=${
      cmd === mainCmd
    }, hasReturn=${!!cmdConfig?.return?.length}, isInlineLoop=${isInlineLoopIteration}`
  );

  // For inline subtasks, cmd is undefined but commandName is "_inline_subtask_"
  // For frontmatter loops on subtask:true commands, cmd may be undefined but mainCmd matches
  const isLoopIteration =
    retryLoop &&
    (cmd === retryLoop.commandName ||
      mainCmd === retryLoop.commandName ||
      isInlineLoopIteration);

  if (isLoopIteration) {
    log(
      `retry: completed iteration ${retryLoop.iteration}/${retryLoop.config.max}`
    );

    // Check if max iterations reached
    if (isMaxIterationsReached(loopSession)) {
      log(`retry: MAX ITERATIONS reached (${retryLoop.config.max}), stopping`);
      if (retryLoop.deferredReturns?.length) {
        pushReturnStack(returnSession, [...retryLoop.deferredReturns]);
        log(
          `retry: queued ${retryLoop.deferredReturns.length} deferred returns after max iterations`
        );
      }
      clearLoop(loopSession);
      clearPendingEvaluation(loopSession);
      // Continue with normal return flow
    } else {
      // Store state for evaluation - main LLM will decide if we continue
      setPendingEvaluation(loopSession, { ...retryLoop });
      log(
        `retry: pending evaluation for condition "${retryLoop.config.until}"`
      );
      // The evaluation prompt will be injected via pendingReturns
    }
  }

  // For inline loops, set pendingReturn on the parent session after loop completes
  const firstReturn = loopCommandConfig?.return?.[0];

  if (firstReturn && isLoopIteration) {
    setDeferredReturnPrompt(returnSession, firstReturn);
    log(`Deferred return prompt until loop completes`);
  } else if (cmd && cmd === mainCmd && firstReturn) {
    // Only set pendingReturn if we haven't already (dedup check)
    if (!hasPendingReturn(returnSession)) {
      log(`Setting pendingReturn: ${firstReturn.substring(0, 50)}...`);
      setPendingReturn(returnSession, firstReturn);
    } else {
      log(`Skipping duplicate main command - pendingReturn already set`);
    }
  } else if (cmd && cmd !== mainCmd) {
    log(`task.after: ${cmd} (parallel of ${mainCmd})`);
  }
}
