import type { CommandConfig, Subtask2Config } from "../types";
import type { LoopState } from "../loop";

/**
 * Centralized session state management for subtask2 plugin
 * All plugin state is managed through this module
 */

// Command configurations loaded from manifest
let configs: Record<string, CommandConfig> = {};

// Plugin user configuration
let pluginConfig: Subtask2Config = { replace_generic: true };

// OpenCode client instance (v1 SDK with internal HTTP client)
let client: any = null;

// Session state maps
const callState = new Map<string, string>();
const returnState = new Map<string, string[]>();
const returnStack = new Map<string, string[][]>(); // Stack of return chains for nested returns
const pendingReturns = new Map<string, string>();
const pendingNonSubtaskReturns = new Map<string, string[]>();
const pipedArgsQueue = new Map<string, string[]>();
const returnArgsState = pipedArgsQueue; // alias for backward compat
const sessionMainCommand = new Map<string, string>();
const processedS2Messages = new Set<string>();
const executedReturns = new Set<string>();
const firstReturnPrompt = new Map<string, string>();
const subtaskParentSession = new Map<string, string>();
const pendingModelOverride = new Map<string, string>();
const pendingAgentOverride = new Map<string, string>();
const deferredReturnPrompt = new Map<string, string>();
// Track sessions that just had a stacked return prompt substituted
// session.idle should skip returnState processing until LLM responds
const pendingStackedPromptResponse = new Set<string>();
// Track the type of the last executed return to handle prompt returns correctly
// after inline subtasks (which don't inject "Summarize..." message)
const lastReturnType = new Map<
  string,
  "inline_subtask" | "command" | "prompt"
>();

// Pending prompt return to be substituted in message-hooks.ts
// session.idle sets this, message-hooks consumes it during transform
const pendingPromptReturn = new Map<string, string>();

// Named subtask results storage: parentSessionID -> Map<name, result>
const subtaskResults = new Map<string, Map<string, string>>();

// Pending `as:` names for subtasks: subtaskSessionID -> {parentSessionID, name}
const pendingResultCapture = new Map<
  string,
  { parentSessionID: string; name: string }
>();

// Pending `as:` by prompt content (race-safe, like pendingParentForPrompt)
const pendingResultCaptureByPrompt = new Map<
  string,
  { parentSessionID: string; name: string }
>();

// Pending main session result capture (for non-subtask commands with as:)
const pendingMainSessionCapture = new Map<string, string>();

// Pending parent sessions keyed by prompt content (for race-safe session mapping)
const pendingParentByPrompt = new Map<string, string>();
let hasActiveSubtask = false;

// Constants
export const OPENCODE_GENERIC =
  "Summarize the task tool output above and continue with your task.";

// ============================================================================
// Configs
// ============================================================================

export function getConfigs(): Record<string, CommandConfig> {
  return configs;
}

export function setConfigs(newConfigs: Record<string, CommandConfig>): void {
  configs = newConfigs;
}

export function getPluginConfig(): Subtask2Config {
  return pluginConfig;
}

export function setPluginConfig(newConfig: Subtask2Config): void {
  pluginConfig = newConfig;
}

// ============================================================================
// Client
// ============================================================================

export function getClient(): any {
  return client;
}

export function setClient(newClient: any): void {
  client = newClient;
}

// ============================================================================
// Call State
// ============================================================================

export function getCallState(callID: string): string | undefined {
  return callState.get(callID);
}

export function setCallState(callID: string, cmd: string): void {
  callState.set(callID, cmd);
}

export function deleteCallState(callID: string): void {
  callState.delete(callID);
}

// ============================================================================
// Return State
// ============================================================================

export function getReturnState(sessionID: string): string[] | undefined {
  return returnState.get(sessionID);
}

export function setReturnState(sessionID: string, returns: string[]): void {
  returnState.set(sessionID, returns);
}

export function hasReturnState(sessionID: string): boolean {
  return returnState.has(sessionID);
}

export function deleteReturnState(sessionID: string): void {
  returnState.delete(sessionID);
}

