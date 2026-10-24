import { getPluginContext, getFirstReturnPrompt } from "../core/state";
import { log } from "../utils/logger";
import {
  hasTurnReferences,
  extractTurnReferences,
  replaceTurnReferences,
} from "../parsing";

/**
 * Feature: $TURN[n] reference resolution
 * Fetches and formats session messages for injection into commands
 */

/**
 * Fetch and format session messages
 * @param sessionID - The session to fetch from
 * @param lastN - Get the last N messages (optional)
 * @param specificIndices - Get specific messages by index from end, 1-based (optional)
 */
export async function fetchSessionMessages(
  sessionID: string,
  lastN?: number,
  specificIndices?: number[]
): Promise<string> {
  const ctx = getPluginContext();
  if (!ctx) {
    log("fetchSessionMessages: no plugin context available");
    return "[TURN: plugin context not available]";
  }

  try {
    const messages = await ctx.session.context({
      sessionID: sessionID as any,
    });

    log(
      `fetchSessionMessages: got ${
        messages?.length ?? 0
      } messages from ${sessionID}`
    );

    if (!messages?.length) {
      return "[TURN: no messages found]";
    }

    // Filter out trailing empty messages
    let effectiveMessages = messages;
    while (effectiveMessages.length > 0) {
      const last = effectiveMessages[effectiveMessages.length - 1];
      let hasContent = false;
      if (last.type === "user") {
        hasContent = !!last.text?.trim();
      } else if (last.type === "assistant") {
        hasContent = (last.content || []).some(
          (c: any) =>
            (c.type === "text" && c.text?.trim()) ||
            (c.type === "tool" && c.state?.status === "completed")
        );
      }
      if (!hasContent) {
        effectiveMessages = effectiveMessages.slice(0, -1);
      } else {
        break;
      }
    }

    // Select messages based on mode
    let selectedMessages: typeof messages;
    if (specificIndices && specificIndices.length > 0) {
      selectedMessages = specificIndices
        .map(idx => effectiveMessages[effectiveMessages.length - idx])
        .filter(Boolean);
    } else if (lastN) {
      selectedMessages = effectiveMessages.slice(-lastN);
    } else {
      selectedMessages = effectiveMessages;
    }

    const formatted = selectedMessages.map((msg: any) => {
      const role = (msg.type || "unknown").toUpperCase();
      const parts: string[] = [];

      if (msg.type === "user") {
        if (msg.text) {
          parts.push(msg.text);
        }
      } else if (msg.type === "assistant") {
        for (const item of msg.content || []) {
          if (item.type === "text" && item.text) {
            if (
              item.text.startsWith("Summarize the task tool output") ||
              item.text.startsWith("Summarize the subagent tool output")
            ) {
              const replacement = getFirstReturnPrompt(sessionID);
              if (replacement) {
                parts.push(replacement);
              }
              continue;
            }
            parts.push(item.text);
          } else if (item.type === "tool" && item.state?.status === "completed") {
            const toolName = item.name;
            const contentArr = (item.state as any).content || [];
            let output = "";
            for (const c of contentArr) {
              if (c.type === "text" && c.text) {
                output += c.text + "\n";
              }
            }
            output = output
              .replace(/<task_metadata>[\s\S]*?<\/task_metadata>/g, "")
              .trim();
            if (output && output.length < 2000) {
              if (toolName === "task" || toolName === "subagent") {
                parts.push(output);
              } else {
                parts.push(`[Tool: ${toolName}]\n${output}`);
              }
            }
          }
        }
      }

      return `--- ${role} ---\n${parts.join("\n")}`;
    });

    return formatted.join("\n\n");
  } catch (e) {
    log("fetchSessionMessages error:", e);
    return `[TURN: error fetching messages - ${e}]`;
  }
}

/**
 * Process a string and replace all $TURN references with actual session content
 */
export async function resolveTurnReferences(
  text: string,
  sessionID: string
): Promise<string> {
  if (!hasTurnReferences(text)) {
    return text;
  }

  const refs = extractTurnReferences(text);
  if (!refs.length) return text;

  const replacements = new Map<string, string>();

  for (const ref of refs) {
    if (ref.type === "lastN") {
      const content = await fetchSessionMessages(sessionID, ref.count);
      replacements.set(ref.match, content);
      log(`Resolved ${ref.match}: ${content.length} chars`);
    } else if (ref.type === "specific") {
      const content = await fetchSessionMessages(
        sessionID,
        undefined,
        ref.indices
      );
      replacements.set(ref.match, content);
      log(`Resolved ${ref.match}: ${content.length} chars`);
    } else if (ref.type === "all") {
      const content = await fetchSessionMessages(sessionID, Infinity);
      replacements.set(ref.match, content);
      log(`Resolved ${ref.match}: ${content.length} chars`);
    }
  }

  return replaceTurnReferences(text, replacements);
}

