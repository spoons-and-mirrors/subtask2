import {
  getClient,
  getReturnState,
  deleteReturnState,
  setReturnState,
  getPluginConfig,
  getAllPendingReturns,
  deletePendingReturn,
  hasReturnStack,
  peekReturnStack,
  shiftReturnStack,
  getCurrentReturnChain,
  popCurrentReturnChain,
  setHasActiveSubtask,
  getHasActiveSubtask,
  OPENCODE_GENERIC,
  getSubtaskParentSession,
  consumePendingPromptReturn,
  setPendingStackedPromptResponse,
  hasProcessedS2Message,
  addProcessedS2Message,
  getConfigs,
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
 * Helper to replace a message part with a prompt and clear any stale assistant response
 */
function replaceAndClear(
  part: any,
  msg: any,
  msgIndex: number,
  newText: string,
  outputMessages: any[]
) {
  log(
    `Replacing generic message at index ${msgIndex} with prompt: "${newText.substring(0, 50)}..."`
  );

  // Modify in place - don't create new objects (references matter)
  part.text = newText;
  delete part.synthetic;

  // Update the DB to make the message visible in TUI
  makePartVisible(part, msg, newText).catch(e =>
    log(`makePartVisible failed: ${e}`)
  );

  // CRITICAL: Remove any assistant response that came after the replaced message
  // The LLM may have already responded to "Summarize..." before this hook fired
  const nextIndex = msgIndex + 1;
  if (nextIndex < outputMessages.length) {
    const nextMsg = outputMessages[nextIndex];
    const role = nextMsg.info?.role ?? nextMsg.role;
    if (role === "assistant") {
      outputMessages.splice(nextIndex, 1);
      log(`Removed stale LLM response at index ${nextIndex}`);
    }
  }
}

/**
 * Hook: experimental.chat.messages.transform
 * Handles /subtask {...} inline subtasks and return prompt injection
 */
export async function chatMessagesTransform(input: any, output: any) {
  try {
    // Log every invocation with message count and session info
    const sessionIDs = [
      ...new Set(
        output.messages.map((m: any) => m.info?.sessionID).filter(Boolean)
      ),
    ];

    // Log message summary for debugging
    const msgSummary = output.messages
      .map((m: any, i: number) => {
        const role = m.info?.role || m.role || "?";
        const parts = (m.parts || [])
          .map((p: any) => {
            if (p.type === "text") {
              const text = p.text?.substring(0, 40) || "";
              return `text:"${text}${p.text?.length > 40 ? "..." : ""}"${p.synthetic ? "(syn)" : ""}`;
            }
            if (p.type === "tool") return `tool:${p.state?.status || "?"}`;
            if (p.type === "subtask")
              return `subtask:"${p.prompt?.substring(0, 30) || ""}..."`;
            return p.type;
          })
          .join(", ");
        return `[${i}]${role}: ${parts}`;
      })
      .join(" | ");

    log(
      `message-hooks: ENTRY msgCount=${output.messages.length}, sessions=${sessionIDs.join(",") || "none"}`
    );
    log(`message-hooks: MESSAGES: ${msgSummary}`);

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
          const parseInput = toParse.startsWith("{")
            ? toParse
            : `{} ${toParse}`;
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

    // Filter out summary leak messages from the assistant
    // These are responses that summarize task tool output, which we don't want
    const filteredMessages: any[] = [];

    const isSummaryLeak = (msg: any): boolean => {
      const parts = msg.parts || [];
      return parts.some((p: any) => {
        if (p.type !== "step-start") return false;
        if (typeof p.text !== "string") return false;
        return (
          p.text.includes("Summary of Task Tool Output") ||
          p.text.includes("My task was to summarize") ||
          p.text.includes("The tool executed your command") ||
          p.text.includes("The command was executed successfully") ||
          p.text.includes("To complete your request")
        );
      });
    };

    for (let i = 0; i < output.messages.length; i++) {
      const msg = output.messages[i];
      const role = msg.info?.role ?? msg.role;

      if (role === "assistant" && isSummaryLeak(msg)) {
        log(`message-hooks: removing summary leak at index ${i}`);
        continue;
      }

      filteredMessages.push(msg);
    }

    if (filteredMessages.length !== output.messages.length) {
      log(
        `message-hooks: filtered ${output.messages.length - filteredMessages.length} summary leak messages`
      );
      // CRITICAL: Must mutate the array IN PLACE, not reassign!
      // Reassigning output.messages doesn't affect the original sessionMessages in OpenCode
      output.messages.length = 0;
      output.messages.push(...filteredMessages);
    }

    log(`message-hooks: post-filter, msgCount=${output.messages.length}`);

    // NOTE: We don't try to delete messages from DB - client.session.removeMessage doesn't exist
    // The filtering above is sufficient - it affects the current LLM call

    log(`message-hooks: about to search for OPENCODE_GENERIC`);

    // Find the LAST message with OPENCODE_GENERIC
    let lastGenericPart: any = null;
    let lastGenericMsg: any = null;
    let lastGenericMsgIndex: number = -1;

    log(
      `message-hooks: searching ${output.messages.length} messages for OPENCODE_GENERIC`
    );

    for (let i = 0; i < output.messages.length; i++) {
      const msg = output.messages[i];
      for (const part of msg.parts || []) {
        if (part.type === "text") {
          const isGeneric = part.text === OPENCODE_GENERIC;
          if (part.synthetic) {
            log(
              `message-hooks: found synthetic text at [${i}]: "${part.text?.substring(0, 50)}..." matches=${isGeneric}`
            );
          }
          if (isGeneric) {
            lastGenericPart = part;
            lastGenericMsg = msg;
            lastGenericMsgIndex = i;
          }
        }
      }
    }

    log(
      `message-hooks: generic search complete, found=${!!lastGenericPart}, index=${lastGenericMsgIndex}`
    );

    // If no generic part found, check for pending prompt returns from inline subtasks
    // Inline subtasks don't get OPENCODE_GENERIC, so we inject the pending prompt directly
    if (!lastGenericPart) {
      log(
        `message-hooks: no generic part found, checking for pending prompt return`
      );

      for (const sid of sessionIDs) {
        const pendingPrompt = consumePendingPromptReturn(sid as string);
        if (pendingPrompt) {
          log(`message-hooks: found pendingPromptReturn for ${sid}, injecting`);

          // Clone structure from an existing user message to ensure correct format
          const existingUserMsg = output.messages.find(
            (m: any) => (m.info?.role ?? m.role) === "user"
          );

          if (existingUserMsg) {
            const newMsg = JSON.parse(JSON.stringify(existingUserMsg));
            newMsg.parts = [{ type: "text", text: pendingPrompt }];
            // Remove IDs so OpenCode doesn't get confused
            if (newMsg.id) delete newMsg.id;
            if (newMsg.info?.id) delete newMsg.info.id;
            if (newMsg.info?.createdAt) delete newMsg.info.createdAt;
            output.messages.push(newMsg);
            log(
              `message-hooks: injected pending prompt: "${pendingPrompt.substring(0, 40)}..."`
            );
          } else {
            // Fallback: create minimal message
            output.messages.push({
              info: { role: "user" },
              parts: [{ type: "text", text: pendingPrompt }],
            });
            log(
              `message-hooks: injected pending prompt (fallback): "${pendingPrompt.substring(0, 40)}..."`
            );
          }
          return; // Let the LLM respond to our injected message
        }

        if (hasReturnStack(sid as string)) {
          log(
            `message-hooks: session ${sid} HAS returnStack but no generic part!`
          );
        }
      }
      return; // Nothing to do without generic part
    }

    // The generic message is in a subtask session, but returns are stored under the PARENT session
    // We need to resolve the parent session to look up returns
    const subtaskSessionID = lastGenericMsg?.info?.sessionID;
    const resolvedParent = subtaskSessionID
      ? getSubtaskParentSession(subtaskSessionID)
      : undefined;
    const parentSessionID = resolvedParent || subtaskSessionID;

    log(
      `message-hooks: subtaskSession=${subtaskSessionID}, resolvedParent=${resolvedParent || "NOT FOUND"}, using=${parentSessionID}`
    );

    // Check for deferred prompt return from session.idle
    // This handles prompt returns that were deferred to be substituted here
    log(
      `message-hooks: checking pendingPromptReturn for session ${parentSessionID}`
    );
    if (parentSessionID) {
      const pendingPrompt = consumePendingPromptReturn(parentSessionID);
      if (pendingPrompt) {
        replaceAndClear(
          lastGenericPart,
          lastGenericMsg,
          lastGenericMsgIndex,
          pendingPrompt,
          output.messages
        );

        // Mark that we're waiting for LLM response to this prompt
        setPendingStackedPromptResponse(parentSessionID);

        return;
      }
    }

    // Check for pending loop evaluation first (orchestrator-decides pattern)
    log(`message-hooks: checking loop evaluations`);
    for (const [sessionID, retryState] of getAllPendingEvaluations()) {
      // Check if this is an unconditional loop (no until condition)
      if (!retryState.config.until) {
        // Unconditional loop: inject yield prompt, no evaluation needed
        const yieldPrompt = createYieldPrompt(
          retryState.iteration,
          retryState.config.max
        );
        // Unconditional loop: modify in place
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
        // Modify in place
        lastGenericPart.text = evalPrompt;
        log(
          `loop: injected evaluation prompt for "${retryState.config.until}"`
        );
      }
      // Don't delete yet - we need it when parsing the response
      return;
    }

    // Check for pending return
    const pendingReturnsEntries = [...getAllPendingReturns()];
    log(
      `message-hooks: checking pendingReturns, count=${pendingReturnsEntries.length}`
    );
    for (const [sessionID, returnPrompt] of pendingReturnsEntries) {
      deletePendingReturn(sessionID);
      setHasActiveSubtask(false);

      // Also shift from returnState to keep them in sync
      // This prevents session.idle from trying to re-execute the same return
      const returnStateData = getReturnState(sessionID);
      if (returnStateData?.length && returnStateData[0] === returnPrompt) {
        returnStateData.shift();
      }

      if (returnPrompt.startsWith("/")) {
        // Command return: remove the summarize message entirely from history
        // and fire the command immediately at this moment
        if (lastGenericMsgIndex >= 0) {
          output.messages.splice(lastGenericMsgIndex, 1);

          // Also delete from DB to prevent OpenCode from re-fetching and responding to it
          const msgId = lastGenericMsg?.id;
          const partId = lastGenericPart?.id;
          if (msgId && partId) {
            const client = getClient();
            // Delete the part (this effectively removes the message content)
            client.session
              .deletePart({ path: { id: partId } })
              .catch((e: Error) => {
                log(`Failed to delete summarize part from DB: ${e.message}`);
              });
          }

          log(
            `Removed summarize message at index ${lastGenericMsgIndex} for command return`
          );
        }
        executeReturn(returnPrompt, sessionID).catch(console.error);
      } else {
        // Plain prompt return: MODIFY the existing part directly (for LLM)
        replaceAndClear(
          lastGenericPart,
          lastGenericMsg,
          lastGenericMsgIndex,
          returnPrompt,
          output.messages
        );
      }
      return;
    }

    // No pending return found, check returnState for remaining returns
    // This handles returns after the first one (which used pendingReturns)
    // Use parentSessionID (resolved earlier) since returns are stored under parent session
    if (parentSessionID) {
      const remaining = getReturnState(parentSessionID);
      if (remaining?.length) {
        const nextReturn = remaining[0];
        setHasActiveSubtask(false);

        if (nextReturn.startsWith("/")) {
          // Command return: remove the summarize message, let session.idle execute
          if (lastGenericMsgIndex >= 0) {
            output.messages.splice(lastGenericMsgIndex, 1);
            log(
              `Removed summarize message - returnState command will be processed by session.idle`
            );
          }
        } else {
          // Prompt return: REPLACE the message so LLM responds to it
          // NOTE: We must replace the entire message, not just modify the part text,
          // because OpenCode may deep-copy messages before sending to LLM
          // First, check if there are stacked returns from inline subtasks
          // and transfer them to returnState so the chain continues
          const stackedReturns = getCurrentReturnChain(parentSessionID);
          if (stackedReturns?.length) {
            remaining.push(...stackedReturns);
            popCurrentReturnChain(parentSessionID);
            log(
              `Transferred ${stackedReturns.length} stacked returns to returnState for continued processing`
            );
          }

          // Shift from returnState since we're handling it here
          remaining.shift();

          replaceAndClear(
            lastGenericPart,
            lastGenericMsg,
            lastGenericMsgIndex,
            nextReturn,
            output.messages
          );

          // Mark that we're waiting for LLM response to this prompt
          // This prevents session.idle from processing the next return too early
          setPendingStackedPromptResponse(parentSessionID);
        }
        return;
      }
    }

    // No returns found, use generic replacement if configured
    // BUT skip if there are stacked returns (from inline subtasks with returns)
    // Those will be processed by session.idle hook
    const pluginConfig = getPluginConfig();

    // Check if the parent session has stacked returns
    // Use parentSessionID (resolved earlier) since stacked returns are stored under parent session
    let stackedSessionID: string | null = null;
    if (parentSessionID && hasReturnStack(parentSessionID)) {
      stackedSessionID = parentSessionID;
    }

    if (stackedSessionID) {
      // Peek at the first stacked return to decide how to handle
      const nextReturnArray = peekReturnStack(stackedSessionID);
      const nextReturn = nextReturnArray?.[0];

      if (nextReturn?.startsWith("/")) {
        // Command return: remove the summarize message, let session.idle execute
        if (lastGenericMsgIndex >= 0) {
          output.messages.splice(lastGenericMsgIndex, 1);
          log(
            `Removed summarize message - stacked command return will be processed by session.idle`
          );
        }
      } else if (nextReturn) {
        // Prompt return: REPLACE the message so LLM responds to it
        const returnPrompt = shiftReturnStack(stackedSessionID);
        if (returnPrompt) {
          replaceAndClear(
            lastGenericPart,
            lastGenericMsg,
            lastGenericMsgIndex,
            returnPrompt,
            output.messages
          );

          // Mark that we're waiting for LLM response to this prompt
          // This prevents session.idle from processing returnState too early
          setPendingStackedPromptResponse(stackedSessionID);
        }
      }
      setHasActiveSubtask(false);
      return;
    }

    if (getHasActiveSubtask() && pluginConfig.replace_generic) {
      const text = pluginConfig.generic_return ?? DEFAULT_PROMPT;
      replaceAndClear(
        lastGenericPart,
        lastGenericMsg,
        lastGenericMsgIndex,
        text,
        output.messages
      );
      setHasActiveSubtask(false);
      return;
    }
  } catch (err) {
    log(`message-hooks: EXCEPTION: ${err}`);
  }
}