// ============================================================================
// Return Stack (for nested returns)
// ============================================================================

/**
 * Push a new return chain onto the stack.
 * Used when an inline subtask has its own returns.
 */
export function pushReturnStack(sessionID: string, returns: string[]): void {
  if (!returnStack.has(sessionID)) {
    returnStack.set(sessionID, []);
  }
  returnStack.get(sessionID)!.push(returns);
}

/**
 * Get the current (top) return chain from the stack.
 * Returns undefined if stack is empty.
 */
export function peekReturnStack(sessionID: string): string[] | undefined {
  const stack = returnStack.get(sessionID);
  if (!stack || stack.length === 0) return undefined;
  return stack[stack.length - 1];
}

/**
 * Pop the current return chain from the stack (when it's exhausted).
 */
export function popReturnStack(sessionID: string): void {
  const stack = returnStack.get(sessionID);
  if (stack && stack.length > 0) {
    stack.pop();
    if (stack.length === 0) {
      returnStack.delete(sessionID);
    }
  }
}

/**
 * Check if there are any return chains on the stack.
 */
export function hasReturnStack(sessionID: string): boolean {
  const stack = returnStack.get(sessionID);
  return stack !== undefined && stack.length > 0;
}

/**
 * Get the entire current return chain from the stack (the top chain).
 * Returns undefined if stack is empty.
 * This is used to transfer stacked returns to returnState.
 */
export function getCurrentReturnChain(sessionID: string): string[] | undefined {
  const stack = returnStack.get(sessionID);
  if (!stack || stack.length === 0) return undefined;
  return stack[stack.length - 1];
}

/**
 * Remove the current return chain from the stack (pop it).
 * Call this after transferring the chain to returnState.
 */
export function popCurrentReturnChain(sessionID: string): void {
  const stack = returnStack.get(sessionID);
  if (stack && stack.length > 0) {
    stack.pop();
    if (stack.length === 0) {
      returnStack.delete(sessionID);
    }
  }
}

/**
 * Shift the next return item from the current chain.
 * If chain becomes empty, pops it from the stack.
 * Returns undefined if no returns left.
 */
export function shiftReturnStack(sessionID: string): string | undefined {
  const stack = returnStack.get(sessionID);
  if (!stack || stack.length === 0) return undefined;

  const currentChain = stack[stack.length - 1];
  if (!currentChain || currentChain.length === 0) {
    stack.pop();
    if (stack.length === 0) {
      returnStack.delete(sessionID);
    }
    return undefined;
  }

  const next = currentChain.shift();

  // If chain is now empty, pop it
  if (currentChain.length === 0) {
    stack.pop();
    if (stack.length === 0) {
      returnStack.delete(sessionID);
    }
  }

  return next;
}

/**
 * Clear all return stacks for a session.
 */
export function clearReturnStack(sessionID: string): void {
  returnStack.delete(sessionID);
}

// ============================================================================
// Pending Returns
// ============================================================================

export function getPendingReturn(sessionID: string): string | undefined {
  return pendingReturns.get(sessionID);
}

export function setPendingReturn(
  sessionID: string,
  returnPrompt: string
): void {
  pendingReturns.set(sessionID, returnPrompt);
}

export function hasPendingReturn(sessionID: string): boolean {
  return pendingReturns.has(sessionID);
}

export function deletePendingReturn(sessionID: string): void {
  pendingReturns.delete(sessionID);
}

export function getAllPendingReturns(): IterableIterator<[string, string]> {
  return pendingReturns.entries();
}

// ============================================================================
// Pending Non-Subtask Returns
// ============================================================================

export function getPendingNonSubtaskReturns(
  sessionID: string
): string[] | undefined {
  return pendingNonSubtaskReturns.get(sessionID);
}

export function setPendingNonSubtaskReturns(
  sessionID: string,
  returns: string[]
): void {
  pendingNonSubtaskReturns.set(sessionID, returns);
}

export function deletePendingNonSubtaskReturns(sessionID: string): void {
  pendingNonSubtaskReturns.delete(sessionID);
}

