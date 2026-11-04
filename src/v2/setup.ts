import { Plugin } from "@opencode/plugin";
import { setPluginContext, setConfigs, setPluginConfig } from "../core/state";
import { loadConfig } from "../utils/config";
import { log, clearLog } from "../utils/logger";
import { buildManifest } from "../commands/manifest";
import { onSessionPrompt } from "../hooks/command-hooks";
import { onToolExecuteBeforeV2, onToolExecuteAfterV2 } from "../hooks/tool-hooks";
import { onSessionContext } from "../hooks/message-hooks";
import { handleSessionIdle } from "../hooks/session-idle-hook";
import { parseInlineSubtask } from "../parsing";
import { executeInlineSubtask } from "../features/inline-subtasks";
import { executeAutoWorkflow } from "../features/auto";

/**
 * OpenCode V2 Plugin definition
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
    log(`Plugin initialized (V2): ${uniqueCmds.length} commands`, uniqueCmds);

    // 1. Register /subtask command via ctx.command.transform
    await ctx.command.transform(editor => {
      editor.add({
        name: "subtask",
        description: "Run a command or subtask on the fly with subtask2 features",
        execute: async inv => {
          log(
            `/subtask executed via command invocation: sessionID=${inv.sessionID}, prompt="${inv.prompt.text}"`
          );
          const text = inv.prompt.text.trim();
          let parsed: ReturnType<typeof parseInlineSubtask> = null;

          if (text.startsWith("{")) {
            parsed = parseInlineSubtask(text);
          } else {
            parsed = parseInlineSubtask(`{} ${text}`);
          }

          if (parsed) {
            log(
              `/subtask: parsed prompt="${parsed.prompt.substring(0, 50)}...", overrides=${JSON.stringify(
                parsed.overrides
              )}`
            );
            await executeInlineSubtask(parsed, inv.sessionID);
          } else if (text) {
            log(`/subtask: fallback execution of text`);
            await executeAutoWorkflow(text, inv.sessionID);
          }
        },
      });
    });

    // 2. Register session prompt hook
    await ctx.session.hook("prompt", onSessionPrompt as any);

    // 3. Register session context hook
    await ctx.session.hook("context", onSessionContext as any);

    // 4. Register tool hooks with V2 functions directly
    await ctx.tool.hook("execute.before", async event => {
      await onToolExecuteBeforeV2({
        id: event.id,
        tool: event.tool,
        sessionID: event.sessionID,
        agent: event.agent,
        messageID: event.messageID,
        input: event.input,
      });
    });

    await ctx.tool.hook("execute.after", async event => {
      await onToolExecuteAfterV2({
        id: event.id,
        tool: event.tool,
        sessionID: event.sessionID,
        agent: event.agent,
        messageID: event.messageID,
        status: event.status,
        result: event.status === "completed" ? event.result : undefined,
      });
    });

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
      log("subtask2 V2 plugin cleaned up");
    };
  },
});
