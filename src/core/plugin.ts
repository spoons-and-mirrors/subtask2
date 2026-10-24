import { Plugin } from "@opencode/plugin";
import { setPluginContext, setConfigs, setPluginConfig } from "./state";
import { loadConfig } from "../utils/config";
import { log, clearLog } from "../utils/logger";
import { buildManifest } from "../commands/manifest";
import { onSessionPrompt } from "../hooks/command-hooks";
import { onToolExecuteBefore, onToolExecuteAfter } from "../hooks/tool-hooks";
import { onSessionContext } from "../hooks/message-hooks";
import { handleSessionIdle } from "../hooks/session-idle-hook";
import { parseInlineSubtask } from "../parsing";
import { executeInlineSubtask } from "../features/inline-subtasks";
import { executeAutoWorkflow } from "../features/auto";

/**
 * Core: V2 Plugin entry point
 * Uses Plugin.define with standard V2 hooks and lifecycle
 */

export const plugin = Plugin.define({
  id: "subtask2",
  async setup(ctx) {
    clearLog();
    setPluginContext(ctx);

    const configs = await buildManifest();
    const pluginConfig = await loadConfig();

    setConfigs(configs);
    setPluginConfig(pluginConfig);

    const allKeys = Object.keys(configs);
    const uniqueCmds = allKeys.filter(k => !k.includes("/"));
    log(`Plugin initialized: ${uniqueCmds.length} commands`, uniqueCmds);

    // 1. Register /subtask command via ctx.command.transform
    await ctx.command.transform(editor => {
      editor.add({
        name: "subtask",
        description: "Run a command or subtask on the fly with subtask2 features",
        execute: async inv => {
          log(`/subtask executed via command invocation: sessionID=${inv.sessionID}, prompt="${inv.prompt.text}"`);
          const text = inv.prompt.text.trim();
          let parsed: ReturnType<typeof parseInlineSubtask> = null;

          if (text.startsWith("{")) {
            parsed = parseInlineSubtask(text);
          } else if (text.length > 0) {
            parsed = { prompt: text, overrides: {} };
          }

          if (!parsed) return;

          if (parsed.overrides.auto) {
            let model: { providerID: string; modelID: string } | undefined;
            if (parsed.overrides.model?.includes("/")) {
              const [providerID, ...rest] = parsed.overrides.model.split("/");
              model = { providerID, modelID: rest.join("/") };
            }
            await executeAutoWorkflow(parsed.prompt, inv.sessionID, parsed.overrides.agent, model);
            return;
          }

          await executeInlineSubtask(parsed, inv.sessionID);
        },
      });
    });

    // 2. Register session prompt hook (replaces command.execute.before)
    await ctx.session.hook("prompt", onSessionPrompt as any);

    // 3. Register session context hook (replaces experimental.chat.messages.transform)
    await ctx.session.hook("context", onSessionContext as any);


    // 4. Register tool hooks
    await ctx.tool.hook("execute.before", onToolExecuteBefore);
    await ctx.tool.hook("execute.after", onToolExecuteAfter);

    // 5. Register event subscriber for session.idle
    const controller = new AbortController();
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          if (event.type === "session.idle") {
            await handleSessionIdle(event.data.sessionID);
          }
        }
      } catch {
        // Aborted or disconnected
      }
    })();

    return () => {
      controller.abort();
      log("subtask2 plugin cleaned up");
    };
  },
});

export default plugin;

