import {
  getPluginConfig,
  getAllPendingReturns,
  deletePendingReturn,
  setHasActiveSubtask,
  getHasActiveSubtask,
  hasProcessedS2Message,
  addProcessedS2Message,
  OPENCODE_GENERIC,
  getConfigs,
  getClient,
} from "../core/state";
import { log } from "../utils/logger";
import { DEFAULT_PROMPT } from "../utils/config";
import { S2_INLINE_INSTRUCTION } from "../utils/prompts";
import { parseInlineSubtask } from "../parsing";
import { executeInlineSubtask } from "../features/inline-subtasks";
import { executeReturn } from "../features/returns";
import {
  getAllPendingEvaluations,
  createEvaluationPrompt,
  createYieldPrompt,
} from "../loop";

/**
 * Update the synthetic part in the database to make it visible in TUI.
 *
 * The v1 SDK from OpenCode exposes an internal hey-api HTTP client at client.client
 * which we use to PATCH the part. This is the only reliable way to update parts
 * from a plugin since client.part.update() doesn't exist in v1.
 *
 * Note: OpenCode's plugin system passes a v1 client. When/if they upgrade to v2,
 * we can use client.part.update() directly.
 */
async function makePartVisible(
  part: any,
  msg: any,
  newText: string
): Promise<void> {
  const client = getClient();
  if (!client) {
    log(`makePartVisible: no client available`);
    return;
  }

  // Extract IDs from the part and message
  const partID = part.id;
  const messageID = part.messageID || msg?.info?.id;
  const sessionID = part.sessionID || msg?.info?.sessionID;

  if (!partID || !messageID || !sessionID) {
    log(
      `makePartVisible: missing IDs - partID=${partID}, messageID=${messageID}, sessionID=${sessionID}`
    );
    return;
  }

  log(
    `makePartVisible: updating part ${partID} in DB to be visible with text: "${newText.substring(0, 50)}..."`
  );

  // Use the internal HTTP client from v1 SDK
  try {
    const httpClient = (client as any).client || (client as any)._client;
    if (httpClient?.patch) {
      await httpClient.patch({
        url: `/session/${sessionID}/message/${messageID}/part/${partID}`,
        body: {
          id: partID,
          messageID,
          sessionID,
          type: "text",
          text: newText,
          synthetic: false, // Make visible in TUI
        },
      });
      log(`makePartVisible: success`);
    } else {
      log(
        `makePartVisible: no internal HTTP client found - keys: ${Object.keys(client).join(", ")}`
      );
    }
  } catch (e) {
    log(`makePartVisible: failed - ${e}`);
  }
}

/**
 * Hook: experimental.chat.messages.transform
 * Handles /subtask {...} inline subtasks and return prompt injection
 */