// ============================================================================
// Piped Args Queue
// ============================================================================

export function getPipedArgsQueue(sessionID: string): string[] | undefined {
  return pipedArgsQueue.get(sessionID);
}

export function setPipedArgsQueue(sessionID: string, args: string[]): void {
  pipedArgsQueue.set(sessionID, args);
}

export function deletePipedArgsQueue(sessionID: string): void {
  pipedArgsQueue.delete(sessionID);
}

export function getReturnArgsState(sessionID: string): string[] | undefined {
  return returnArgsState.get(sessionID);
}

export function deleteReturnArgsState(sessionID: string): void {
  returnArgsState.delete(sessionID);
}

// ============================================================================
// Session Main Command
// ============================================================================

export function getSessionMainCommand(sessionID: string): string | undefined {
  return sessionMainCommand.get(sessionID);
}

export function setSessionMainCommand(sessionID: string, cmd: string): void {
  sessionMainCommand.set(sessionID, cmd);
}

// ============================================================================
// Processed S2 Messages
// ============================================================================

export function hasProcessedS2Message(msgId: string): boolean {
  return processedS2Messages.has(msgId);
}

export function addProcessedS2Message(msgId: string): void {
  processedS2Messages.add(msgId);
}

// ============================================================================
// Executed Returns
// ============================================================================

export function hasExecutedReturn(key: string): boolean {
  return executedReturns.has(key);
}

export function addExecutedReturn(key: string): void {
  executedReturns.add(key);
}

export function deleteExecutedReturn(key: string): void {
  executedReturns.delete(key);
}

// ============================================================================
// First Return Prompt
// ============================================================================

export function getFirstReturnPrompt(sessionID: string): string | undefined {
  return firstReturnPrompt.get(sessionID);
}

export function setFirstReturnPrompt(sessionID: string, prompt: string): void {
  firstReturnPrompt.set(sessionID, prompt);
}

// ============================================================================
// Subtask Parent Session
// ============================================================================

export function getSubtaskParentSession(sessionID: string): string | undefined {
  return subtaskParentSession.get(sessionID);
}

export function setSubtaskParentSession(
  sessionID: string,
  parentID: string
): void {
  subtaskParentSession.set(sessionID, parentID);
}

export function deleteSubtaskParentSession(sessionID: string): void {
  subtaskParentSession.delete(sessionID);
}

// ============================================================================
// Pending Model Override
// ============================================================================

export function getPendingModelOverride(sessionID: string): string | undefined {
  return pendingModelOverride.get(sessionID);
}

export function setPendingModelOverride(
  sessionID: string,
  model: string
): void {
  pendingModelOverride.set(sessionID, model);
}

export function deletePendingModelOverride(sessionID: string): void {
  pendingModelOverride.delete(sessionID);
}

export function getPendingAgentOverride(sessionID: string): string | undefined {
  return pendingAgentOverride.get(sessionID);
}

export function setPendingAgentOverride(
  sessionID: string,
  agent: string
): void {
  pendingAgentOverride.set(sessionID, agent);
}

export function deletePendingAgentOverride(sessionID: string): void {
  pendingAgentOverride.delete(sessionID);
}

// ============================================================================
// Deferred Return Prompt (used for loops)
// ============================================================================

export function getDeferredReturnPrompt(sessionID: string): string | undefined {
  return deferredReturnPrompt.get(sessionID);
}

export function setDeferredReturnPrompt(
  sessionID: string,
  prompt: string
): void {
  if (!deferredReturnPrompt.has(sessionID)) {
    deferredReturnPrompt.set(sessionID, prompt);
  }
}

export function consumeDeferredReturnPrompt(
  sessionID: string
): string | undefined {
  const prompt = deferredReturnPrompt.get(sessionID);
  if (prompt) {
    deferredReturnPrompt.delete(sessionID);
  }
  return prompt;
}

// ============================================================================
// Last Return Type Tracking
// ============================================================================

