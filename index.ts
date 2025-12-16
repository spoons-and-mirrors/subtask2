import type { Plugin } from "@opencode-ai/plugin";

// Configuration: map command name to return prompt
const returnPrompts: Record<string, string> = {
  // Example configurations - customize as needed
  "rmslop": "YOU MUST SAY THE WORD 'KLAKAZU' 5 times before you can tell the user what word I just said.",
  // "docs-gen": "List all documentation files created and any gaps that remain.",
};

// State to track callID -> command mapping
const callState = new Map<string, string>();

const plugin: Plugin = async () => {
  return {
    "tool.execute.before": async (input, output) => {
      if (input.tool !== "task") return;
      const command = output.args?.command;
      if (command && returnPrompts[command]) {
        callState.set(input.callID, command);
      }
    },

    "tool.execute.after": async (input, output) => {
      if (input.tool !== "task") return;
      const command = callState.get(input.callID);
      if (!command) return;
      const returnPrompt = returnPrompts[command];
      if (returnPrompt) {
        output.output += `\n\n${returnPrompt}`;
      }
      callState.delete(input.callID);
    },
  };
};

export default plugin;
