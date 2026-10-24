import {
  getPluginContext,
  registerPendingParentForPrompt,
  setReturnState,
} from "../core/state";
import { log } from "../utils/logger";
import { getAutoWorkflowPrompt } from "../utils/prompts";

/**
 * Execute a subtask2: auto workflow (POC)
 *
 * This is experimental and not a supported feature yet.
 * 1. Spawns subtask with auto prompt + user arguments
 * 2. Sets up return to parse and execute the generated workflow
 */
export async function executeAutoWorkflow(
  userArguments: string,
  sessionID: string,
  agent?: string,
  model?: { providerID: string; modelID: string }
): Promise<void> {
  const ctx = getPluginContext();
  if (!ctx) {
    log(`executeAutoWorkflow ERROR: no plugin context available`);
    return;
  }

  // Build the prompt with README content injected
  const autoPrompt = await getAutoWorkflowPrompt();
  const prompt = autoPrompt + userArguments;

  log(
    `executeAutoWorkflow: starting auto workflow with args="${userArguments.substring(0, 50)}..."`
  );

  // Register parent session for later reference
  registerPendingParentForPrompt(prompt, sessionID);

  // Set up the return to parse and execute the workflow
  // This special marker tells returns.ts to parse the auto output
  setReturnState(sessionID, ["__subtask2_auto_parse__"]);

  try {
    let m: { id: string; providerID: string } | undefined;
    if (model) {
      m = { providerID: model.providerID, id: model.modelID };
    }
    const child = await ctx.session.create({
      parentID: sessionID as any,
      title: "Auto workflow generation",
      agent: (agent as any) || "build",
      model: m as any,
    });
    await ctx.session.prompt({
      sessionID: child.id,
      text: prompt,
    });
  } catch (e) {
    log(`executeAutoWorkflow FAILED:`, e);
  }
}

