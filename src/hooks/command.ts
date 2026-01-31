// command.execute.before hook
// Main entry point for command processing
import {
  log,
  getConfig,
  setReturnState,
  setSessionMainCommand,
  setPendingCaptureByParent,
  setPendingNonSubtaskReturns,
} from "../state";
import { parseFrontmatter, type CommandConfig } from "../parsing/frontmatter";
import { parseSubtaskArgs } from "../parsing/commands";
import {
  parseOverrides,
  splitModel,
  parseModelOverride,
} from "../parsing/overrides";
import {
  hasTurnReferences,
  resolveTurns,
  setClient as setTurnsClient,
} from "../features/turns";
import {
  handleCLI,
  setClient as setCLIClient,
  COMMAND_HANDLED,
} from "../features/cli";
import { setClient as setReturnsClient } from "../features/returns";

// Client reference for SDK calls
let clientRef: any = null;

export const setClient = (client: any) => {
  clientRef = client;
  setTurnsClient(client);
  setCLIClient(client);
  setReturnsClient(client);
};

export const commandExecuteBefore = async (input: any, output: any) => {
  const cmd = input.command;
  const sessionID = input.sessionID;

  log("command.execute.before", cmd);

  // Handle /subtask command
  if (cmd === "subtask") {
    const args = input.arguments ?? "";
    log("Processing /subtask with args:", args.slice(0, 80));

    // Check for CLI commands (help, alias management)
    const handled = await handleCLI(sessionID, args);
    if (handled) {
      // Stop command execution by throwing sentinel
      throw new Error(COMMAND_HANDLED);
    }

    // Parse /subtask args for overrides and prompt
    const { overrides, prompt } = parseSubtaskArgs(args);
    log(
      "Parsed subtask - overrides:",
      JSON.stringify(overrides),
      "prompt:",
      prompt.slice(0, 50)
    );

    // Validate prompt is not empty
    if (!prompt.trim()) {
      log("ERROR: Empty prompt for /subtask");
      throw new Error(
        "Missing prompt for /subtask. Usage: /subtask {overrides} prompt"
      );
    }

    // Build SubtaskPart
    const part = await buildSubtaskPart(prompt, overrides, sessionID);
    log("Built SubtaskPart:", JSON.stringify(part).slice(0, 100));

    // Store return if specified (single return only for inline subtask)
    if (overrides.return) {
      setReturnState(sessionID, [overrides.return]);
      log("Stored inline return for /subtask");
    }

    // Store result capture if specified
    if (overrides.as) {
      setPendingCaptureByParent(sessionID, overrides.as);
      log("Stored capture as:", overrides.as);
    }

    // Replace output parts with our SubtaskPart
    output.parts = [part];
    setSessionMainCommand(sessionID, "subtask");
    log("Set output.parts with SubtaskPart");

    return output;
  }

  // Handle regular commands with frontmatter
  // Get config from manifest (loaded at startup)
  const cmdConfig = getConfig(cmd);
  log("Checking cmdConfig for", cmd, "found:", !!cmdConfig);

  if (!cmdConfig?.template) {
    // No template, nothing to process
    log("No template found for command, returning");
    return output;
  }

  // Parse frontmatter from the stored template
  log("Parsing frontmatter...");
  const { config, body } = parseFrontmatter(cmdConfig.template);
  log("Parsed config:", JSON.stringify(config));

  // Check for inline overrides in arguments
  const args = input.arguments ?? "";
  const argsOverrides = parseOverrides(args);

  // Merge config (frontmatter < inline overrides)
  const model = argsOverrides.model ?? config.model;
  const agent = argsOverrides.agent ?? config.agent;
  const captureAs = argsOverrides.as;

  // Process returns - store ALL returns, tool.after will shift first to pendingReturns
  const returns = normalizeReturns(config.return);

  // Check for pipe args (future: parallel command args)
  // For now, just use remainder as args

  // If command is NOT a subtask, store returns for non-subtask processing
  if (!config.subtask) {
    if (returns.length > 0) {
      log("Storing non-subtask returns:", returns.length);
      setPendingNonSubtaskReturns(sessionID, returns);
    }
    return output;
  }

  // If command is a subtask, modify the parts
  if (config.subtask) {
    // Resolve $TURN in body
    let resolvedBody = body;
    if (hasTurnReferences(body)) {
      resolvedBody = await resolveTurns(body, sessionID);
    }

    // Also resolve $TURN in arguments
    let resolvedArgs = argsOverrides.remainder;
    if (hasTurnReferences(resolvedArgs)) {
      resolvedArgs = await resolveTurns(resolvedArgs, sessionID);
    }

    // Build full prompt
    const fullPrompt = resolvedArgs
      ? `${resolvedBody}\n\n${resolvedArgs}`
      : resolvedBody;

    // Build SubtaskPart
    const part = await buildSubtaskPartFromConfig(
      fullPrompt,
      config,
      model,
      agent
    );

    // Store capture if specified
    if (captureAs) {
      setPendingCaptureByParent(sessionID, captureAs);
    }

    // Store first return for messages.transform (returns[0])
    if (returns.length > 0) {
      // First return will be handled by tool.after → pendingReturns
      // So we store all returns, tool.after will shift the first one
      log("Storing returnState for", sessionID, "count:", returns.length);
      setReturnState(sessionID, returns);
    }

    output.parts = [part];
    setSessionMainCommand(sessionID, cmd);
  }

  return output;
};

// Helper to normalize returns to array
function normalizeReturns(ret: string | string[] | undefined): string[] {
  if (!ret) return [];
  return Array.isArray(ret) ? ret : [ret];
}

// Build SubtaskPart for /subtask command
async function buildSubtaskPart(
  prompt: string,
  overrides: any,
  sessionID: string
): Promise<any> {
  // Resolve $TURN in prompt
  let resolvedPrompt = prompt;
  if (hasTurnReferences(prompt)) {
    resolvedPrompt = await resolveTurns(prompt, sessionID);
  }

  const part: any = {
    type: "subtask",
    description: "inline subtask",
    prompt: resolvedPrompt,
    agent: "build", // Default agent
  };

  // Apply model override directly to part
  if (overrides.model) {
    const split = splitModel(overrides.model);
    if (split) {
      part.model = split;
    }
  }

  // Apply agent override (replaces default)
  if (overrides.agent) {
    part.agent = overrides.agent;
  }

  return part;
}

// Build SubtaskPart from command config
async function buildSubtaskPartFromConfig(
  prompt: string,
  config: CommandConfig,
  model: string | undefined,
  agent: string | undefined
): Promise<any> {
  const part: any = {
    type: "subtask",
    description: config.description ?? "subtask command",
    prompt,
    agent: "build", // Default agent
  };

  // Apply model (with alias resolution)
  const modelToUse = model ?? config.model;
  if (modelToUse) {
    const split = parseModelOverride(modelToUse);
    if (split) {
      part.model = split;
    }
  }

  // Apply agent (replaces default)
  const agentToUse = agent ?? config.agent;
  if (agentToUse) {
    part.agent = agentToUse;
  }

  return part;
}
