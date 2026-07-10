import type { LoopConfig } from "./types";

export interface LoopState {
  config: LoopConfig;
  iteration: number;
  commandName: string;
  arguments: string;
  model?: string;
  agent?: string;
  deferredReturns?: string[];
}

// Track active retry loops by session ID
const activeLoops = new Map<string, LoopState>();

// Track sessions pending loop evaluation (after subtask returns, main LLM evaluates)
const pendingLoopEvaluation = new Map<string, LoopState>();

// Re-export from prompts.ts
export {
  loopEvaluationPrompt as createEvaluationPrompt,
  loopYieldPrompt as createYieldPrompt,
} from "./utils/prompts";

/**
 * Parse the main LLM's response for loop decision
 * Only looks for break signal: <subtask2 loop=break/>, <subtask2 loop="break"/>, <subtask2 loop='break'/>
 * If no break signal found, loop continues by default (until max iterations)
 */
export function parseLoopDecision(output: string): "break" | "continue" {
  const match = output.match(/<subtask2\s+loop\s*=\s*["']?break["']?\s*\/?>/i);
  return match ? "break" : "continue";
}

/**
 * Start tracking a retry loop for a session
 */
export function startLoop(
  sessionId: string,
  config: LoopConfig,
  commandName: string,
  args: string,
  model?: string,
  agent?: string,
  deferredReturns?: string[]
): void {
  activeLoops.set(sessionId, {
    config,
    iteration: 1,
    commandName,
    arguments: args,
    model,
    agent,
    deferredReturns,
  });
}

/**
 * Get current retry state for a session
 */
export function getLoopState(sessionId: string): LoopState | undefined {
  return activeLoops.get(sessionId);
}

/**
 * Increment iteration count
 */
export function incrementLoopIteration(sessionId: string): number {
  const state = activeLoops.get(sessionId);
  if (state) {
    state.iteration++;
    return state.iteration;
  }
  return 0;
}

/**
 * Clear retry loop for a session
 */
export function clearLoop(sessionId: string): void {
  activeLoops.delete(sessionId);
}

/**
 * Check if we've hit max iterations
 */
export function isMaxIterationsReached(sessionId: string): boolean {
  const state = activeLoops.get(sessionId);
  if (!state) return true;
  return state.iteration >= state.config.max;
}

/**
 * Set pending evaluation state (after subtask completes, before main LLM evaluates)
 */
export function setPendingEvaluation(
  sessionId: string,
  state: LoopState
): void {
  pendingLoopEvaluation.set(sessionId, state);
}

/**
 * Get pending evaluation state
 */
export function getPendingEvaluation(sessionId: string): LoopState | undefined {
  return pendingLoopEvaluation.get(sessionId);
}

/**
 * Get all pending evaluations (for iteration in hooks)
 */
export function getAllPendingEvaluations(): Map<string, LoopState> {
  return pendingLoopEvaluation;
}

/**
 * Clear pending evaluation
 */
export function clearPendingEvaluation(sessionId: string): void {
  pendingLoopEvaluation.delete(sessionId);
}
