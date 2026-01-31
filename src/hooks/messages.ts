// experimental.chat.messages.transform hook
import {
  log,
  getPendingReturn,
  deletePendingReturn,
  getSessionMainCommand,
} from "../state";
import { getPluginConfig } from "../config";
import { isCommand, parseCommand } from "../parsing/commands";
import { resolveResults } from "../features/results";
import { resolveTurns, hasTurnReferences } from "../features/turns";
import { OPENCODE_GENERIC, DEFAULT_GENERIC_RETURN } from "../plugin";

// Client reference for SDK calls
let clientRef: any = null;

export const setClient = (client: any) => {
  clientRef = client;
};

export const messagesTransform = async (input: any, output: any) => {
  log("messages.transform");

  const messages = output.messages ?? [];

  // Find the "Summarize..." message part
  let targetPart: any = null;
  let targetSessionID: string | null = null;

  // Search from end (most recent first)
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    const parts = msg.parts ?? [];

    for (const part of parts) {
      if (part.type === "text" && part.text === OPENCODE_GENERIC) {
        targetPart = part;
        targetSessionID = msg.info?.sessionID;
        break;
      }
    }

    if (targetPart) break;
  }

  if (!targetPart || !targetSessionID) {
    // No generic message to replace
    return output;
  }

  log("Found generic message for session:", targetSessionID);

  // Check for pending return
  const pendingReturn = getPendingReturn(targetSessionID);
  log(
    "Checking pendingReturn for",
    targetSessionID,
    "found:",
    pendingReturn ? "yes" : "no"
  );

  if (pendingReturn) {
    deletePendingReturn(targetSessionID);

    // Resolve $RESULT references
    let resolved = resolveResults(pendingReturn, targetSessionID);

    // Resolve $TURN references
    if (hasTurnReferences(resolved)) {
      resolved = await resolveTurns(resolved, targetSessionID);
    }

    if (isCommand(resolved)) {
      // Command return - set text empty, execute command
      targetPart.text = "";
      await executeCommand(resolved, targetSessionID);
    } else {
      // Prompt return - replace text
      targetPart.text = resolved;
    }

    return output;
  }

  // No pending return - check if we should replace with generic_return
  const mainCmd = getSessionMainCommand(targetSessionID);

  if (mainCmd) {
    const config = getPluginConfig();

    if (config.replace_generic) {
      targetPart.text = config.generic_return ?? DEFAULT_GENERIC_RETURN;
    }
  }

  return output;
};

async function executeCommand(text: string, sessionID: string): Promise<void> {
  if (!clientRef) {
    log("No client for command execution");
    return;
  }

  // Use parseCommand (not parseCommandWithOverrides) so overrides stay in args
  // The target command's command.execute.before will handle parsing overrides
  const parsed = parseCommand(text);
  if (!parsed) return;

  log("Executing command from transform:", parsed.name);

  try {
    await clientRef.session.command({
      path: { id: sessionID },
      body: {
        command: parsed.name,
        arguments: parsed.args, // Full args including any {model:...} overrides
      },
    });
  } catch (err) {
    log("Command execution error:", err);
  }
}
