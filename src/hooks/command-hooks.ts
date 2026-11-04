import {
  getConfigs,
  setSessionMainCommand,
  setPipedArgsQueue,
  setPendingNonSubtaskReturns,
  getPendingModelOverride,
  deletePendingModelOverride,
  getPendingAgentOverride,
  deletePendingAgentOverride,
} from "../core/state";
import { getConfig } from "../commands/resolver";
import { log } from "../utils/logger";
import {
  hasTurnReferences,
  parseOverridesFromArgs,
  parseInlineSubtask,
} from "../parsing";
import { resolveTurnReferences } from "../features/turns";
import { startLoop, getLoopState } from "../loop";
import { executeAutoWorkflow } from "../features/auto";
import {
  buildInlineSubtaskPart,
} from "../features/inline-subtasks";
import { flattenParallels } from "../features/parallel";
import { registerPendingParentForPrompt, registerPendingResultCaptureByPrompt } from "../core/state";
import type { SessionPromptEvent } from "../types";

/**
 * Hook: command.execute.before (V1 compatibility)
 * Handles command initialization, argument parsing, parallel execution, and loop setup
 */
export async function commandExecuteBefore(
  input: { command: string; sessionID: string; arguments: string },
  output: { parts: any[] }
) {
  const cmd = input.command;

  // EARLY INTERCEPT: /subtask {...} inline subtask via command hook
  if (cmd === "subtask" && input.arguments) {
    const argsToCheck = input.arguments.trim();
    let parsed: { prompt: string; overrides: any } | null = null;

    if (argsToCheck.startsWith("{")) {
      parsed = parseInlineSubtask(argsToCheck);
      if (parsed) {
        log(
          `/subtask command intercept: prompt="${parsed.prompt.substring(0, 50)}...", overrides=${JSON.stringify(parsed.overrides)}`
        );
      }
    } else if (argsToCheck.length > 0) {
      parsed = { prompt: argsToCheck, overrides: {} };
      log(
        `/subtask command intercept (plain): prompt="${parsed.prompt.substring(0, 50)}..."`
      );
    }

    if (parsed) {
      if (parsed.overrides.auto) {
        log(`/subtask command intercept: auto mode enabled`);
        let model: { providerID: string; modelID: string } | undefined;
        if (parsed.overrides.model?.includes("/")) {
          const [providerID, ...rest] = parsed.overrides.model.split("/");
          model = { providerID, modelID: rest.join("/") };
        }

        await executeAutoWorkflow(
          parsed.prompt,
          input.sessionID,
          parsed.overrides.agent,
          model
        );
        return { ...output, abort: true };
      }

      const subtaskPart = await buildInlineSubtaskPart(parsed, input.sessionID);
      output.parts = [subtaskPart];
      log(`/subtask: replaced output.parts with inline subtask`);
      return output;
    }
  }

  const configs = getConfigs();
  const config = getConfig(configs, cmd);
  setSessionMainCommand(input.sessionID, cmd);
  log(
    `cmd.before: ${cmd}`,
    config
      ? {
          return: config.return,
          parallel: config.parallel.map(p => p.command),
          agent: config.agent,
        }
      : "no config"
  );

  if (config?.auto) {
    log(`command.execute.before: detected subtask2:auto for ${cmd}`);
    let model: { providerID: string; modelID: string } | undefined;
    if (config.model?.includes("/")) {
      const [providerID, ...rest] = config.model.split("/");
      model = { providerID, modelID: rest.join("/") };
    }

    await executeAutoWorkflow(
      input.arguments || "",
      input.sessionID,
      config.agent,
      model
    );
    return { ...output, abort: true };
  }

  let effectiveArgs = input.arguments;
  const inlineOverrides = parseOverridesFromArgs(effectiveArgs);
  if (inlineOverrides) {
    effectiveArgs = inlineOverrides.rest;
  }

  const pendingModel = getPendingModelOverride(input.sessionID);
  const pendingAgent = getPendingAgentOverride(input.sessionID);
  const modelOverride = inlineOverrides?.overrides.model ?? pendingModel;
  const agentOverride = inlineOverrides?.overrides.agent ?? pendingAgent;

  if (pendingModel) deletePendingModelOverride(input.sessionID);
  if (pendingAgent) deletePendingAgentOverride(input.sessionID);

  const fmRetry = config?.loop;
  const activeRetry = inlineOverrides?.overrides.loop || fmRetry;
  if (activeRetry && !getLoopState(input.sessionID)) {
    startLoop(
      input.sessionID,
      activeRetry,
      cmd,
      effectiveArgs,
      modelOverride,
      agentOverride
    );
    log(
      `cmd.before: started retry loop: max=${activeRetry.max}, until="${activeRetry.until}"`
    );
  }

  if (modelOverride) {
    if (modelOverride.includes("/")) {
      const [providerID, ...rest] = modelOverride.split("/");
      for (const part of output.parts) {
        if (part.type === "subtask") {
          part.model = { providerID, modelID: rest.join("/") };
        }
      }
      log(`cmd.before: applied model override: ${modelOverride}`);
    }
  }

  if (agentOverride) {
    for (const part of output.parts) {
      if (part.type === "subtask") {
        part.agent = agentOverride;
      }
    }
    log(`cmd.before: applied agent override: ${agentOverride}`);
  }

  const argSegments = effectiveArgs.split("||").map(s => s.trim());
  let mainArgs = argSegments[0] || "";
  const allPipedArgs = argSegments.slice(1);

  if (allPipedArgs.length) {
    setPipedArgsQueue(input.sessionID, allPipedArgs);
  }

  if (hasTurnReferences(mainArgs)) {
    mainArgs = await resolveTurnReferences(mainArgs, input.sessionID);
    log(`Resolved $TURN in mainArgs: ${mainArgs.length} chars`);
  }

  log(`Processing ${output.parts.length} parts for $TURN refs`);
  for (const part of output.parts) {
    if (part.type === "subtask" && part.prompt) {
      if (hasTurnReferences(part.prompt)) {
        part.prompt = await resolveTurnReferences(part.prompt, input.sessionID);
      }
    }
    if (part.type === "text" && part.text) {
      if (hasTurnReferences(part.text)) {
        part.text = await resolveTurnReferences(part.text, input.sessionID);
      }
    }
  }

  if (argSegments.length > 1 || inlineOverrides) {
    for (const part of output.parts) {
      if (part.type === "subtask" && part.prompt) {
        part.prompt = part.prompt.replaceAll(input.arguments, mainArgs);
      }
      if (part.type === "text" && part.text) {
        part.text = part.text.replaceAll(input.arguments, mainArgs);
      }
    }
  }

  const hasSubtaskPart = output.parts.some((p: any) => p.type === "subtask");
  if (!hasSubtaskPart && config?.return?.length) {
    setPendingNonSubtaskReturns(input.sessionID, [...config.return]);
  }

  for (const part of output.parts) {
    if (part.type === "subtask" && part.prompt) {
      registerPendingParentForPrompt(part.prompt, input.sessionID);
      if ((part as any).as) {
        registerPendingResultCaptureByPrompt(
          part.prompt,
          input.sessionID,
          (part as any).as
        );
      }
    }
  }

  if (!config?.parallel?.length) return;

  const parallelParts = await flattenParallels(
    config.parallel,
    mainArgs,
    input.sessionID
  );
  output.parts.push(...parallelParts);
}

