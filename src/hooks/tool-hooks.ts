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
  storeSubtaskResult,
  setPendingResult,
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
 * Handles subagent / task tool initialization and $TURN resolution
 */
export async function onToolExecuteBefore(event: any): Promise<void> {
  if (event.tool !== "task" && event.tool !== "subagent") return;

  const taskSession = event.sessionID;
  const inputObj = (event.input as Record<string, any>) || {};

  // Mark that we have an active subtask (for generic return replacement)
  setHasActiveSubtask(true);

  const cmd = inputObj.command;
  const prompt = inputObj.prompt;
  const description = inputObj.description;
  const configs = getConfigs();
  let mainCmd = getSessionMainCommand(taskSession);

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
  if (prompt) {
    const pendingCapture = consumePendingResultCaptureByPrompt(prompt);
    if (pendingCapture) {
      registerPendingResultCapture(
        taskSession,
        pendingCapture.parentSessionID,
        pendingCapture.name
      );
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
      event.id
    }, cmd=${cmd}, desc="${description?.substring(0, 30)}", mainCmd=${mainCmd}`
  );

  // If mainCmd is not set, set the first subtask command as the main command
  if (!mainCmd && cmd && getConfig(configs, cmd)) {
    setSessionMainCommand(taskSession, cmd);
    mainCmd = cmd;
    const cmdConfig = getConfig(configs, cmd)!;

    // Parse piped args from prompt if present
    if (prompt && prompt.includes("||")) {
      const pipeMatch = prompt.match(/\|\|(.+)/);
      if (pipeMatch) {
        const pipedPart = pipeMatch[1];
        const pipedArgs = pipedPart
          .split("||")
          .map((s: string) => s.trim())
          .filter(Boolean);
        if (pipedArgs.length) {
          setPipedArgsQueue(taskSession, pipedArgs);
          inputObj.prompt = prompt.replace(/\s*\|\|.+$/, "").trim();
        }
      }
    }

    if (cmdConfig.return.length > 0) {
      setFirstReturnPrompt(taskSession, cmdConfig.return[0]);
      if (cmdConfig.return.length > 1) {
        setReturnState(taskSession, [...cmdConfig.return.slice(1)]);
        log(`Set returnState: ${cmdConfig.return.slice(1).length} items`);
      }
    }
  }

  // Resolve $TURN[n] in the prompt
  if (prompt && hasTurnReferences(prompt)) {
    const resolveFromSession = pendingParentSession || taskSession;
    log(
      `tool.execute.before: resolving $TURN in prompt (from ${
        pendingParentSession ? "parent" : "current"
      } session ${resolveFromSession})`
    );
    inputObj.prompt = await resolveTurnReferences(
      prompt,
      resolveFromSession
    );
    log(
      `tool.execute.before: resolved prompt (${inputObj.prompt.length} chars)`
    );
  }

  if (cmd && getConfig(configs, cmd)) {
    const cmdConfig = getConfig(configs, cmd)!;
    if (cmd === mainCmd) {
      deletePendingNonSubtaskReturns(taskSession);
    }

    setCallState(event.id, cmd);

    if (cmd === mainCmd && cmdConfig.return.length > 1) {
      setReturnState(taskSession, [...cmdConfig.return.slice(1)]);
    }
  }
}

/**
 * Hook: tool.execute.after
 * Handles task completion, loop evaluation setup, and return triggers
 */
export async function onToolExecuteAfter(event: any): Promise<void> {
  if (event.tool !== "task" && event.tool !== "subagent") return;
  if (event.status !== "completed") return;

  const taskSession = event.sessionID;
  const cmd = getCallState(event.id);

  log(`tool.after: callID=${event.id}, cmd=${cmd}, wasTracked=${!!cmd}`);

  // Check for active retry loop
  const parentSession = getSubtaskParentSession(taskSession);
  const loopSession = parentSession || taskSession;
  const retryLoop = getLoopState(loopSession);
  const isInlineLoopIteration = retryLoop?.commandName === "_inline_subtask_";
  const returnSession = isInlineLoopIteration ? loopSession : taskSession;

  log(
    `tool.after: parentSession=${parentSession}, loopSession=${loopSession}, hasLoop=${!!retryLoop}, isInlineLoop=${isInlineLoopIteration}`
  );

  const isFrontmatterLoop =
    retryLoop && retryLoop.commandName !== "_inline_subtask_";

  const pendingCapture = getPendingResultCapture(taskSession);

  if (!cmd && !isInlineLoopIteration && !isFrontmatterLoop && !pendingCapture) {
    return;
  }
  if (cmd) {
    deleteCallState(event.id);
  }
  if (parentSession) {
    deleteSubtaskParentSession(taskSession);
  }

  // Extract result
  let resultText = "";
  if (event.result) {
    if (typeof event.result.output === "string") {
      resultText = event.result.output;
    } else if (event.result.output != null) {
      resultText = JSON.stringify(event.result.output);
    } else if (typeof event.result.content === "string") {
      resultText = event.result.content;
    } else if (Array.isArray(event.result.content)) {
      resultText = event.result.content
        .map((c: any) => (typeof c === "string" ? c : c.text || JSON.stringify(c)))
        .join("\n");
    }
  }
  resultText = resultText
    .replace(/<task_metadata>[\s\S]*?<\/task_metadata>/g, "")
    .trim();

  // Capture result if this subtask has an `as:` name
  if (pendingCapture && resultText) {
    captureSubtaskResult(taskSession, resultText);
    storeSubtaskResult(pendingCapture.parentSessionID, pendingCapture.name, resultText);
    setPendingResult(pendingCapture.name, resultText, pendingCapture.parentSessionID);
    log(
      `tool.after: captured result for "${pendingCapture.name}" (${resultText.length} chars)`
    );
  }

  const mainCmd =
    getSessionMainCommand(loopSession) ||
    getSessionMainCommand(taskSession);
  const configs = getConfigs();
  const loopCommandName = cmd || mainCmd;
  const loopCommandConfig = loopCommandName
    ? getConfig(configs, loopCommandName)
    : undefined;

  log(
    `tool.after: cmd=${cmd}, mainCmd=${mainCmd}, isMain=${
      cmd === mainCmd
    }, hasReturn=${!!loopCommandConfig?.return?.length}, isInlineLoop=${isInlineLoopIteration}`
  );

  const isLoopIteration =
    retryLoop &&
    (cmd === retryLoop.commandName ||
      mainCmd === retryLoop.commandName ||
      isInlineLoopIteration);

  if (isLoopIteration) {
    log(
      `retry: completed iteration ${retryLoop.iteration}/${retryLoop.config.max}`
    );

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
    } else {
      setPendingEvaluation(loopSession, { ...retryLoop });
      log(
        `retry: pending evaluation for condition "${retryLoop.config.until}"`
      );
    }
  }

  const firstReturn = loopCommandConfig?.return?.[0];

  if (firstReturn && isLoopIteration) {
    setDeferredReturnPrompt(returnSession, firstReturn);
    log(`Deferred return prompt until loop completes`);
  } else if (cmd && cmd === mainCmd && firstReturn) {
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

// Aliases for backwards compatibility
export const toolExecuteBefore = onToolExecuteBefore;
export const toolExecuteAfter = onToolExecuteAfter;

