// Return execution logic
import { isCommand, parseCommand } from "../parsing/commands";
import { resolveResults } from "./results";
import { resolveTurns, hasTurnReferences } from "./turns";
import { log, hasExecutedReturn, markReturnExecuted } from "../state";

// Client reference (set by hooks)
let clientRef: any = null;

export const setClient = (client: any) => {
  clientRef = client;
};

/**
 * Execute a return (prompt or command)
 * Called by text.complete for remaining returns
 */
export async function executeReturn(
  returnPrompt: string,
  sessionID: string
): Promise<void> {
  if (!clientRef) {
    log("No client reference for return execution");
    return;
  }

  // Deduplication check
  const key = `${sessionID}:${returnPrompt}`;
  if (hasExecutedReturn(key)) {
    log("Skipping duplicate return:", returnPrompt.slice(0, 50));
    return;
  }
  markReturnExecuted(key);

  // Resolve $RESULT references
  let resolved = resolveResults(returnPrompt, sessionID);

  // Resolve $TURN references (requires async)
  if (hasTurnReferences(resolved)) {
    resolved = await resolveTurns(resolved, sessionID);
  }

  // Check if command or prompt
  if (isCommand(resolved)) {
    await executeCommandReturn(resolved, sessionID);
  } else {
    await executePromptReturn(resolved, sessionID);
  }
}

async function executeCommandReturn(text: string, sessionID: string) {
  // Use parseCommand (not parseCommandWithOverrides) so overrides stay in args
  // The target command's command.execute.before will handle parsing overrides
  const parsed = parseCommand(text);
  if (!parsed) return;

  log("Executing command return:", parsed.name);

  try {
    await clientRef.session.command({
      path: { id: sessionID },
      body: {
        command: parsed.name,
        arguments: parsed.args, // Full args including any {model:...} overrides
      },
    });
  } catch (err) {
    log("Command return error:", err);
  }
}

async function executePromptReturn(text: string, sessionID: string) {
  log("Executing prompt return:", text.slice(0, 50));

  try {
    await clientRef.session.prompt({
      path: { id: sessionID },
      body: {
        parts: [{ type: "text", text }],
      },
    });
  } catch (err) {
    log("Prompt return error:", err);
  }
}
