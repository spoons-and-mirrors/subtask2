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
  log("=== subtask2 plugin createPlugin called ===");

  // Load config on plugin init
  loadConfig();
  log("Config loaded");

  // Set client references for all modules that need it
  setCommandClient(client);
  setMessagesClient(client);
  log("Client references set");

  // Wrapper to handle command sentinel errors
  const wrappedCommandExecuteBefore = async (input: any, output: any) => {
    log("command.execute.before ENTRY", input.command, input.sessionID);
    try {
      const result = await commandExecuteBefore(input, output);
      log("command.execute.before EXIT", input.command);
      return result;
    } catch (err: any) {
      if (err?.message === COMMAND_HANDLED) {
        // CLI command handled, stop processing
        log("Command handled by CLI");
        return output;
      }
      log("command.execute.before ERROR", err?.message);
      throw err;
    }
  };

  const wrappedToolExecuteBefore = async (input: any, output: any) => {
    log("tool.execute.before ENTRY", input.tool, input.callID);
    const result = await toolExecuteBefore(input, output);
    log("tool.execute.before EXIT", input.tool);
    return result;
  };

  const wrappedToolExecuteAfter = async (input: any, output: any) => {
    log("tool.execute.after ENTRY", input.tool, input.callID);
    const result = await toolExecuteAfter(input, output);
    log("tool.execute.after EXIT", input.tool);
    return result;
  };

  const wrappedMessagesTransform = async (input: any, output: any) => {
    log("messages.transform ENTRY", output.messages?.length, "messages");
    const result = await messagesTransform(input, output);
    log("messages.transform EXIT");
    return result;
  };

  const wrappedTextComplete = async (input: any, output: any) => {
    log("text.complete ENTRY", input.sessionID);
    const result = await textComplete(input, output);
    log("text.complete EXIT");
    return result;
  };

  log("Registering hooks...");

  return {
    "command.execute.before": wrappedCommandExecuteBefore,
    "tool.execute.before": wrappedToolExecuteBefore,
    "tool.execute.after": wrappedToolExecuteAfter,
    "experimental.chat.messages.transform": wrappedMessagesTransform,
    "experimental.text.complete": wrappedTextComplete,

    config: async (opencodeConfig: any) => {
      log("config hook called");
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
