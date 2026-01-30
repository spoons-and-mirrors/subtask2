import type { LoopConfig } from "../types";
import {
  getClient,
  getConfigs,
  hasExecutedReturn,
  addExecutedReturn,
  registerPendingParentForPrompt,
  setSessionMainCommand,
  setPendingModelOverride,
  setPendingAgentOverride,
  getReturnArgsState,
  deleteReturnArgsState,
  pushReturnStack,
  registerPendingResultCaptureByPrompt,
  registerPendingMainSessionCapture,
  setLastReturnType,
  setPendingPromptReturn,
} from "../core/state";
import { getConfig } from "../commands/resolver";
import { log } from "../utils/logger";
import {
  parseCommandWithOverrides,
  hasTurnReferences,
  parseAutoWorkflowOutput,
} from "../parsing";
import { resolveTurnReferences } from "./turns";
import { startLoop } from "../loop";

/**
 * Feature: Return execution
 * Executes return items (commands or prompts) after subtask completion
 */

export async function executeReturn(
  item: string,
  sessionID: string,
  loopOverride?: LoopConfig
) {
  // SPECIAL: Auto workflow parse marker - parse and execute the generated workflow
  if (item === "__subtask2_auto_parse__") {
    const client = getClient();

    // Get the last assistant message (the auto workflow output)
    const messages = await client.session.messages({
      path: { id: sessionID },
    });
    const lastMsg = messages.data?.[messages.data.length - 1];
    const lastText =
      lastMsg?.parts?.find((p: any) => p.type === "text")?.text || "";

    // Parse the auto workflow output
    const result = parseAutoWorkflowOutput(lastText);

    if (!result.found || !result.command) {
      log(
        `executeReturn: auto workflow parse failed - no valid <subtask2 auto> tag found`
      );
      return;
    }

    log(
      `executeReturn: parsed auto workflow: "${result.command.substring(0, 80)}..."`
    );

    // Execute the parsed command as if user invoked it
    // This recurses into executeReturn with the actual /subtask {...} command
    await executeReturn(result.command, sessionID);
    return;
  }

  // Dedup check to prevent double execution
  const key = `${sessionID}:${item}`;
  if (hasExecutedReturn(key)) return;
  addExecutedReturn(key);

  const client = getClient();

  if (item.startsWith("/")) {
    // Parse command with potential overrides: /cmd {model:provider/id,loop:5,until:DONE} args
    // Also handles inline subtask syntax: /subtask {loop:5,until:condition} prompt text
    const parsed = parseCommandWithOverrides(item);

    if (parsed.isInlineSubtask) {
      // Inline subtask: /subtask {overrides} prompt - execute as subtask without command file
      let prompt = parsed.arguments || "";

      // Resolve $TURN references in the prompt
      if (hasTurnReferences(prompt)) {
        prompt = await resolveTurnReferences(prompt, sessionID);
      }

      // Build model from override if present
      let model: { providerID: string; modelID: string } | undefined;
      if (parsed.overrides.model?.includes("/")) {
        const [providerID, ...rest] = parsed.overrides.model.split("/");
        model = { providerID, modelID: rest.join("/") };
      }

      // Start loop if configured
      const loopConfig = parsed.overrides.loop || loopOverride;
      if (loopConfig) {
        startLoop(
          sessionID,
          loopConfig,
          "_inline_subtask_",
          prompt,
          parsed.overrides.model,
          parsed.overrides.agent,
          parsed.overrides.return
        );
        log(
          `executeReturn: started inline subtask loop for ${sessionID}: max=${loopConfig.max}, until="${loopConfig.until}"`
        );
      }

      // Handle inline subtask returns - push onto stack (if not also looping)
      if (parsed.overrides.loop && parsed.overrides.return?.length) {
        log(
          `executeReturn: inline subtask has loop + return, deferring ${parsed.overrides.return.length} returns until loop completes`
        );
      } else if (
        parsed.overrides.return &&
        parsed.overrides.return.length > 0
      ) {
        // No loop, safe to push returns onto stack
        pushReturnStack(sessionID, [...parsed.overrides.return]);
        log(
          `executeReturn: pushed ${parsed.overrides.return.length} inline returns onto stack`
        );
      }

      log(
        `executeReturn: inline subtask with prompt "${prompt.substring(
          0,
          50
        )}..." (agent=${parsed.overrides.agent || "build"})`
      );
      // Register parent session for $TURN resolution (race-safe: keyed by prompt)
      registerPendingParentForPrompt(prompt, sessionID);

      // Register result capture if `as:` is specified
      if (parsed.overrides.as) {
        registerPendingResultCaptureByPrompt(
          prompt,
          sessionID,
          parsed.overrides.as
        );
        log(
          `executeReturn: registered result capture as "${parsed.overrides.as}"`
        );
      }

      // Track that we just executed an inline subtask
      setLastReturnType(sessionID, "inline_subtask");

      try {
        log(`executeReturn: calling promptAsync for inline subtask...`);
        // Use promptAsync with subtask part to run as subtask
        // Use start of prompt as description for better UX
        const description =
          prompt.length > 50 ? prompt.substring(0, 47) + "..." : prompt;
        const result = await client.session.promptAsync({
          path: { id: sessionID },
          body: {
            parts: [
              {
                type: "subtask",
                agent: parsed.overrides.agent || "build",
                model,
                description,
                prompt,
              },
            ],
          },
        });
        log(`executeReturn: promptAsync returned: ${JSON.stringify(result)}`);
      } catch (e) {
        log(`executeReturn inline subtask FAILED:`, e);
      }
      return;
    }

    // Regular command execution
    let args = parsed.arguments || "";

    // Find the path key for this command (OpenCode needs full path for subfolder commands)
    const configs = getConfigs();
    const allKeys = Object.keys(configs);
    const pathKey =
      allKeys.find(k => k.includes("/") && k.endsWith("/" + parsed.command)) ||
      parsed.command;

    // Store model override if present (will be consumed by command.execute.before)
    if (parsed.overrides.model) {
      setPendingModelOverride(sessionID, parsed.overrides.model);
      log(
        `executeReturn: stored model override for ${sessionID}: ${parsed.overrides.model}`
      );
    }

    if (parsed.overrides.agent) {
      setPendingAgentOverride(sessionID, parsed.overrides.agent);
      log(
        `executeReturn: stored agent override for ${sessionID}: ${parsed.overrides.agent}`
      );
    }

    // Register result capture for non-subtask commands with `as:`
    // The next LLM turn after the command completes will be captured
    if (parsed.overrides.as) {
      registerPendingMainSessionCapture(sessionID, parsed.overrides.as);
      log(
        `executeReturn: registered main session capture as "${parsed.overrides.as}"`
      );
    }

    // Store loop config if present (inline takes precedence over passed-in)
    const loopConfig = parsed.overrides.loop || loopOverride;
    if (loopConfig) {
      startLoop(
        sessionID,
        loopConfig,
        pathKey,
        args,
        parsed.overrides.model,
        parsed.overrides.agent
      );
      log(
        `executeReturn: started retry loop for ${sessionID}: max=${loopConfig.max}, until="${loopConfig.until}"`
      );
    }

    // Check if we have piped args for this return command
    const returnArgs = getReturnArgsState(sessionID);
    if (returnArgs?.length) {
      const pipeArg = returnArgs.shift();
      if (!returnArgs.length) deleteReturnArgsState(sessionID);
      if (pipeArg) args = pipeArg;
    }

    log(
      `executeReturn: /${parsed.command} -> ${pathKey} args="${args}" (parent=${sessionID})`
    );
    setSessionMainCommand(sessionID, pathKey);
    // Note: parent session registration happens in command-hooks.ts after prompt modifications

    // Track that we just executed a regular command
    setLastReturnType(sessionID, "command");

    try {
      await client.session.command({
        path: { id: sessionID },
        body: { command: pathKey, arguments: args || "" },
      });
    } catch (e) {
      log(`executeReturn FAILED: ${pathKey}`, e);
    }
  } else {
    log(`executeReturn: prompt "${item.substring(0, 40)}..."`);

    // Track that we just executed a prompt
    setLastReturnType(sessionID, "prompt");

    // Set pending for message-hooks injection (handles current LLM call)
    setPendingPromptReturn(sessionID, item);

    // Also persist via promptAsync (for history)
    await client.session.promptAsync({
      path: { id: sessionID },
      body: { parts: [{ type: "text", text: item }] },
    });
  }
}
