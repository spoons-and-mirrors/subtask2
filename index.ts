import type {Plugin} from "@opencode-ai/plugin";
import YAML from "yaml";

interface ParallelCommand {
  command: string;
  arguments?: string;
}

interface CommandConfig {
  return: string[];
  parallel: ParallelCommand[];
  agent?: string;
  description?: string;
  template?: string;
}

interface Subtask2Config {
  replace_generic: boolean;
  generic_return?: string;
}

const DEFAULT_PROMPT =
  "Challenge and validate the task tool output above. Verify assumptions, identify gaps or errors, then continue with the next logical step.";

const CONFIG_PATH = `${Bun.env.HOME ?? ""}/.config/opencode/subtask2.jsonc`;

function isValidConfig(obj: unknown): obj is Subtask2Config {
  if (typeof obj !== "object" || obj === null) return false;
  const cfg = obj as Record<string, unknown>;
  if (typeof cfg.replace_generic !== "boolean") return false;
  if (cfg.generic_return !== undefined && typeof cfg.generic_return !== "string") return false;
  return true;
}

async function loadConfig(): Promise<Subtask2Config> {
  const defaultConfig: Subtask2Config = {
    replace_generic: true,
  };

  try {
    const file = Bun.file(CONFIG_PATH);
    if (await file.exists()) {
      const text = await file.text();
      const stripped = text
        .replace(/\/\/.*$/gm, "")
        .replace(/\/\*[\s\S]*?\*\//g, "");
      const parsed = JSON.parse(stripped);
      if (isValidConfig(parsed)) {
        return parsed;
      }
    }
  } catch {}

  await Bun.write(
    CONFIG_PATH,
    `{
  // Replace OpenCode's generic "Summarize..." prompt when no return is specified
  "replace_generic": true

  // Custom prompt to use (uses subtask2 substitution prompt by default)
  // "generic_return": "Challenge and validate the task tool output above. Verify assumptions, identify gaps or errors, then continue with the next logical step."
}
`
  );
  return defaultConfig;
}

function parseFrontmatter(content: string): Record<string, unknown> {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  try {
    return YAML.parse(match[1]) ?? {};
  } catch {
    return {};
  }
}

function getTemplateBody(content: string): string {
  const match = content.match(/^---\n[\s\S]*?\n---\n([\s\S]*)$/);
  return match ? match[1].trim() : content.trim();
}

async function loadCommandFile(name: string): Promise<{content: string; path: string} | null> {
  const home = Bun.env.HOME ?? "";
  const dirs = [
    `${home}/.config/opencode/command`,
    `${Bun.env.PWD ?? "."}/.opencode/command`,
  ];

  for (const dir of dirs) {
    const path = `${dir}/${name}.md`;
    try {
      const file = Bun.file(path);
      if (await file.exists()) {
        return {content: await file.text(), path};
      }
    } catch {}
  }
  return null;
}

async function buildManifest(): Promise<Record<string, CommandConfig>> {
  const manifest: Record<string, CommandConfig> = {};
  const home = Bun.env.HOME ?? "";
  const dirs = [
    `${home}/.config/opencode/command`,
    `${Bun.env.PWD ?? "."}/.opencode/command`,
  ];

  for (const dir of dirs) {
    try {
      const glob = new Bun.Glob("*.md");
      for await (const file of glob.scan(dir)) {
        const name = file.replace(/\.md$/, "");
        const content = await Bun.file(`${dir}/${file}`).text();
        const fm = parseFrontmatter(content);
        const returnVal = fm.return;
        const returnArr = returnVal ? (Array.isArray(returnVal) ? returnVal : [returnVal]) : [];
        const parallel = fm.parallel;
        let parallelArr: ParallelCommand[] = [];
        if (parallel) {
          if (Array.isArray(parallel)) {
            parallelArr = parallel.map((p) => {
              if (typeof p === "string") {
                return {command: p.trim()};
              }
              if (typeof p === "object" && p.command) {
                return {command: p.command, arguments: p.arguments};
              }
              return null;
            }).filter((p): p is ParallelCommand => p !== null);
          } else if (typeof parallel === "string") {
            parallelArr = parallel.split(",").map((s) => ({command: s.trim()})).filter((p) => p.command);
          }
        }

        manifest[name] = {
          return: returnArr,
          parallel: parallelArr,
          agent: fm.agent as string | undefined,
          description: fm.description as string | undefined,
          template: getTemplateBody(content),
        };
      }
    } catch {}
  }
  return manifest;
}

let configs: Record<string, CommandConfig> = {};
let pluginConfig: Subtask2Config = {replace_generic: true};
let client: any = null;
const callState = new Map<string, string>();
const returnState = new Map<string, string[]>();
const pendingReturns = new Map<string, string>();
const pendingNonSubtaskReturns = new Map<string, string[]>();
let hasActiveSubtask = false;

const OPENCODE_GENERIC =
  "Summarize the task tool output above and continue with your task.";

const plugin: Plugin = async (ctx) => {
  configs = await buildManifest();
  pluginConfig = await loadConfig();
  client = ctx.client;

  return {
    "command.execute.before": async (input: {command: string; sessionID: string; arguments: string}, output: {parts: any[]}) => {
      const cmd = input.command;
      const config = configs[cmd];
      
      // Parse pipe-separated arguments: main args || parallel1 args || parallel2 args
      const argSegments = input.arguments.split("||").map((s) => s.trim());
      const mainArgs = argSegments[0] || "";
      const parallelArgs = argSegments.slice(1);
      
      // Fix main command's parts to use only mainArgs (not the full pipe string)
      if (argSegments.length > 1) {
        for (const part of output.parts) {
          if (part.type === "subtask" && part.prompt) {
            part.prompt = part.prompt.replaceAll(input.arguments, mainArgs);
          }
          if (part.type === "text" && part.text) {
            part.text = part.text.replaceAll(input.arguments, mainArgs);
          }
        }
      }
      
      // Track non-subtask commands with return for later injection
      const hasSubtaskPart = output.parts.some((p: any) => p.type === "subtask");
      if (!hasSubtaskPart && config?.return?.length) {
        pendingNonSubtaskReturns.set(input.sessionID, [...config.return]);
      }
      
      if (!config?.parallel?.length) return;

      for (let i = 0; i < config.parallel.length; i++) {
        const parallelCmd = config.parallel[i];
        const cmdFile = await loadCommandFile(parallelCmd.command);
        if (!cmdFile) continue;

        const fm = parseFrontmatter(cmdFile.content);
        let template = getTemplateBody(cmdFile.content);
        
        // Priority: pipe args > frontmatter args > main args
        const args = parallelArgs[i] ?? parallelCmd.arguments ?? mainArgs;
        template = template.replace(/\$ARGUMENTS/g, args);

        // Parse model string "provider/model" into {providerID, modelID}
        let model: {providerID: string, modelID: string} | undefined;
        if (typeof fm.model === "string" && fm.model.includes("/")) {
          const [providerID, ...rest] = fm.model.split("/");
          model = { providerID, modelID: rest.join("/") };
        }

        output.parts.push({
          type: "subtask" as const,
          agent: (fm.agent as string) || "general",
          model,
          description: (fm.description as string) || `Parallel: ${parallelCmd.command}`,
          command: parallelCmd.command,
          prompt: template,
        });
      }
    },

    "tool.execute.before": async (input, output) => {
      if (input.tool !== "task") return;
      hasActiveSubtask = true;
      const cmd = output.args?.command;
      if (cmd && configs[cmd]) {
        callState.set(input.callID, cmd);
        if (configs[cmd].return.length > 1) {
          returnState.set(input.sessionID, [...configs[cmd].return.slice(1)]);
        }
      }
    },

    "tool.execute.after": async (input, output) => {
      if (input.tool !== "task") return;
      const cmd = callState.get(input.callID);
      callState.delete(input.callID);
      if (cmd && configs[cmd]?.return?.length) {
        pendingReturns.set(input.sessionID, configs[cmd].return[0]);
      }
    },

    "experimental.chat.messages.transform": async (_input, output) => {
      for (const msg of output.messages) {
        for (const part of msg.parts) {
          if (part.type === "text" && part.text === OPENCODE_GENERIC) {
            for (const [sessionID, returnPrompt] of pendingReturns) {
              part.text = returnPrompt;
              pendingReturns.delete(sessionID);
              hasActiveSubtask = false;
              return;
            }

            if (hasActiveSubtask && pluginConfig.replace_generic) {
              part.text = pluginConfig.generic_return ?? DEFAULT_PROMPT;
              hasActiveSubtask = false;
              return;
            }
          }
        }
      }
    },

    "experimental.text.complete": async (input) => {
      // Handle non-subtask command returns (inject as follow-up message)
      const pendingReturn = pendingNonSubtaskReturns.get(input.sessionID);
      if (pendingReturn?.length && client) {
        const next = pendingReturn.shift()!;
        if (!pendingReturn.length) pendingNonSubtaskReturns.delete(input.sessionID);
        await client.session.promptAsync({
          path: {id: input.sessionID},
          body: {parts: [{type: "text", text: next}]},
        });
        return;
      }

      // Handle remaining returns (formerly chain)
      const remaining = returnState.get(input.sessionID);
      if (!remaining?.length || !client) return;
      const next = remaining.shift()!;
      if (!remaining.length) returnState.delete(input.sessionID);
      await client.session.promptAsync({
        path: {id: input.sessionID},
        body: {parts: [{type: "text", text: next}]},
      });
    },
  };
};

export default plugin;