/**
 * Hook: session.hook("prompt", ...)
 * Intercepts user prompt/command invocation, parses arguments, pipes, $TURN, and overrides.
 */
export async function onSessionPrompt(event: SessionPromptEvent): Promise<void> {
  const sessionID = event.sessionID;
  const rawText = event.prompt.text || "";
  log(`onSessionPrompt: sessionID=${sessionID}, text="${rawText.substring(0, 60)}"`);

  // Check if text starts with a slash command (e.g. /my-cmd args)
  const trimmed = rawText.trim();
  if (!trimmed.startsWith("/")) {
    // Regular prompt, check for $TURN resolution
    if (hasTurnReferences(rawText)) {
      event.prompt.text = await resolveTurnReferences(rawText, sessionID);
      log(`onSessionPrompt: resolved $TURN in regular prompt`);
    }
    return;
  }

  // Parse command name and arguments
  const spaceIdx = trimmed.indexOf(" ");
  const slashCmd = spaceIdx === -1 ? trimmed.slice(1) : trimmed.slice(1, spaceIdx);
  const rawArgs = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1).trim();

  // If command is "subtask", command registration handles it directly
  if (slashCmd === "subtask") {
    return;
  }

  const configs = getConfigs();
  const config = getConfig(configs, slashCmd);
  setSessionMainCommand(sessionID, slashCmd);

  log(
    `onSessionPrompt: ${slashCmd}`,
    config
      ? {
          return: config.return,
          parallel: config.parallel.map(p => p.command),
          agent: config.agent,
        }
      : "no config"
  );

  // AUTO MODE
  if (config?.auto) {
    log(`onSessionPrompt: detected subtask2:auto for ${slashCmd}`);
    let model: { providerID: string; modelID: string } | undefined;
    if (config.model?.includes("/")) {
      const [providerID, ...rest] = config.model.split("/");
      model = { providerID, modelID: rest.join("/") };
    }

    await executeAutoWorkflow(rawArgs, sessionID, config.agent, model);
    event.prompt.text = ""; // clear prompt so model doesn't re-execute
    return;
  }

  // Check for model/agent overrides from arguments
  let effectiveArgs = rawArgs;
  const inlineOverrides = parseOverridesFromArgs(effectiveArgs);
  if (inlineOverrides) {
    effectiveArgs = inlineOverrides.rest;
  }

  const pendingModel = getPendingModelOverride(sessionID);
  const pendingAgent = getPendingAgentOverride(sessionID);
  const modelOverride = inlineOverrides?.overrides.model ?? pendingModel;
  const agentOverride = inlineOverrides?.overrides.agent ?? pendingAgent;

  if (pendingModel) deletePendingModelOverride(sessionID);
  if (pendingAgent) deletePendingAgentOverride(sessionID);

  // Check for retry / loop config
  const fmRetry = config?.loop;
  const activeRetry = inlineOverrides?.overrides.loop || fmRetry;
  if (activeRetry && !getLoopState(sessionID)) {
    startLoop(
      sessionID,
      activeRetry,
      slashCmd,
      effectiveArgs,
      modelOverride,
      agentOverride
    );
    log(
      `onSessionPrompt: started retry loop: max=${activeRetry.max}, until="${activeRetry.until}"`
    );
  }

  // Parse pipe-separated arguments: main || arg1 || arg2 || arg3 ...
  const argSegments = effectiveArgs.split("||").map((s: string) => s.trim());
  let mainArgs = argSegments[0] || "";
  const allPipedArgs = argSegments.slice(1);

  if (allPipedArgs.length) {
    setPipedArgsQueue(sessionID, allPipedArgs);
  }

  // Resolve $TURN[n] references in mainArgs
  if (hasTurnReferences(mainArgs)) {
    mainArgs = await resolveTurnReferences(mainArgs, sessionID);
    log(`Resolved $TURN in mainArgs: ${mainArgs.length} chars`);
  }

  // Track non-subtask commands with return for later injection
  if (config?.return?.length) {
    setPendingNonSubtaskReturns(sessionID, [...config.return]);
  }

  // Reconstruct prompt text if needed
  if (argSegments.length > 1 || inlineOverrides) {
    event.prompt.text = `/${slashCmd} ${mainArgs}`.trim();
  }
}


