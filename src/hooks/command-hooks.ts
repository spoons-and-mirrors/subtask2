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
} from "../parsing";
import { resolveTurnReferences } from "../features/turns";
import { startLoop, getLoopState } from "../loop";
import { executeAutoWorkflow } from "../features/auto";
import type { SessionPromptEvent } from "../types";

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


