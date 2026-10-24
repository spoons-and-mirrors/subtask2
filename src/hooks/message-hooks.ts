import {
  getReturnState,
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
import type { SessionContextEvent } from "../types";

/**
 * Helper to replace a message part with a prompt and clear any stale assistant response
 */
function replaceAndClear(
  part: any,
  msg: any,
  msgIndex: number,
  newText: string,
  messages: any[]
) {
  log(
    `Replacing generic message at index ${msgIndex} with prompt: "${newText.substring(0, 50)}..."`
  );

  part.text = newText;
  if ("synthetic" in part) {
    delete part.synthetic;
  }

  // Remove any assistant response that came after the replaced message
  const nextIndex = msgIndex + 1;
  if (nextIndex < messages.length) {
    const nextMsg = messages[nextIndex];
    const role = nextMsg.info?.role ?? nextMsg.role;
    if (role === "assistant") {
      messages.splice(nextIndex, 1);
      log(`Removed stale LLM response at index ${nextIndex}`);
    }
  }
}

function isGenericSummarizeText(text: string): boolean {
  if (!text) return false;
  return (
    text === OPENCODE_GENERIC ||
    text.includes("Summarize the task tool output") ||
    text.includes("Summarize the subagent tool output") ||
    text.includes("Summarize the subagent output")
  );
}

/**
 * Hook: session.hook("context", ...)
 * Replaces legacy experimental.chat.messages.transform.
 * Handles /subtask {...} inline subtasks and return prompt substitution.
 */
export async function onSessionContext(event: SessionContextEvent): Promise<void> {
  try {
    const messages = event.messages as any[];
    if (!messages || !Array.isArray(messages)) return;


    log(`message-hooks: ENTRY msgCount=${messages.length}, sessionID=${event.sessionID}`);

    // Check for /subtask in user messages
    for (const msg of messages) {
      const role = msg.info?.role ?? msg.role;
      if (role !== "user") continue;

      const msgId = (msg.info as any)?.id ?? msg.id;
      if (msgId && hasProcessedS2Message(msgId)) continue;

      const parts = msg.content ?? msg.parts ?? [];
      for (const part of parts) {
        if (part.type !== "text" || typeof part.text !== "string") continue;
        const text = part.text.trim();
        const textLower = text.toLowerCase();

        if (textLower.startsWith("/subtask ")) {
          const configs = getConfigs();
          if (configs["subtask"]) {
            log(`/subtask detected but deferring to command registration`);
            continue;
          }

          log(`/subtask detected in message: "${text.substring(0, 60)}..."`);
          if (msgId) addProcessedS2Message(msgId);

          const toParse = text.substring("/subtask ".length);
          const parseInput = toParse.startsWith("{") ? toParse : `{} ${toParse}`;
          const parsed = parseInlineSubtask(parseInput);

          if (parsed) {
            log(
              `/subtask inline subtask: prompt="${parsed.prompt.substring(0, 50)}..."`
            );
            part.text = S2_INLINE_INSTRUCTION;
            const targetSessionID = (msg.info as any)?.sessionID ?? event.sessionID;
            if (targetSessionID) {
              executeInlineSubtask(parsed, targetSessionID).catch(console.error);
            }
            return;
          }
        }
      }
    }

    // Filter out summary leak messages from assistant
    const isSummaryLeak = (msg: any): boolean => {
      const parts = msg.content ?? msg.parts ?? [];
      return parts.some((p: any) => {
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

    const filteredMessages: any[] = [];
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      const role = msg.info?.role ?? msg.role;
      if (role === "assistant" && isSummaryLeak(msg)) {
        log(`message-hooks: removing summary leak at index ${i}`);
        continue;
      }
      filteredMessages.push(msg);
    }

    if (filteredMessages.length !== messages.length) {
      messages.length = 0;
      messages.push(...filteredMessages);
    }

    // Find the LAST message with generic summarize
    let lastGenericPart: any = null;
    let lastGenericMsg: any = null;
    let lastGenericMsgIndex: number = -1;

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      const parts = msg.content ?? msg.parts ?? [];
      for (const part of parts) {
        if (part.type === "text" && isGenericSummarizeText(part.text)) {
          lastGenericPart = part;
          lastGenericMsg = msg;
          lastGenericMsgIndex = i;
        }
      }
    }

    // If no generic part found, check for pending prompt returns
    if (!lastGenericPart) {
      const pendingPrompt = consumePendingPromptReturn(event.sessionID);
      if (pendingPrompt) {
        log(`message-hooks: found pendingPromptReturn for ${event.sessionID}, injecting`);
        const existingUserMsg = messages.find(
          (m: any) => (m.info?.role ?? m.role) === "user"
        );
        if (existingUserMsg) {
          const newMsg = JSON.parse(JSON.stringify(existingUserMsg));
          newMsg.content = [{ type: "text", text: pendingPrompt }];
          newMsg.parts = [{ type: "text", text: pendingPrompt }];
          if (newMsg.id) delete newMsg.id;
          if (newMsg.info?.id) delete newMsg.info.id;
          messages.push(newMsg);
        } else {
          messages.push({
            role: "user",
            content: [{ type: "text", text: pendingPrompt }],
          });
        }
        return;
      }
      return;
    }

    // Resolve parent session
    const subtaskSessionID = lastGenericMsg?.info?.sessionID ?? event.sessionID;
    const resolvedParent = subtaskSessionID
      ? getSubtaskParentSession(subtaskSessionID)
      : undefined;
    const parentSessionID = resolvedParent || subtaskSessionID;

    // Check for deferred prompt return from session.idle
    if (parentSessionID) {
      const pendingPrompt = consumePendingPromptReturn(parentSessionID);
      if (pendingPrompt) {
        replaceAndClear(
          lastGenericPart,
          lastGenericMsg,
          lastGenericMsgIndex,
          pendingPrompt,
          messages
        );
        setPendingStackedPromptResponse(parentSessionID);
        return;
      }
    }

    // Check for pending loop evaluation
    for (const [sessionID, retryState] of getAllPendingEvaluations()) {
      if (!retryState.config.until) {
        const yieldPrompt = createYieldPrompt(
          retryState.iteration,
          retryState.config.max
        );
        lastGenericPart.text = yieldPrompt;
        log(
          `loop: injected yield prompt (unconditional loop ${retryState.iteration}/${retryState.config.max})`
        );
      } else {
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
      return;
    }

    // Check for pending return
    const pendingReturnsEntries = [...getAllPendingReturns()];
    for (const [sessionID, returnPrompt] of pendingReturnsEntries) {
      deletePendingReturn(sessionID);
      setHasActiveSubtask(false);

      const returnStateData = getReturnState(sessionID);
      if (returnStateData?.length && returnStateData[0] === returnPrompt) {
        returnStateData.shift();
      }

      if (returnPrompt.startsWith("/")) {
        if (lastGenericMsgIndex >= 0) {
          messages.splice(lastGenericMsgIndex, 1);
          log(
            `Removed summarize message at index ${lastGenericMsgIndex} for command return`
          );
        }
        executeReturn(returnPrompt, sessionID).catch(console.error);
      } else {
        replaceAndClear(
          lastGenericPart,
          lastGenericMsg,
          lastGenericMsgIndex,
          returnPrompt,
          messages
        );
      }
      return;
    }

    // Check returnState
    if (parentSessionID) {
      const remaining = getReturnState(parentSessionID);
      if (remaining?.length) {
        const nextReturn = remaining[0];
        setHasActiveSubtask(false);

        if (nextReturn.startsWith("/")) {
          if (lastGenericMsgIndex >= 0) {
            messages.splice(lastGenericMsgIndex, 1);
            log(
              `Removed summarize message - returnState command will be processed by session.idle`
            );
          }
        } else {
          const stackedReturns = getCurrentReturnChain(parentSessionID);
          if (stackedReturns?.length) {
            remaining.push(...stackedReturns);
            popCurrentReturnChain(parentSessionID);
          }

          remaining.shift();

          replaceAndClear(
            lastGenericPart,
            lastGenericMsg,
            lastGenericMsgIndex,
            nextReturn,
            messages
          );
          setPendingStackedPromptResponse(parentSessionID);
        }
        return;
      }
    }

    // Stacked returns check
    let stackedSessionID: string | null = null;
    if (parentSessionID && hasReturnStack(parentSessionID)) {
      stackedSessionID = parentSessionID;
    }

    if (stackedSessionID) {
      const nextReturnArray = peekReturnStack(stackedSessionID);
      const nextReturn = nextReturnArray?.[0];

      if (nextReturn?.startsWith("/")) {
        if (lastGenericMsgIndex >= 0) {
          messages.splice(lastGenericMsgIndex, 1);
          log(
            `Removed summarize message - stacked command return will be processed by session.idle`
          );
        }
      } else if (nextReturn) {
        const returnPrompt = shiftReturnStack(stackedSessionID);
        if (returnPrompt) {
          replaceAndClear(
            lastGenericPart,
            lastGenericMsg,
            lastGenericMsgIndex,
            returnPrompt,
            messages
          );
          setPendingStackedPromptResponse(stackedSessionID);
        }
      }
      setHasActiveSubtask(false);
      return;
    }

    // Generic replacement
    const pluginConfig = getPluginConfig();
    if (getHasActiveSubtask() && pluginConfig.replace_generic) {
      const text = pluginConfig.generic_return ?? DEFAULT_PROMPT;
      replaceAndClear(
        lastGenericPart,
        lastGenericMsg,
        lastGenericMsgIndex,
        text,
        messages
      );
      setHasActiveSubtask(false);
      return;
    }
  } catch (err) {
    log(`message-hooks: EXCEPTION: ${err}`);
  }
}

// Backward compatibility alias
export const chatMessagesTransform = onSessionContext;

