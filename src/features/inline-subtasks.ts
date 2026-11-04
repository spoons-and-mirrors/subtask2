import {
  getPluginContext,
  getClient,
  createChildSession,
  promptSession,
  registerPendingParentForPrompt,
  registerPendingResultCaptureByPrompt,
  setSubtaskParentSession,
  setReturnState,
} from "../core/state";
import { log } from "../utils/logger";
import { hasTurnReferences, parseParallelItem } from "../parsing";
import { resolveTurnReferences } from "./turns";
import type { CommandOverrides } from "../parsing";
import { startLoop } from "../loop";
import { flattenParallels } from "./parallel";

/**
 * Feature: Inline subtask execution
 * Executes /subtask {...} inline subtasks without command files in V2
 */

/**
 * Build a V1-style subtask part for inline subtask syntax.
 * Used by the V1 command hook to replace output.parts.
 */
export async function buildInlineSubtaskPart(
  parsed: {
    prompt: string;
    overrides: CommandOverrides;
  },
  sessionID: string
): Promise<any> {
  let prompt = parsed.prompt;

  if (hasTurnReferences(prompt)) {
    prompt = await resolveTurnReferences(prompt, sessionID);
  }

  let model: { providerID: string; modelID: string } | undefined;
  if (parsed.overrides.model?.includes("/")) {
    const [providerID, ...rest] = parsed.overrides.model.split("/");
    model = { providerID, modelID: rest.join("/") };
  }

  log(
    `buildInlineSubtaskPart: prompt="${prompt.substring(0, 50)}...", model=${
      parsed.overrides.model
    }, agent=${parsed.overrides.agent}`
  );

  if (parsed.overrides.loop) {
    startLoop(
      sessionID,
      parsed.overrides.loop,
      "_inline_subtask_",
      prompt,
      parsed.overrides.model,
      parsed.overrides.agent,
      parsed.overrides.return
    );
    log(
      `buildInlineSubtaskPart: started loop for "${parsed.overrides.loop.until}" max=${parsed.overrides.loop.max}`
    );
  } else if (parsed.overrides.return?.length) {
    setReturnState(sessionID, [...parsed.overrides.return]);
    log(
      `buildInlineSubtaskPart: registered return chain of ${parsed.overrides.return.length} prompts for parent ${sessionID}`
    );
  }

  registerPendingParentForPrompt(prompt, sessionID);

  if (parsed.overrides.as) {
    registerPendingResultCaptureByPrompt(
      prompt,
      sessionID,
      parsed.overrides.as
    );
    log(
      `buildInlineSubtaskPart: registered result capture as "${parsed.overrides.as}"`
    );
  }

  return {
    type: "subtask",
    agent: parsed.overrides.agent || "build",
    model,
    description: "Inline subtask",
    prompt,
  };
}

export async function executeInlineSubtask(
  parsed: {
    prompt: string;
    overrides: CommandOverrides;
  },
  sessionID: string
): Promise<void> {
  let prompt = parsed.prompt;

  // Resolve $TURN references in the prompt
  if (hasTurnReferences(prompt)) {
    prompt = await resolveTurnReferences(prompt, sessionID);
  }

  // Build model from override if present
  let model: { id: string; providerID: string } | undefined;
  if (parsed.overrides.model?.includes("/")) {
    const [providerID, ...rest] = parsed.overrides.model.split("/");
    model = { providerID, id: rest.join("/") };
  }

  log(
    `executeInlineSubtask: prompt="${prompt.substring(0, 50)}...", model=${
      parsed.overrides.model
    }, agent=${parsed.overrides.agent}`
  );

  // Start loop if configured
  if (parsed.overrides.loop) {
    startLoop(
      sessionID,
      parsed.overrides.loop,
      "_inline_subtask_",
      prompt,
      parsed.overrides.model,
      parsed.overrides.agent,
      parsed.overrides.return
    );
    log(
      `inline subtask: started loop for "${parsed.overrides.loop.until}" max=${parsed.overrides.loop.max}`
    );
  }

  const ctx = getPluginContext();
  const client = getClient();
  if (!ctx?.session?.create && !client?.session?.create) {
    log(`executeInlineSubtask ERROR: no plugin context or client available`);
    return;
  }

  // Save return state to parent session if return is present without loop
  if (!parsed.overrides.loop && parsed.overrides.return?.length) {
    setReturnState(sessionID, [...parsed.overrides.return]);
    log(
      `executeInlineSubtask: registered return chain of ${parsed.overrides.return.length} prompts for parent ${sessionID}`
    );
  }

  // Register parent session for $TURN resolution
  registerPendingParentForPrompt(prompt, sessionID);

  // Register result capture if `as:` is specified
  if (parsed.overrides.as) {
    registerPendingResultCaptureByPrompt(
      prompt,
      sessionID,
      parsed.overrides.as
    );
    log(
      `executeInlineSubtask: registered result capture as "${parsed.overrides.as}"`
    );
  }

  try {
    const title = prompt.length > 50 ? prompt.substring(0, 47) + "..." : prompt;
    log(`executeInlineSubtask: creating child session for parent ${sessionID}...`);
    const child = await createChildSession({
      parentID: sessionID,
      title,
      agent: (parsed.overrides.agent as any) || "build",
      model: model as any,
    });

    log(`executeInlineSubtask: child session created: ${child.id}, sending prompt...`);
    if (parsed.overrides.loop || parsed.overrides.return?.length) {
      setSubtaskParentSession(child.id, sessionID);
      log(`executeInlineSubtask: mapped child ${child.id} -> parent ${sessionID}`);
    }
    await promptSession(child.id, prompt);

    // Handle parallel subtasks if specified
    if (parsed.overrides.parallel?.length) {
      const parallelCommands = parsed.overrides.parallel
        .map(p => parseParallelItem(p))
        .filter((p): p is NonNullable<typeof p> => p !== null);

      if (parallelCommands.length) {
        const parallelParts = await flattenParallels(
          parallelCommands,
          "",
          sessionID
        );
        for (const pp of parallelParts) {
          let pModel: { id: string; providerID: string } | undefined;
          if (pp.model) {
            pModel = { providerID: pp.model.providerID, id: pp.model.modelID };
          }
          const pChild = await createChildSession({
            parentID: sessionID,
            title: pp.description || "Parallel subtask",
            agent: (pp.agent as any) || "build",
            model: pModel as any,
          });
          if (pp.as) {
            registerPendingResultCaptureByPrompt(pp.prompt, sessionID, pp.as);
          }
          await promptSession(pChild.id, pp.prompt);
        }
        log(
          `executeInlineSubtask: spawned ${parallelParts.length} parallel subtasks`
        );
      }
    }
  } catch (err) {
    log(`executeInlineSubtask ERROR: ${err}`);
  }
}