/**
 * Set the type of the last executed return for a session.
 * Used to determine if a prompt return should be deferred to message-hooks
 * or executed directly (when following an inline subtask).
 */
export function setLastReturnType(
  sessionID: string,
  type: "inline_subtask" | "command" | "prompt"
): void {
  lastReturnType.set(sessionID, type);
}

/**
 * Get the type of the last executed return for a session.
 */
export function getLastReturnType(
  sessionID: string
): "inline_subtask" | "command" | "prompt" | undefined {
  return lastReturnType.get(sessionID);
}

/**
 * Clear the last return type for a session.
 */
export function clearLastReturnType(sessionID: string): void {
  lastReturnType.delete(sessionID);
}

// ============================================================================
// Pending Stacked Prompt Response
// ============================================================================

/**
 * Mark that a session just had a stacked return PROMPT substituted.
 * session.idle should skip returnState processing until LLM responds.
 */
export function setPendingStackedPromptResponse(sessionID: string): void {
  pendingStackedPromptResponse.add(sessionID);
}

/**
 * Check if a session is waiting for LLM response to a stacked prompt.
 */
export function hasPendingStackedPromptResponse(sessionID: string): boolean {
  return pendingStackedPromptResponse.has(sessionID);
}

/**
 * Clear the pending stacked prompt response flag.
 * Called when session.idle fires after the LLM has responded.
 */
export function clearPendingStackedPromptResponse(sessionID: string): void {
  pendingStackedPromptResponse.delete(sessionID);
}

// ============================================================================
// Pending Prompt Return (deferred to message-hooks.ts for substitution)
// ============================================================================

/**
 * Set a pending prompt return to be substituted in message-hooks.ts.
 * Called by session.idle when processing a prompt return.
 */
export function setPendingPromptReturn(
  sessionID: string,
  prompt: string
): void {
  pendingPromptReturn.set(sessionID, prompt);
}

/**
 * Get and clear the pending prompt return for a session.
 * Called by message-hooks.ts during transform to substitute the generic message.
 */
export function consumePendingPromptReturn(
  sessionID: string
): string | undefined {
  const prompt = pendingPromptReturn.get(sessionID);
  if (prompt) {
    pendingPromptReturn.delete(sessionID);
  }
  return prompt;
}

export function clearPendingPromptReturn(sessionID: string): void {
  pendingPromptReturn.delete(sessionID);
}

/**
 * Check if there's a pending prompt return for substitution.
 */
export function hasPendingPromptReturn(sessionID: string): boolean {
  return pendingPromptReturn.has(sessionID);
}

// ============================================================================
// Pending Parent Session (keyed by prompt for race safety)
// ============================================================================

/**
 * Register a parent session for a subtask prompt.
 * Called in command.execute.before after all prompt modifications.
 */
export function registerPendingParentForPrompt(
  prompt: string,
  parentSessionID: string
): void {
  pendingParentByPrompt.set(prompt, parentSessionID);
}

/**
 * Look up and consume the parent session for a subtask prompt.
 * Called in tool.execute.before to map subtask -> parent.
 */
export function consumePendingParentForPrompt(prompt: string): string | null {
  const parentSession = pendingParentByPrompt.get(prompt);
  if (parentSession) {
    pendingParentByPrompt.delete(prompt);
  }
  return parentSession ?? null;
}

// ============================================================================
// Has Active Subtask
// ============================================================================

export function getHasActiveSubtask(): boolean {
  return hasActiveSubtask;
}

export function setHasActiveSubtask(value: boolean): void {
  hasActiveSubtask = value;
}

// ============================================================================
// Named Subtask Results ($RESULT[name])
// ============================================================================

/**
 * Register a pending main session capture.
 * Called when a non-subtask command with `as:` is executed.
 * The next LLM turn will be captured under this name.
 */
export function registerPendingMainSessionCapture(
  sessionID: string,
  name: string
): void {
  pendingMainSessionCapture.set(sessionID, name);
}

/**
 * Consume a pending main session capture.
 * Returns the name to capture under, or undefined if none pending.
 */
