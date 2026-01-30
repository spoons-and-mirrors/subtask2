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
  hasPendingStackedPromptResponse,
  clearPendingStackedPromptResponse,
  setPendingStackedPromptResponse,
  setPendingPromptReturn,
  setSubtaskParentSession,
  getSubtaskParentSession,
  consumePendingParentForPrompt,
  setLastReturnType,
  getPendingReturn,
  deletePendingReturn,
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

  // 1. Resolve parent session if this is a subtask session
  // We need to check for parent session early because returns are stored under the parent
  let parentSessionID = getSubtaskParentSession(sessionID);

  // If not already mapped, try to map it by looking at the first user message
  if (!parentSessionID) {
    try {
      const messages = await client.session.messages({
        path: { id: sessionID },
      });
      const firstUserMsg = messages.data?.find(
        (m: any) => (m.info?.role ?? m.role) === "user"
      );
      if (firstUserMsg) {
        for (const part of firstUserMsg.parts ?? []) {
          const promptContent =
            part.type === "subtask"
              ? part.prompt?.trim()
              : part.type === "text"
                ? part.text?.trim()
                : null;

          if (!promptContent) continue;

          const mappedParent = consumePendingParentForPrompt(promptContent);
          if (mappedParent && mappedParent !== sessionID) {
            setSubtaskParentSession(sessionID, mappedParent);
            parentSessionID = mappedParent;
            log(
              `session.idle: mapped subtask ${sessionID} -> parent ${parentSessionID}`
            );
          }

          // Check for pending result capture (as: override)
          const pendingCapture = getPendingResultCaptureByPrompt(promptContent);
          if (pendingCapture) {
            if (pendingCapture.parentSessionID !== sessionID) {
              setSubtaskParentSession(
                sessionID,
                pendingCapture.parentSessionID
              );
              parentSessionID = pendingCapture.parentSessionID;
              log(
                `session.idle: mapped subtask ${sessionID} -> parent ${parentSessionID} (from capture)`
              );
            }

            // Capture the result
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
                `session.idle: captured inline subtask result for "${pendingCapture.name}"`
              );
            }
            deletePendingResultCaptureByPrompt(promptContent);
          }
        }
      }
    } catch (err) {
      log(`session.idle: failed to resolve parent session: ${err}`);
    }
  }

  const targetSessionID = parentSessionID || sessionID;
  if (targetSessionID !== sessionID) {
    log(`session.idle: operating on targetSessionID=${targetSessionID}`);
  }

  // 2. Check for pending main session capture (non-subtask command with as:)
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
          `session.idle: captured main session result for "${pendingCaptureName}"`
        );
      }
    } catch (err) {
      log(`session.idle: failed to capture main session result: ${err}`);
    }
  }

  // 3. Check for loop evaluation response
  const evalState = getPendingEvaluation(sessionID);
  if (evalState) {
    let decision: "break" | "continue" = "continue";

    if (evalState.config.until) {
      const messages = await client.session.messages({
        path: { id: sessionID },
      });
      const lastMsg = messages.data?.[messages.data.length - 1];
      const lastText =
        lastMsg?.parts?.find((p: any) => p.type === "text")?.text || "";

      decision = parseLoopDecision(lastText);
      log(`loop: evaluation response decision=${decision}`);
    } else {
      log(`loop: unconditional loop, auto-continuing`);
    }

    clearPendingEvaluation(sessionID);

    if (decision === "continue") {
      incrementLoopIteration(sessionID);
      const state = getLoopState(sessionID);
      if (state) {
        log(
          `loop: continuing iteration ${state.iteration}/${state.config.max}`
        );

        if (state.commandName === "_inline_subtask_") {
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
          const cmdWithArgs = `/${state.commandName}${
            state.arguments ? " " + state.arguments : ""
          }`;
          executeReturn(cmdWithArgs, sessionID).catch(console.error);
        }
        return;
      }
    } else {
      if (evalState.deferredReturns?.length) {
        pushReturnStack(sessionID, [...evalState.deferredReturns]);
      }
      log(`loop: breaking loop, condition satisfied`);
      clearLoop(sessionID);
    }
  }

  // 4. Process Returns (Priority Order)

  // A. Deferred return prompt from a previous turn
  const deferredReturn = consumeDeferredReturnPrompt(targetSessionID);
  if (deferredReturn) {
    const resolved = resolveResultReferences(deferredReturn, targetSessionID);
    log(
      `session.idle: executing deferred return: "${resolved.substring(0, 40)}..."`
    );
    executeReturn(resolved, targetSessionID).catch(console.error);
    return;
  }

  // B. Pending first return (if message-hooks missed it)
  const pendingFirst = getPendingReturn(targetSessionID);
  if (pendingFirst) {
    deletePendingReturn(targetSessionID);
    const resolved = resolveResultReferences(pendingFirst, targetSessionID);
    log(
      `session.idle: executing pendingReturn (first): "${resolved.substring(0, 40)}..."`
    );

    if (resolved.startsWith("/")) {
      executeReturn(resolved, targetSessionID).catch(console.error);
      return;
    }

    setLastReturnType(targetSessionID, "prompt");
    setPendingStackedPromptResponse(targetSessionID);
    try {
      await client.session.promptAsync({
        path: { id: targetSessionID },
        body: { parts: [{ type: "text", text: resolved }] },
      });
    } catch (e) {
      log(`session.idle: pendingReturn promptAsync failed: ${e}`);
      clearPendingStackedPromptResponse(targetSessionID);
    }
    return;
  }

  // C. Stacked returns (from inline subtasks)
  if (hasReturnStack(targetSessionID)) {
    let next = shiftReturnStack(targetSessionID);
    if (next) {
      next = resolveResultReferences(next, targetSessionID);
      log(
        `session.idle: executing stacked return: "${next.substring(0, 40)}..."`
      );
      executeReturn(next, targetSessionID).catch(console.error);
      return;
    }
  }

  // D. Original return chain
  const remaining = getReturnState(targetSessionID);
  if (remaining?.length) {
    let next = remaining.shift()!;
    if (!remaining.length) deleteReturnState(targetSessionID);
    next = resolveResultReferences(next, targetSessionID);

    if (next.startsWith("/")) {
      log(`session.idle: executing return: "${next.substring(0, 40)}..."`);
      executeReturn(next, targetSessionID).catch(console.error);
    } else {
      log(
        `session.idle: setting pending prompt return: "${next.substring(0, 40)}..."`
      );
      // Set pending prompt for message-hooks to inject into current LLM call
      setPendingPromptReturn(targetSessionID, next);
      setLastReturnType(targetSessionID, "prompt");

      // Also persist the message via promptAsync so it appears in history
      // This is needed because injection into output.messages doesn't persist
      client.session
        .promptAsync({
          path: { id: targetSessionID },
          body: { parts: [{ type: "text", text: next }] },
        })
        .catch((e: any) => log(`session.idle: promptAsync failed: ${e}`));
    }
    return;
  }

  // E. Non-subtask command returns
  const pendingNonSubtask = getPendingNonSubtaskReturns(targetSessionID);
  if (pendingNonSubtask?.length) {
    let next = pendingNonSubtask.shift()!;
    if (!pendingNonSubtask.length)
      deletePendingNonSubtaskReturns(targetSessionID);
    next = resolveResultReferences(next, targetSessionID);
    log(
      `session.idle: executing non-subtask return: "${next.substring(0, 40)}..."`
    );
    executeReturn(next, targetSessionID).catch(console.error);
    return;
  }

  // 5. Cleanup
  if (hasPendingStackedPromptResponse(targetSessionID)) {
    clearPendingStackedPromptResponse(targetSessionID);
    log(`session.idle: cleared pending prompt flag`);
  }
}
