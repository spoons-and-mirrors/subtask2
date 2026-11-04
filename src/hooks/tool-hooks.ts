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
  getPendingResultCaptureByPrompt,
  deletePendingResultCaptureByPrompt,
  registerPendingResultCapture,
  registerPendingResultCaptureByPrompt,
  registerPendingResultCaptureByCallID,
  consumePendingResultCaptureByCallID,
  clearPendingResultCapturesFor,
  getPendingResultCapture,
  captureSubtaskResult,
  storeSubtaskResult,
  setDeferredReturnPrompt,
  getClient,
} from "../core/state";
import { getConfig } from "../commands/resolver";
import { log } from "../utils/logger";
import { hasTurnReferences, parseOverridesFromArgs } from "../parsing";
import { resolveTurnReferences } from "../features/turns";
import {
  getLoopState,
  setPendingEvaluation,
  clearLoop,
  clearPendingEvaluation,
  isMaxIterationsReached,
} from "../loop";

export async function toolExecuteBeforeV1(input: any, output: any) {
  const toolName = input?.tool;
  if (toolName !== "task" && toolName !== "subagent") return;

  const taskSession =
    output?.state?.sessionID ??
    output?.state?.sessionId ??
    input?.sessionID;
  const inputObj = output?.args || {};

  setHasActiveSubtask(true);

  const cmd = inputObj.command;
  const prompt = inputObj.prompt;
  const description = inputObj.description;
  const configs = getConfigs();
  let mainCmd = getSessionMainCommand(taskSession);

  const pendingParentSession = prompt
    ? consumePendingParentForPrompt(prompt)
    : null;

  log(
    `tool.before(V1): taskSession=${taskSession}, prompt="${prompt?.substring(0, 30) || "(none)"}...", pendingParentSession=${pendingParentSession || "NOT FOUND"}`
  );

  if (pendingParentSession && pendingParentSession !== taskSession) {
    setSubtaskParentSession(taskSession, pendingParentSession);
    log(
      `tool.before(V1): mapped subtask ${taskSession} -> parent ${pendingParentSession}`
    );
  }

  const callID = input?.callID;

  if (prompt) {
    const pendingCapture = consumePendingResultCaptureByPrompt(prompt);
    let captureParentSession = pendingCapture?.parentSessionID;
    let captureName = pendingCapture?.name;

    // Also check for inline {as:name} override in prompt or description/args if not found
    if (!captureName) {
      const parsedPrompt = parseOverridesFromArgs(prompt);
      if (parsedPrompt?.overrides?.as) {
        captureName = parsedPrompt.overrides.as;
        captureParentSession = pendingParentSession || taskSession;
      }
    }

    if (captureName && captureParentSession) {
      registerPendingResultCapture(
        taskSession,
        captureParentSession,
        captureName
      );
      registerPendingResultCaptureByPrompt(
        prompt,
        captureParentSession,
        captureName
      );
      if (callID) {
        registerPendingResultCaptureByCallID(
          callID,
          captureParentSession,
          captureName
        );
      }
      log(
        `tool.before(V1): registered result capture for session ${taskSession} (callID=${callID}) as "${captureName}"`
      );
    }
  }

  log(
    `tool.before(V1): callID=${
      callID
    }, cmd=${cmd}, desc="${description?.substring(0, 30)}", mainCmd=${mainCmd}`
  );

  if (!mainCmd && cmd && getConfig(configs, cmd)) {
    setSessionMainCommand(taskSession, cmd);
    mainCmd = cmd;
    const cmdConfig = getConfig(configs, cmd)!;

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

  if (prompt && hasTurnReferences(prompt)) {
    const resolveFromSession = pendingParentSession || taskSession;
    log(
      `tool.execute.before(V1): resolving $TURN in prompt (from ${
        pendingParentSession ? "parent" : "current"
      } session ${resolveFromSession})`
    );
    inputObj.prompt = await resolveTurnReferences(
      prompt,
      resolveFromSession
    );
    log(
      `tool.execute.before(V1): resolved prompt (${inputObj.prompt.length} chars)`
    );
  }

  if (cmd && getConfig(configs, cmd)) {
    const cmdConfig = getConfig(configs, cmd)!;
    if (cmd === mainCmd) {
      deletePendingNonSubtaskReturns(taskSession);
    }

    setCallState(callID, cmd);

    if (cmd === mainCmd && cmdConfig.return.length > 1) {
      setReturnState(taskSession, [...cmdConfig.return.slice(1)]);
    }
  }
}

export async function onToolExecuteBeforeV2(event: {
  id: string;
  tool: string;
  sessionID: string;
  input: unknown;
  agent?: string;
  messageID?: string;
}) {
  const toolName = event.tool;
  if (toolName !== "task" && toolName !== "subagent") return;

  const taskSession = event.sessionID;
  const inputObj = (event.input as Record<string, any>) || {};

  setHasActiveSubtask(true);

  const cmd = inputObj.command;
  const prompt = inputObj.prompt;
  const description = inputObj.description;
  const configs = getConfigs();
  let mainCmd = getSessionMainCommand(taskSession);

  const pendingParentSession = prompt
    ? consumePendingParentForPrompt(prompt)
    : null;

  log(
    `tool.before(V2): taskSession=${taskSession}, prompt="${prompt?.substring(0, 30) || "(none)"}...", pendingParentSession=${pendingParentSession || "NOT FOUND"}`
  );

  if (pendingParentSession && pendingParentSession !== taskSession) {
    setSubtaskParentSession(taskSession, pendingParentSession);
    log(
      `tool.before(V2): mapped subtask ${taskSession} -> parent ${pendingParentSession}`
    );
  }

  const callID = event.id;

  if (prompt) {
    const pendingCapture = consumePendingResultCaptureByPrompt(prompt);
    let captureParentSession = pendingCapture?.parentSessionID;
    let captureName = pendingCapture?.name;

    // Also check for inline {as:name} override in prompt or description/args if not found
    if (!captureName) {
      const parsedPrompt = parseOverridesFromArgs(prompt);
      if (parsedPrompt?.overrides?.as) {
        captureName = parsedPrompt.overrides.as;
        captureParentSession = pendingParentSession || taskSession;
      }
    }

    if (captureName && captureParentSession) {
      registerPendingResultCapture(
        taskSession,
        captureParentSession,
        captureName
      );
      registerPendingResultCaptureByPrompt(
        prompt,
        captureParentSession,
        captureName
      );
      if (callID) {
        registerPendingResultCaptureByCallID(
          callID,
          captureParentSession,
          captureName
        );
      }
      log(
        `tool.before(V2): registered result capture for session ${taskSession} (callID=${callID}) as "${captureName}"`
      );
    }
  }

  log(
    `tool.before(V2): callID=${
      callID
    }, cmd=${cmd}, desc="${description?.substring(0, 30)}", mainCmd=${mainCmd}`
  );

  if (!mainCmd && cmd && getConfig(configs, cmd)) {
    setSessionMainCommand(taskSession, cmd);
    mainCmd = cmd;
    const cmdConfig = getConfig(configs, cmd)!;

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

  if (prompt && hasTurnReferences(prompt)) {
    const resolveFromSession = pendingParentSession || taskSession;
    log(
      `tool.execute.before(V2): resolving $TURN in prompt (from ${
        pendingParentSession ? "parent" : "current"
      } session ${resolveFromSession})`
    );
    inputObj.prompt = await resolveTurnReferences(
      prompt,
      resolveFromSession
    );
    log(
      `tool.execute.before(V2): resolved prompt (${inputObj.prompt.length} chars)`
    );
  }

  if (cmd && getConfig(configs, cmd)) {
    const cmdConfig = getConfig(configs, cmd)!;
    if (cmd === mainCmd) {
      deletePendingNonSubtaskReturns(taskSession);
    }

    setCallState(callID, cmd);

    if (cmd === mainCmd && cmdConfig.return.length > 1) {
      setReturnState(taskSession, [...cmdConfig.return.slice(1)]);
    }
  }
}

/**
 * Hook: tool.execute.before (backward-compatible adapter)
 */
export async function toolExecuteBefore(input: any, output: any) {
  const isV2 = input && !input.tool && input.id && input.sessionID;
  if (isV2) {
    return onToolExecuteBeforeV2(input);
  }
  return toolExecuteBeforeV1(input, output);
}

async function processToolExecuteAfter(
  toolName: string | undefined,
  taskSession: string,
  callID: string,
  eventResult?: any,
  outputState?: any,
  status?: "completed" | "error",
  childSessionID?: string
) {
  if (toolName !== "task" && toolName !== "subagent") return;
  if (status && status !== "completed") return;

  const cmd = getCallState(callID);

  log(`tool.after: callID=${callID}, cmd=${cmd}, wasTracked=${!!cmd}`);

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

  const isFrontmatterLoop =
    retryLoop && retryLoop.commandName !== "_inline_subtask_";

  const effectiveChildSession = childSessionID || taskSession;
  const pendingCaptureByCallID = callID
    ? consumePendingResultCaptureByCallID(callID)
    : undefined;
  const pendingCapture =
    pendingCaptureByCallID ||
    getPendingResultCapture(taskSession) ||
    getPendingResultCapture(effectiveChildSession);

  // If output contains prompt or task metadata, also check pending captures by prompt
  const taskPrompt =
    outputState?.args?.prompt ||
    eventResult?.args?.prompt ||
    outputState?.prompt ||
    eventResult?.prompt;
  const pendingCaptureByPrompt = taskPrompt
    ? getPendingResultCaptureByPrompt(taskPrompt)
    : undefined;

  const hasCapture = !!(pendingCapture || pendingCaptureByPrompt);

  if (!cmd && !isInlineLoopIteration && !isFrontmatterLoop && !hasCapture) {
    return;
  }
  if (cmd) {
    deleteCallState(callID);
  }
  if (parentSession) {
    deleteSubtaskParentSession(taskSession);
  }
  if (effectiveChildSession !== taskSession && getSubtaskParentSession(effectiveChildSession)) {
    deleteSubtaskParentSession(effectiveChildSession);
  }

  // Capture result if this subtask has an `as:` name
  if (hasCapture) {
    let resultText = "";
    if (typeof outputState?.output === "string") {
      resultText = outputState.output;
    } else if (typeof eventResult?.output === "string") {
      resultText = eventResult.output;
    } else if (eventResult?.output != null) {
      resultText = JSON.stringify(eventResult.output);
    } else if (typeof eventResult?.content === "string") {
      resultText = eventResult.content;
    } else if (Array.isArray(eventResult?.content)) {
      resultText = eventResult.content
        .map((c: any) => (typeof c === "string" ? c : c.text || JSON.stringify(c)))
        .join("\n");
    }

    if (!resultText) {
      try {
        const client = getClient();
        if (client?.session?.messages) {
          const fetchSession = effectiveChildSession;
          const messages = await client.session.messages({
            path: { id: fetchSession },
            sessionID: fetchSession,
          });
          const msgList = messages?.data ?? messages;
          if (Array.isArray(msgList)) {
            const assistantMsgs = msgList.filter(
              (m: any) => (m.info?.role ?? m.role) === "assistant"
            );
            const lastMsg = assistantMsgs?.[assistantMsgs.length - 1];
            resultText =
              lastMsg?.parts
                ?.filter((p: any) => p.type === "text")
                ?.map((p: any) => p.text)
                ?.join("\n") || "";
          }
        }
      } catch (err) {
        log(`tool.after: failed to fetch messages for result: ${err}`);
      }
    }

    resultText = resultText
      .replace(/<task_metadata>[\s\S]*?<\/task_metadata>/g, "")
      .trim();

    if (resultText) {
      if (pendingCaptureByCallID) {
        storeSubtaskResult(
          pendingCaptureByCallID.parentSessionID,
          pendingCaptureByCallID.name,
          resultText
        );
        clearPendingResultCapturesFor(
          pendingCaptureByCallID.parentSessionID,
          pendingCaptureByCallID.name
        );
        log(
          `tool.after: captured result by callID for "${pendingCaptureByCallID.name}" (${resultText.length} chars) under parent ${pendingCaptureByCallID.parentSessionID}`
        );
      } else if (pendingCapture) {
        captureSubtaskResult(taskSession, resultText);
        if (effectiveChildSession !== taskSession) {
          captureSubtaskResult(effectiveChildSession, resultText);
        }
        clearPendingResultCapturesFor(pendingCapture.parentSessionID, pendingCapture.name);
        log(
          `tool.after: captured result for "${pendingCapture.name}" (${resultText.length} chars)`
        );
      } else if (pendingCaptureByPrompt) {
        storeSubtaskResult(
          pendingCaptureByPrompt.parentSessionID,
          pendingCaptureByPrompt.name,
          resultText
        );
        deletePendingResultCaptureByPrompt(taskPrompt);
        clearPendingResultCapturesFor(
          pendingCaptureByPrompt.parentSessionID,
          pendingCaptureByPrompt.name
        );
        log(
          `tool.after: captured result by prompt for "${pendingCaptureByPrompt.name}" (${resultText.length} chars)`
        );
      }
      if (taskPrompt) {
        deletePendingResultCaptureByPrompt(taskPrompt);
      }
    }
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

export async function toolExecuteAfterV1(input: any, output: any) {
  const toolName = input?.tool;
  // Workflow owner session (parent session from input.sessionID)
  const taskSession = input?.sessionID;
  // Child session as result source (output.metadata?.sessionID or fallback to input.sessionID)
  const childSession =
    output?.metadata?.sessionID ??
    output?.metadata?.sessionId ??
    output?.state?.sessionID ??
    output?.state?.sessionId ??
    input?.sessionID;
  const callID = input?.callID;
  const outputResult =
    typeof output?.output === "string"
      ? { output: output.output }
      : typeof output?.state?.output === "string"
      ? { output: output.state.output }
      : output?.state;
  return processToolExecuteAfter(
    toolName,
    taskSession,
    callID,
    outputResult,
    output?.state,
    undefined,
    childSession
  );
}

export async function onToolExecuteAfterV2(event: {
  id: string;
  tool: string;
  sessionID: string;
  status: "completed" | "error";
  result?: unknown;
  agent?: string;
  messageID?: string;
}) {
  const toolName = event.tool;
  const taskSession = event.sessionID;
  const callID = event.id;
  const status = event.status;
  const eventResult = event.status === "completed" ? event.result : undefined;
  return processToolExecuteAfter(toolName, taskSession, callID, eventResult, null, status);
}

/**
 * Hook: tool.execute.after
 * Handles task completion, loop evaluation setup, and return triggers
 */
export async function toolExecuteAfter(input: any, output: any) {
  const isV2 = input && !input.tool && input.id && input.sessionID;
  if (isV2) {
    return onToolExecuteAfterV2(input);
  }
  return toolExecuteAfterV1(input, output);
}

// Aliases for backwards compatibility
export const onToolExecuteAfter = onToolExecuteAfterV2;
export const onToolExecuteBefore = onToolExecuteBeforeV2;

