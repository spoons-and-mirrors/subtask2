import {
  getPluginContext,
  registerPendingParentForPrompt,
  registerPendingResultCaptureByPrompt,
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
  if (!ctx) {
    log(`executeInlineSubtask ERROR: no plugin context available`);
    return;
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
    const child = await ctx.session.create({
      parentID: sessionID as any,
      title,
      agent: (parsed.overrides.agent as any) || "build",
      model: model as any,
    });

    log(`executeInlineSubtask: child session created: ${child.id}, sending prompt...`);
    await ctx.session.prompt({
      sessionID: child.id,
      text: prompt,
    });

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
          const pChild = await ctx.session.create({
            parentID: sessionID as any,
            title: pp.description || "Parallel subtask",
            agent: (pp.agent as any) || "build",
            model: pModel as any,
          });
          if (pp.as) {
            registerPendingResultCaptureByPrompt(pp.prompt, sessionID, pp.as);
          }
          await ctx.session.prompt({
            sessionID: pChild.id,
            text: pp.prompt,
          });
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

