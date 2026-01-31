// Plugin entry point - hook registration
import { log } from "./state";
import { loadConfig } from "./config";
import {
  commandExecuteBefore,
  setClient as setCommandClient,
} from "./hooks/command";
import { toolExecuteBefore, toolExecuteAfter } from "./hooks/tool";
import {
  messagesTransform,
  setClient as setMessagesClient,
} from "./hooks/messages";
import { textComplete } from "./hooks/complete";
import { COMMAND_HANDLED } from "./features/cli";

// Re-export for hooks
export { log };

// Constants
export const OPENCODE_GENERIC =
  "Summarize the task tool output above and continue with your task.";
export const DEFAULT_GENERIC_RETURN = `Review, challenge and verify the task tool output above against the codebase. Then validate or revise it, before continuing with the next logical step.`;

export function createPlugin(client: any) {
  // Load config on plugin init
  loadConfig();

  // Set client references for all modules that need it
  setCommandClient(client);
  setMessagesClient(client);

  log("plugin initialized");

  // Wrapper to handle command sentinel errors
  const wrappedCommandExecuteBefore = async (input: any, output: any) => {
    try {
      return await commandExecuteBefore(input, output);
    } catch (err: any) {
      if (err?.message === COMMAND_HANDLED) {
        // CLI command handled, stop processing
        log("Command handled by CLI");
        return output;
      }
      throw err;
    }
  };

  return {
    "command.execute.before": wrappedCommandExecuteBefore,
    "tool.execute.before": toolExecuteBefore,
    "tool.execute.after": toolExecuteAfter,
    "experimental.chat.messages.transform": messagesTransform,
    "experimental.text.complete": textComplete,

    config: async (opencodeConfig: any) => {
      opencodeConfig.command ??= {};
      opencodeConfig.command.subtask = {
        template: "",
        description:
          "Run inline subtask with overrides. Use /subtask for help.",
      };
      log("/subtask command registered");
    },
  };
}
