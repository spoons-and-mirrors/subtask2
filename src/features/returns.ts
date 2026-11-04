import type { LoopConfig } from "../types";
import {
  getPluginContext,
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
  createChildSession,
  runSessionCommand,
  promptSession,
  getSessionMessages,
  setSubtaskParentSession,
} from "../core/state";
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
  const ctx = getPluginContext();
  const client = getClient();
  if (!ctx && !client) {
    log(`executeReturn: no plugin context or client available`);
    return;
  }

  // SPECIAL: Auto workflow parse marker - parse and execute the generated workflow
  if (item === "__subtask2_auto_parse__") {
    const messages = await getSessionMessages(sessionID);
    const lastMsg = messages?.[messages.length - 1];
    let lastText = "";
    if (lastMsg?.type === "assistant" || lastMsg?.role === "assistant" || lastMsg?.info?.role === "assistant") {
      const parts = lastMsg.content || lastMsg.parts || [];
      const textItem = parts.find((c: any) => c.type === "text");
      if (textItem && textItem.text) {
        lastText = textItem.text;
      }
    }

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

    await executeReturn(result.command, sessionID);
    return;
  }

  // Dedup check to prevent double execution
  const key = `${sessionID}:${item}`;
  if (hasExecutedReturn(key)) return;
  addExecutedReturn(key);

  if (item.startsWith("/")) {
    const parsed = parseCommandWithOverrides(item);

    if (parsed.isInlineSubtask) {
      let prompt = parsed.arguments || "";

      if (hasTurnReferences(prompt)) {
        prompt = await resolveTurnReferences(prompt, sessionID);
      }

      let model: { id: string; providerID: string } | undefined;
      if (parsed.overrides.model?.includes("/")) {
        const [providerID, ...rest] = parsed.overrides.model.split("/");
        model = { providerID, id: rest.join("/") };
      }

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

      if (parsed.overrides.loop && parsed.overrides.return?.length) {
        log(
          `executeReturn: inline subtask has loop + return, deferring ${parsed.overrides.return.length} returns until loop completes`
        );
      } else if (
        parsed.overrides.return &&
        parsed.overrides.return.length > 0
      ) {
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
      registerPendingParentForPrompt(prompt, sessionID);

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

      setLastReturnType(sessionID, "inline_subtask");

      try {
        log(`executeReturn: creating child session for inline subtask...`);
        const title = prompt.length > 50 ? prompt.substring(0, 47) + "..." : prompt;
        const child = await createChildSession({
          parentID: sessionID,
          title,
          agent: (parsed.overrides.agent as any) || "build",
          model: model as any,
        });

        if (loopConfig || parsed.overrides.return?.length) {
          setSubtaskParentSession(child.id, sessionID);
          log(`executeReturn: mapped child ${child.id} -> parent ${sessionID}`);
        }

        await promptSession(child.id, prompt);
        log(`executeReturn: inline subtask started in child session ${child.id}`);
      } catch (e) {
        log(`executeReturn inline subtask FAILED:`, e);
      }
      return;
    }

    // Regular command execution
    let args = parsed.arguments || "";

    const configs = getConfigs();
    const allKeys = Object.keys(configs);
    const pathKey =
      allKeys.find(k => k.includes("/") && k.endsWith("/" + parsed.command)) ||
      parsed.command;

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

    if (parsed.overrides.as) {
      registerPendingMainSessionCapture(sessionID, parsed.overrides.as);
      log(
        `executeReturn: registered main session capture as "${parsed.overrides.as}"`
      );
    }

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

    setLastReturnType(sessionID, "command");

    try {
      await runSessionCommand({
        sessionID,
        command: pathKey,
        arguments: args || "",
      });
    } catch (e) {
      log(`executeReturn FAILED: ${pathKey}`, e);
    }
  } else {
    log(`executeReturn: prompt "${item.substring(0, 40)}..."`);

    setLastReturnType(sessionID, "prompt");
    setPendingPromptReturn(sessionID, item);

    try {
      await promptSession(sessionID, item);
    } catch (e) {
      log(`executeReturn prompt FAILED:`, e);
    }
  }
}

