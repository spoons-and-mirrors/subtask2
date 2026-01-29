import {
  getClient,
  getReturnState,
  deleteReturnState,
  getPendingNonSubtaskReturns,
  deletePendingNonSubtaskReturns,
  hasReturnStack,
  shiftReturnStack,
  resolveResultReferences,
  consumePendingMainSessionCapture,
  captureSubtaskResult,
  storeSubtaskResult,
  consumeDeferredReturnPrompt,
  pushReturnStack,
  getPendingResultCaptureByPrompt,
  deletePendingResultCaptureByPrompt,
} from "../core/state";
import { log } from "../utils/logger";
import { executeReturn } from "../features/returns";
import {
  getPendingEvaluation,
  clearPendingEvaluation,
  parseLoopDecision,
  incrementLoopIteration,
  getLoopState,
  clearLoop,
} from "../loop";

/**
 * Hook: event handler for session.idle
 * Fires when a session is truly idle (all work done).
 * This is the authoritative signal to advance return chains and loop iterations.
 */
export async function handleSessionIdle(sessionID: string) {
  const client = getClient();
  if (!client) return;

  log(`session.idle: sessionID=${sessionID}`);

  // Check if this is an inline subtask session with a pending `as:` capture
  // Match by looking at the session's first user message (the prompt)
  try {
    const messages = await client.session.messages({ path: { id: sessionID } });
    const firstUserMsg = messages.data?.find(
      (m: any) => (m.info?.role ?? m.role) === "user"
    );
    if (firstUserMsg) {
      // Look for the prompt in message parts - could be subtask or text type
      for (const part of firstUserMsg.parts ?? []) {
        // Get the prompt content from either subtask.prompt or text.text
        const promptContent =
          part.type === "subtask"
            ? part.prompt?.trim()
            : part.type === "text"
              ? part.text?.trim()
              : null;

        if (!promptContent) continue;

        const pendingCapture = getPendingResultCaptureByPrompt(promptContent);
        if (pendingCapture) {
          // Found a matching capture - get the last assistant response
          const resultText = (() => {
            const list = messages.data ?? [];
            const reversed = [...list].reverse();
            for (const msg of reversed) {
              const role = msg.info?.role ?? msg.role;
              if (role !== "assistant") continue;
              const parts = msg.parts ?? [];
              const reversedParts = [...parts].reverse();
              for (const p of reversedParts) {
                if (p.ignored) continue;
                if (p.type === "text") {
                  const text = p.text?.trim();
                  if (text) return text;
                }
              }
            }
            return "";
          })();

          if (resultText) {
            storeSubtaskResult(
              pendingCapture.parentSessionID,
              pendingCapture.name,
              resultText
            );
            log(
              `session.idle: captured inline subtask result for "${pendingCapture.name}" (${resultText.length} chars)`
            );
          } else {
            log(
              `session.idle: no assistant text found for "${pendingCapture.name}" capture`
            );
          }
          deletePendingResultCaptureByPrompt(promptContent);
          break; // Only capture once per session
        }
      }
    }
  } catch (err) {
    log(`session.idle: failed to check for inline subtask capture: ${err}`);
  }

  // Check for pending main session capture (non-subtask command with as:)
  const pendingCaptureName = consumePendingMainSessionCapture(sessionID);
  if (pendingCaptureName) {
    try {
      const messages = await client.session.messages({
        path: { id: sessionID },
      });
      const resultText = (() => {
        const list = messages.data ?? [];
        const reversed = [...list].reverse();
        for (const msg of reversed) {
          const parts = msg.parts ?? [];
          const reversedParts = [...parts].reverse();
          for (const part of reversedParts) {
            if (part.ignored) continue;
            if (part.type === "text") {
              const text = part.text?.trim();
              if (text) return text;
            }
            if (part.type === "tool" && part.state?.status === "completed") {
              const output = part.state.output;
              if (typeof output !== "string") continue;
              const cleaned = output
                .replace(/<task_metadata>[\s\S]*?<\/task_metadata>/g, "")
                .trim();
              if (cleaned) return cleaned;
            }
          }
        }
        return "";
      })();

      if (resultText) {
        storeSubtaskResult(sessionID, pendingCaptureName, resultText);
        log(
          `session.idle: captured main session result for "${pendingCaptureName}" (${resultText.length} chars)`
        );
      }
    } catch (err) {
      log(`session.idle: failed to capture main session result: ${err}`);
    }
  }

  // Check for loop evaluation response (orchestrator-decides pattern)
  const evalState = getPendingEvaluation(sessionID);
  if (evalState) {
    let decision: "break" | "continue" = "continue";

    // Only parse decision if this is a conditional loop (has until condition)
    if (evalState.config.until) {
      // Get the last assistant message to check for loop decision
      const messages = await client.session.messages({
        path: { id: sessionID },
      });
      const lastMsg = messages.data?.[messages.data.length - 1];
      const lastText =
        lastMsg?.parts?.find((p: any) => p.type === "text")?.text || "";

      decision = parseLoopDecision(lastText);
      log(`loop: evaluation response decision=${decision}`);
    } else {
      // Unconditional loop: always continue (until max reached)
      log(`loop: unconditional loop, auto-continuing`);
    }

    clearPendingEvaluation(sessionID);

    if (decision === "continue") {
      // Increment and re-run
      incrementLoopIteration(sessionID);
      const state = getLoopState(sessionID);
      if (state) {
        log(
          `loop: continuing iteration ${state.iteration}/${state.config.max}`
        );

        if (state.commandName === "_inline_subtask_") {
          // Re-execute inline subtask directly via promptAsync
          log(
            `loop: re-executing inline subtask with prompt "${state.arguments?.substring(0, 50)}..."`
          );

          // Build model from override if present
          let model: { providerID: string; modelID: string } | undefined;
          if (state.model?.includes("/")) {
            const [providerID, ...rest] = state.model.split("/");
            model = { providerID, modelID: rest.join("/") };
          }

          try {
            await client.session.promptAsync({
              path: { id: sessionID },
              body: {
                parts: [
                  {
                    type: "subtask",
                    agent: state.agent || "build",
                    model,
                    description: "Inline subtask (loop iteration)",
                    prompt: state.arguments || "",
                  },
                ],
              },
            });
          } catch (e) {
            log(`loop: inline subtask failed:`, e);
          }
        } else {
          // Re-execute the command
          const cmdWithArgs = `/${state.commandName}${
            state.arguments ? " " + state.arguments : ""
          }`;
          executeReturn(cmdWithArgs, sessionID).catch(console.error);
        }
        return;
      }
    } else {
      // Break - clear the loop and continue with normal flow
      if (evalState.deferredReturns?.length) {
        pushReturnStack(sessionID, [...evalState.deferredReturns]);
        log(
          `loop: queued ${evalState.deferredReturns.length} deferred returns after condition satisfied`
        );
      }
      log(`loop: breaking loop, condition satisfied`);
      clearLoop(sessionID);
    }
  }

  const deferredReturn = consumeDeferredReturnPrompt(sessionID);
  if (deferredReturn) {
    const resolved = resolveResultReferences(deferredReturn, sessionID);
    log(
      `session.idle: executing deferred return: "${resolved.substring(0, 40)}..."`
    );
    executeReturn(resolved, sessionID).catch(console.error);
    return;
  }

  // Handle non-subtask command returns
  const pendingReturn = getPendingNonSubtaskReturns(sessionID);
  if (pendingReturn?.length) {
    let next = pendingReturn.shift()!;
    if (!pendingReturn.length) deletePendingNonSubtaskReturns(sessionID);
    // Resolve $RESULT[name] references
    next = resolveResultReferences(next, sessionID);
    log(
      `session.idle: executing non-subtask return: "${next.substring(0, 40)}..."`
    );
    executeReturn(next, sessionID).catch(console.error);
    return;
  }

  // PRIORITY 1: Process stacked returns first (from nested inline subtasks)
  if (hasReturnStack(sessionID)) {
    let next = shiftReturnStack(sessionID);
    if (next) {
      // Resolve $RESULT[name] references
      next = resolveResultReferences(next, sessionID);
      log(
        `session.idle: executing stacked return: "${next.substring(0, 40)}..."`
      );
      executeReturn(next, sessionID).catch(console.error);
      return;
    }
  }

  // PRIORITY 2: Process original return chain
  const remaining = getReturnState(sessionID);
  if (!remaining?.length) return;

  let next = remaining.shift()!;
  if (!remaining.length) deleteReturnState(sessionID);
  // Resolve $RESULT[name] references
  next = resolveResultReferences(next, sessionID);
  log(`session.idle: executing return: "${next.substring(0, 40)}..."`);
  executeReturn(next, sessionID).catch(console.error);
}