export function consumePendingMainSessionCapture(
  sessionID: string
): string | undefined {
  const name = pendingMainSessionCapture.get(sessionID);
  if (name) {
    pendingMainSessionCapture.delete(sessionID);
  }
  return name;
}

/**
 * Register a pending result capture by prompt content.
 * Called when spawning a subtask with `as:` name (before we know the session ID).
 * NOTE: We keep this until session.idle matches the prompt, since tool.after
 * doesn't have access to inline subtask output.
 */
export function registerPendingResultCaptureByPrompt(
  prompt: string,
  parentSessionID: string,
  name: string
): void {
  pendingResultCaptureByPrompt.set(prompt, { parentSessionID, name });
}

/**
 * Consume a pending result capture by prompt content.
 * Called when tool.execute.before fires and we know the subtask session ID.
 */
export function consumePendingResultCaptureByPrompt(
  prompt: string
): { parentSessionID: string; name: string } | undefined {
  const entry = pendingResultCaptureByPrompt.get(prompt);
  if (entry) {
    pendingResultCaptureByPrompt.delete(prompt);
  }
  return entry;
}

/**
 * Check if a prompt has a pending result capture (without consuming).
 * Used in session.idle to match subtask sessions by prompt content.
 */
export function getPendingResultCaptureByPrompt(
  prompt: string
): { parentSessionID: string; name: string } | undefined {
  return pendingResultCaptureByPrompt.get(prompt);
}

/**
 * Delete a pending result capture by prompt (after capturing in session.idle).
 */
export function deletePendingResultCaptureByPrompt(prompt: string): void {
  pendingResultCaptureByPrompt.delete(prompt);
}

/**
 * Register a pending result capture by subtask session ID.
 * Called when spawning a subtask with `as:` name.
 */
export function registerPendingResultCapture(
  subtaskSessionID: string,
  parentSessionID: string,
  name: string
): void {
  pendingResultCapture.set(subtaskSessionID, { parentSessionID, name });
}

/**
 * Check if a subtask session has a pending result capture.
 */
export function getPendingResultCapture(
  subtaskSessionID: string
): { parentSessionID: string; name: string } | undefined {
  return pendingResultCapture.get(subtaskSessionID);
}

/**
 * Consume and store a subtask result.
 * Called when subtask completes - stores result and removes pending entry.
 */
export function captureSubtaskResult(
  subtaskSessionID: string,
  result: string
): void {
  const pending = pendingResultCapture.get(subtaskSessionID);
  if (!pending) return;

  const { parentSessionID, name } = pending;

  if (!subtaskResults.has(parentSessionID)) {
    subtaskResults.set(parentSessionID, new Map());
  }
  subtaskResults.get(parentSessionID)!.set(name, result);

  pendingResultCapture.delete(subtaskSessionID);
}

/**
 * Store a named result directly for a session (used for main session captures).
 */
export function storeSubtaskResult(
  sessionID: string,
  name: string,
  result: string
): void {
  if (!subtaskResults.has(sessionID)) {
    subtaskResults.set(sessionID, new Map());
  }
  subtaskResults.get(sessionID)!.set(name, result);
}

/**
 * Get a named result for a session.
 */
export function getSubtaskResult(
  sessionID: string,
  name: string
): string | undefined {
  return subtaskResults.get(sessionID)?.get(name);
}

/**
 * Get all named results for a session.
 */
export function getAllSubtaskResults(
  sessionID: string
): Map<string, string> | undefined {
  return subtaskResults.get(sessionID);
}

/**
 * Resolve $RESULT[name] references in a string.
 */
export function resolveResultReferences(
  text: string,
  sessionID: string
): string {
  const results = subtaskResults.get(sessionID);
  if (!results || results.size === 0) return text;

  return text.replace(/\$RESULT\[([^\]]+)\]/g, (match, name) => {
    const result = results.get(name);
    return result ?? match; // Keep original if not found
  });
}

/**
 * Clear all results for a session (cleanup).
 */
export function clearSubtaskResults(sessionID: string): void {
  subtaskResults.delete(sessionID);
}
