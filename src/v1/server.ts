import { setClient, setConfigs, setPluginConfig } from "../core/state";
import { loadConfig } from "../utils/config";
import { log, clearLog } from "../utils/logger";
import { buildManifest } from "../commands/manifest";
import { commandExecuteBefore } from "../hooks/command-hooks";
import { toolExecuteBeforeV1, toolExecuteAfterV1 } from "../hooks/tool-hooks";
import { chatMessagesTransform } from "../hooks/message-hooks";
import { handleSessionIdle } from "../hooks/session-idle-hook";

/**
 * OpenCode V1 Plugin entry point (compatible with OpenCode V1 >=1.18.29)
 */
export async function server(ctx: any) {
  clearLog();
  if (ctx?.client) {
    setClient(ctx.client);
  }

  const configs = await buildManifest();
  const pluginConfig = await loadConfig();

  setConfigs(configs);
  setPluginConfig(pluginConfig);

  const allKeys = Object.keys(configs);
  const uniqueCmds = allKeys.filter(k => !k.includes("/"));
  log(`Plugin initialized (V1): ${uniqueCmds.length} commands`, uniqueCmds);

  return {
    "command.execute.before": commandExecuteBefore,
    "tool.execute.before": toolExecuteBeforeV1,
    "tool.execute.after": toolExecuteAfterV1,
    "experimental.chat.messages.transform": async (
      input: Record<string, any>,
      output: { messages: any[] }
    ) => {
      await chatMessagesTransform(input, output);
    },
    config: async (input: any) => {
      input.command ??= {};
      input.command.subtask = {
        description: "Run a command on the fly, supports all subtask2 features",
        template: "$ARGUMENTS",
        subtask: true,
      };
      log(`Registered /subtask command (V1 placeholder)`);
    },
    event: async ({ event }: { event: { type: string; properties?: any } }) => {
      if (event?.type === "session.idle") {
        const sessionID = event.properties?.sessionID;
        if (sessionID) {
          await handleSessionIdle(sessionID);
        }
      }
    },
  };
}
