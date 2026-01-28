import type { Plugin } from "@opencode-ai/plugin";
import { setClient, setConfigs, setPluginConfig } from "./state";
import { loadConfig } from "../utils/config";
import { log, clearLog } from "../utils/logger";
import { buildManifest } from "../commands/manifest";
import { commandExecuteBefore } from "../hooks/command-hooks";
import { toolExecuteBefore, toolExecuteAfter } from "../hooks/tool-hooks";
import { chatMessagesTransform } from "../hooks/message-hooks";
import { handleSessionIdle } from "../hooks/session-idle-hook";

/**
 * Core: Plugin entry point
 * Minimal plugin factory that registers hooks and initializes state
 */

export const createPlugin: Plugin = async ctx => {
  clearLog();
  const configs = await buildManifest();
  const pluginConfig = await loadConfig();

  setConfigs(configs);
  setPluginConfig(pluginConfig);

  // Use the v1 client from OpenCode - it has internal fetch configured properly
  // The internal HTTP client (client.client) can be used for undocumented endpoints
  setClient(ctx.client);

  const allKeys = Object.keys(configs);
  const uniqueCmds = allKeys.filter(k => !k.includes("/"));
  log(`Plugin initialized: ${uniqueCmds.length} commands`, uniqueCmds);

  return {
    "command.execute.before": commandExecuteBefore,
    "tool.execute.before": toolExecuteBefore,
    "tool.execute.after": toolExecuteAfter,
    "experimental.chat.messages.transform": chatMessagesTransform,
    config: async (input: any) => {
      input.command ??= {};
      input.command.subtask = {
        description: "Run a command on the fly, supports all subtask2 features",
        template: "$ARGUMENTS",
        subtask: true,
      };
      log(`Registered /subtask command`);
    },
    event: async ({ event }: { event: { type: string; properties: any } }) => {
      if (event.type === "session.idle") {
        await handleSessionIdle(event.properties.sessionID);
      }
    },
  };
};
