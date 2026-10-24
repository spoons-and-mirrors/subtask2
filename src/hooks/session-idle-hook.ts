import {
  getPluginContext,
  getReturnState,
  deleteReturnState,
  getPendingNonSubtaskReturns,
  deletePendingNonSubtaskReturns,
  hasReturnStack,
  shiftReturnStack,
  resolveResultReferences,
  consumePendingMainSessionCapture,
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
  const ctx = getPluginContext();
  if (!ctx) return;

  log(`session.idle: sessionID=${sessionID}`);

  // 1. Resolve parent session if this is a subtask session
  // We need to check for parent session early because returns are stored under the parent
  let parentSessionID = getSubtaskParentSession(sessionID);

  // If not already mapped, try to map it by looking at the first user message
  if (!parentSessionID) {
    try {
      const messages = await ctx.session.context({
        sessionID: sessionID as any,
      });
      const firstUserMsg = messages?.find(
        (m: any) => m.type === "user" || m.role === "user"
      );
      if (firstUserMsg) {
        const promptContent =
          (firstUserMsg as any).text?.trim() ||
          (firstUserMsg as any).content?.find((p: any) => p.type === "text")?.text?.trim() ||
          (firstUserMsg as any).parts?.find((p: any) => p.type === "text")?.text?.trim() ||
          null;

        if (promptContent) {
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
              const list = messages ?? [];
              const reversed = [...list].reverse();
              for (const msg of reversed) {
                const role = (msg as any).type ?? (msg as any).info?.role ?? (msg as any).role;
                if (role !== "assistant") continue;
                const parts = (msg as any).content ?? (msg as any).parts ?? [];
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
      const messages = await ctx.session.context({
        sessionID: sessionID as any,
      });
      const resultText = (() => {
        const list = messages ?? [];
        const reversed = [...list].reverse();
        for (const msg of reversed) {
          const parts = (msg as any).content ?? (msg as any).parts ?? [];
          const reversedParts = [...parts].reverse();
          for (const part of reversedParts) {
            if (part.ignored) continue;
            if (part.type === "text") {
              const text = part.text?.trim();
              if (text) return text;
            }
            if (part.type === "tool" && part.state?.status === "completed") {
              const contentArr = (part.state as any).content || [];
              let output = "";
              for (const c of contentArr) {
                if (c.type === "text" && c.text) output += c.text + "\n";
              }
              output = output
                .replace(/<task_metadata>[\s\S]*?<\/task_metadata>/g, "")
                .trim();
              if (output) return output;
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
      const messages = await ctx.session.context({
        sessionID: sessionID as any,
      });
      const lastMsg = messages?.[messages.length - 1];
      const parts = (lastMsg as any)?.content ?? (lastMsg as any)?.parts ?? [];
      const lastText =
        parts.find((p: any) => p.type === "text")?.text || "";

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
          let model: { id: string; providerID: string } | undefined;
          if (state.model?.includes("/")) {
            const [providerID, ...rest] = state.model.split("/");
            model = { providerID, id: rest.join("/") };
          }

          try {
            const child = await ctx.session.create({
              parentID: sessionID as any,
              title: "Inline subtask (loop iteration)",
              agent: (state.agent as any) || "build",
              model: model as any,
            });
            await ctx.session.prompt({
              sessionID: child.id,
              text: state.arguments || "",
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
      await ctx.session.prompt({
        sessionID: targetSessionID as any,
        text: resolved,
      });
    } catch (e) {
      log(`session.idle: pendingReturn prompt failed: ${e}`);
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
      setPendingPromptReturn(targetSessionID, next);
      setLastReturnType(targetSessionID, "prompt");

      ctx.session
        .prompt({
          sessionID: targetSessionID as any,
          text: next,
        })
        .catch((e: any) => log(`session.idle: prompt failed: ${e}`));
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