export async function chatMessagesTransform(input: any, output: any) {
  // Check for /subtask in user messages
  // With the placeholder command file, OpenCode routes /subtask to command hook
  // This is a fallback for when no placeholder exists
  for (const msg of output.messages) {
    if (msg.info?.role !== "user") continue;

    // Track processed messages by ID to avoid infinite loop
    const msgId = (msg.info as any)?.id;
    if (msgId && hasProcessedS2Message(msgId)) continue;

    for (const part of msg.parts) {
      if (part.type !== "text") continue;
      const text = part.text.trim();
      const textLower = text.toLowerCase();

      // Match /subtask (with space) - the recommended syntax
      if (textLower.startsWith("/subtask ")) {
        // If /subtask command exists, defer to command hook for instant execution
        const configs = getConfigs();
        if (configs["subtask"]) {
          log(
            `/subtask detected but deferring to command hook (subtask command exists)`
          );
          continue;
        }

        // Fallback: handle via message transform when no placeholder command exists
        log(
          `/subtask detected in message (no placeholder): "${text.substring(0, 60)}..."`
        );

        // Mark as processed BEFORE spawning
        if (msgId) addProcessedS2Message(msgId);

        // Parse: remove "/subtask " prefix
        const toParse = text.substring("/subtask ".length);
        // Wrap in {} if it doesn't start with { (plain prompt case)
        const parseInput = toParse.startsWith("{") ? toParse : `{} ${toParse}`;
        const parsed = parseInlineSubtask(parseInput);

        if (parsed) {
          log(
            `/subtask inline subtask: prompt="${parsed.prompt.substring(
              0,
              50
            )}...", overrides=${JSON.stringify(parsed.overrides)}`
          );
          // Replace with instruction to say minimal response
          part.text = S2_INLINE_INSTRUCTION;
          // Spawn the subtask - get sessionID from message info
          const sessionID =
            (msg.info as any)?.sessionID || (input as any).sessionID;
          log(`/subtask sessionID: ${sessionID}`);
          if (sessionID) {
            executeInlineSubtask(parsed, sessionID).catch(console.error);
          } else {
            log(`/subtask ERROR: no sessionID found`);
          }
          return;
        } else {
          log(`/subtask parse failed for: "${parseInput}"`);
        }
      }
    }
  }

  // Find the LAST message with OPENCODE_GENERIC
  let lastGenericPart: any = null;
  let lastGenericMsg: any = null;
  let lastGenericMsgIndex: number = -1;

  for (let i = 0; i < output.messages.length; i++) {
    const msg = output.messages[i];
    for (const part of msg.parts) {
      if (part.type === "text" && part.text === OPENCODE_GENERIC) {
        lastGenericPart = part;
        lastGenericMsg = msg;
        lastGenericMsgIndex = i;
      }
    }
  }

  if (lastGenericPart) {
    // Check for pending loop evaluation first (orchestrator-decides pattern)
    for (const [sessionID, retryState] of getAllPendingEvaluations()) {
      // Check if this is an unconditional loop (no until condition)
      if (!retryState.config.until) {
        // Unconditional loop: inject yield prompt, no evaluation needed
        const yieldPrompt = createYieldPrompt(
          retryState.iteration,
          retryState.config.max
        );
        lastGenericPart.text = yieldPrompt;
        log(
          `loop: injected yield prompt (unconditional loop ${retryState.iteration}/${retryState.config.max})`
        );
      } else {
        // Conditional loop: inject evaluation prompt
        const evalPrompt = createEvaluationPrompt(
          retryState.config.until,
          retryState.iteration,
          retryState.config.max
        );
        lastGenericPart.text = evalPrompt;
        log(
          `loop: injected evaluation prompt for "${retryState.config.until}"`
        );
      }
      // Don't delete yet - we need it when parsing the response
      return;
    }

    // Check for pending return
    for (const [sessionID, returnPrompt] of getAllPendingReturns()) {
      deletePendingReturn(sessionID);
      setHasActiveSubtask(false);
      if (returnPrompt.startsWith("/")) {
        // Command return: remove the summarize message entirely from history
        // and fire the command immediately at this moment
        if (lastGenericMsgIndex >= 0) {
          output.messages.splice(lastGenericMsgIndex, 1);
          log(
            `Removed summarize message at index ${lastGenericMsgIndex} for command return`
          );
        }
        executeReturn(returnPrompt, sessionID).catch(console.error);
      } else {
        // Plain prompt return: replace the text in transform (for LLM)
        // AND update the DB to remove synthetic flag (for TUI visibility)
        lastGenericPart.text = returnPrompt;
        delete (lastGenericPart as Record<string, unknown>).synthetic;

        // Also update the DB to make the message visible in TUI
        makePartVisible(lastGenericPart, lastGenericMsg, returnPrompt).catch(
          console.error
        );

        log(
          `Replaced summarize message with visible return prompt: "${returnPrompt.substring(0, 50)}..."`
        );
      }
      return;
    }

    // No pending return found, use generic replacement if configured
    const pluginConfig = getPluginConfig();
    if (getHasActiveSubtask() && pluginConfig.replace_generic) {
      log(`Using default generic replacement`);
      lastGenericPart.text = pluginConfig.generic_return ?? DEFAULT_PROMPT;
      setHasActiveSubtask(false);
      return;
    }
  }
}
