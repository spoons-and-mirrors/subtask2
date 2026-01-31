// Return execution logic
import { isCommand, parseCommand } from "../parsing/commands";
import { parseOverrides } from "../parsing/overrides";
import { resolveResults } from "./results";
import { resolveTurns, hasTurnReferences } from "./turns";
import {
  log,
  hasExecutedReturn,
  markReturnExecuted,
  setPendingCaptureByParent,
  setReturnState,
} from "../state";

// Client reference (set by hooks)
let clientRef: any = null;

// Get the actual SDK client (nested under .client)
const getClient = () => clientRef?.client;

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
  const client = getClient();
  if (!client) {
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
  const client = getClient();
  const parsed = parseCommand(text);
  if (!parsed) return;

  // Special handling for /subtask - use promptAsync directly
  if (parsed.name === "subtask") {
    await executeInlineSubtask(parsed.args, sessionID, client);
    return;
  }

  // Regular command - use session.command API
  log(
    "Executing command return:",
    parsed.name,
    "args:",
    parsed.args?.slice(0, 50)
  );

  try {
    await client.session.command({
      path: { id: sessionID },
      body: {
        command: parsed.name,
        arguments: parsed.args,
      },
    });
  } catch (err: any) {
    log("Command return error:", err?.message);
  }
}

async function executeInlineSubtask(
  args: string,
  sessionID: string,
  client: any
) {
  // Parse overrides from args: {model:x && as:y} prompt
  const overrides = parseOverrides(args);
  const prompt = overrides.remainder;

  if (!prompt.trim()) {
    log("Empty prompt for inline subtask, skipping");
    return;
  }

  log("Executing inline subtask:", prompt.slice(0, 50));

  // Build model object if specified
  let model: { providerID: string; modelID: string } | undefined;
  if (overrides.model?.includes("/")) {
    const [providerID, ...rest] = overrides.model.split("/");
    model = { providerID, modelID: rest.join("/") };
  }

  // Store inline return if specified
  if (overrides.return) {
    setReturnState(sessionID, [overrides.return]);
    log("Stored inline return:", overrides.return.slice(0, 50));
  }

  // Store result capture if specified
  if (overrides.as) {
    setPendingCaptureByParent(sessionID, overrides.as);
    log("Stored capture as:", overrides.as);
  }

  // Use promptAsync with subtask part
  const description = prompt.length > 50 ? prompt.slice(0, 47) + "..." : prompt;

  try {
    await client.session.promptAsync({
      path: { id: sessionID },
      body: {
        parts: [
          {
            type: "subtask",
            agent: overrides.agent || "build",
            model,
            description,
            prompt,
          },
        ],
      },
    });
    log("Inline subtask started successfully");
  } catch (err: any) {
    log("Inline subtask error:", err?.message);
  }
}

async function executePromptReturn(text: string, sessionID: string) {
  const client = getClient();
  log("Executing prompt return:", text.slice(0, 50));

  try {
    await client.session.promptAsync({
      path: { id: sessionID },
      body: {
        parts: [{ type: "text", text }],
      },
    });
  } catch (err: any) {
    log("Prompt return error:", err?.message);
  }
}
