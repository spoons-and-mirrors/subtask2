/**
 * All prompts used by subtask2 plugin - centralized for easy editing
 */

import { loadReadmeContent } from "./config";

// Re-export for backwards compatibility
export { _resetReadmeCache } from "./config";

/**
 * Default return prompt when no return is specified and replace_generic is true
 */
export const DEFAULT_RETURN_PROMPT =
  "Review, challenge and verify the task tool output above against the codebase. Then validate or revise it, before continuing with the next logical step.";

//export const DEFAULT_RETURN_PROMPT = "SAY BANANANANANA AND NOTHING ELSE!";

/**
 * Placeholder for README content in auto workflow prompt
 */
const README_PLACEHOLDER = "{{SUBTASK2_README}}";

/**
 * Instruction for /subtask inline subtask - makes LLM say minimal response while subtask runs
 */
export const S2_INLINE_INSTRUCTION = `<system>The user has queued a tool for execution, please yield back now and say: "Running subagent..."</system>`;

/**
 * Loop evaluation prompt - used as subtask return
 */
export function loopEvaluationPrompt(
  condition: string,
  iteration: number,
  max: number
): string {
  return `<instructions subtask2=loop-evaluation>
The user chose to loop the subtask that was just executed.
Current loop progress: ${iteration}/${max} iterations.

**You are now tasked with evaluating the previous work done in context of this conversation and verify if the current codebase state satisfies the user conditions.**

<user-condition>
${condition}
</user-condition>

You may read files, check git diff/status, run tests, or do whatever verification is needed.

> DO NOT WRITE OR EDIT ANY FILES - YOU ARE ONLY TO EVALUATE AND REPORT

After evaluation:
- If the condition IS satisfied: respond with <subtask2 loop=break/> to exit the loop
- If not, the loop will re-run after you yield back

You may now proceed with the evaluation.
</instructions>`;
}

/**
 * Unconditional loop yield prompt - tells main session to yield so loop can continue
 * Used when loop has no until condition (just {loop:N})
 */
export function loopYieldPrompt(iteration: number, max: number): string {
  return `<instructions subtask2=loop-yield>
Loop progress: ${iteration}/${max} iterations.
Please yield back now to allow the next loop iteration to run.
</instructions>`;
}

/**
 * Auto workflow generation prompt (POC) - teaches LLM to generate subtask2 inline syntax
 * Contains {{SUBTASK2_README}} placeholder that gets replaced with actual README content
 */
export const AUTO_WORKFLOW_PROMPT_TEMPLATE = `You are tasked with creating a subtask2 command workflow to fulfill the user's request.

## Subtask2 Plugin Documentation

The following is the complete documentation for the subtask2 plugin. Study it carefully to understand all available features.

<subtask2-readme>
${README_PLACEHOLDER}
</subtask2-readme>

## Your Task

Using the subtask2 inline syntax documented above, create a workflow to fulfill the user's request.

### Output Format

1. Output your reasoning first - analyze what the user needs and how to best structure the workflow
2. Then output the workflow inside: <subtask2 auto="true">...</subtask2>
3. The workflow must be a single /subtask {...} command with inline syntax
4. Do NOT create files - the workflow executes in memory
5. Use returns to chain multiple steps
6. Use parallel for concurrent independent tasks

USER INPUT:
`;

/**
 * Get the auto workflow prompt with README content injected
 */
export async function getAutoWorkflowPrompt(): Promise<string> {
  const readmeContent = await loadReadmeContent();
  return AUTO_WORKFLOW_PROMPT_TEMPLATE.replace(
    README_PLACEHOLDER,
    readmeContent
  );
}

/**
 * @deprecated Use getAutoWorkflowPrompt() instead - this is kept for backwards compatibility
 * but will use a static fallback without the full README
 */
export const AUTO_WORKFLOW_PROMPT = AUTO_WORKFLOW_PROMPT_TEMPLATE.replace(
  README_PLACEHOLDER,
  "[Use getAutoWorkflowPrompt() to get full documentation]"
);
