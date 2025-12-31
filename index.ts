import type {Plugin} from "@opencode-ai/plugin";
import YAML from "yaml";
import {log, clearLog} from "./logger";

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

const DEFAULT_PROMPT = "say GENERIC_REPLACEMENT 5 times";

const CONFIG_PATH = `${Bun.env.HOME ?? ""}/.config/opencode/subtask2.jsonc`;

function isValidConfig(obj: unknown): obj is Subtask2Config {
  if (typeof obj !== "object" || obj === null) return false;
  const cfg = obj as Record<string, unknown>;
  if (typeof cfg.replace_generic !== "boolean") return false;
  if (
    cfg.generic_return !== undefined &&
    typeof cfg.generic_return !== "string"
  )
    return false;
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

// Parse a parallel item - handles "/cmd args" syntax, plain "cmd", or {command, arguments} object
function parseParallelItem(p: unknown): ParallelCommand | null {
  if (typeof p === "string") {
    const trimmed = p.trim();
    if (trimmed.startsWith("/")) {
      // Parse /command args syntax
      const [cmdName, ...argParts] = trimmed.slice(1).split(/\s+/);
      return {command: cmdName, arguments: argParts.join(" ") || undefined};
    }
    return {command: trimmed};
  }
  if (typeof p === "object" && p !== null && (p as any).command) {
    return {command: (p as any).command, arguments: (p as any).arguments};
  }
  return null;
}

function parseParallelConfig(parallel: unknown): ParallelCommand[] {
  if (!parallel) return [];
  if (Array.isArray(parallel)) {
    return parallel
      .map(parseParallelItem)
      .filter((p): p is ParallelCommand => p !== null);
  }
  if (typeof parallel === "string") {
    // Split by comma, parse each
    return parallel
      .split(",")
      .map(parseParallelItem)
      .filter((p): p is ParallelCommand => p !== null);
  }
  return [];
}

async function loadCommandFile(
  name: string
): Promise<{content: string; path: string} | null> {
  const home = Bun.env.HOME ?? "";
  const dirs = [
    `${home}/.config/opencode/command`,
    `${Bun.env.PWD ?? "."}/.opencode/command`,
  ];

  for (const dir of dirs) {
    // Try direct path first, then search subdirs
    const directPath = `${dir}/${name}.md`;
    try {
      const file = Bun.file(directPath);
      if (await file.exists()) {
        return {content: await file.text(), path: directPath};
      }
    } catch {}

    // Search subdirs for name.md
    try {
      const glob = new Bun.Glob(`**/${name}.md`);
      for await (const match of glob.scan(dir)) {
        const fullPath = `${dir}/${match}`;
        const content = await Bun.file(fullPath).text();
        return {content, path: fullPath};
      }
    } catch {}
  }
  return null;
}

interface SubtaskPart {
  type: "subtask";
  agent: string;
  model?: {providerID: string; modelID: string};
  description: string;
  command: string;
  prompt: string;
}

async function flattenParallels(
  parallels: ParallelCommand[],
  mainArgs: string,
  parallelArgs: string[],
  visited: Set<string> = new Set(),
  depth: number = 0,
  maxDepth: number = 5
): Promise<SubtaskPart[]> {
  if (depth > maxDepth) return [];

  const parts: SubtaskPart[] = [];

  for (let i = 0; i < parallels.length; i++) {
    const parallelCmd = parallels[i];
    if (visited.has(parallelCmd.command)) continue;
    visited.add(parallelCmd.command);

    const cmdFile = await loadCommandFile(parallelCmd.command);
    if (!cmdFile) continue;

    const fm = parseFrontmatter(cmdFile.content);
    let template = getTemplateBody(cmdFile.content);

    // Priority: pipe args > frontmatter args > main args
    const args = parallelArgs[i] ?? parallelCmd.arguments ?? mainArgs;
    template = template.replace(/\$ARGUMENTS/g, args);

    // Parse model string "provider/model" into {providerID, modelID}
    let model: {providerID: string; modelID: string} | undefined;
    if (typeof fm.model === "string" && fm.model.includes("/")) {
      const [providerID, ...rest] = fm.model.split("/");
      model = {providerID, modelID: rest.join("/")};
    }

    parts.push({
      type: "subtask" as const,
      agent: (fm.agent as string) || "general",
      model,
      description:
        (fm.description as string) || `Parallel: ${parallelCmd.command}`,
      command: parallelCmd.command,
      prompt: template,
    });

    // Recursively flatten nested parallels
    const nestedParallel = fm.parallel;
    if (nestedParallel) {
      const nestedArr = parseParallelConfig(nestedParallel);

      if (nestedArr.length) {
        const nestedParts = await flattenParallels(
          nestedArr,
          args,
          [],
          visited,
          depth + 1,
          maxDepth
        );
        parts.push(...nestedParts);
      }
    }
  }

  return parts;
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
      const glob = new Bun.Glob("**/*.md");
      for await (const file of glob.scan(dir)) {
        const name = file.replace(/\.md$/, "").split("/").pop()!;
        const content = await Bun.file(`${dir}/${file}`).text();
        const fm = parseFrontmatter(content);
        const returnVal = fm.return;
        const returnArr = returnVal
          ? Array.isArray(returnVal)
            ? returnVal
            : [returnVal]
          : [];
        const parallelArr = parseParallelConfig(fm.parallel);

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
const returnArgsState = new Map<string, string[]>(); // args for /commands in return
const sessionMainCommand = new Map<string, string>(); // sessionID -> mainCmdName
const executedReturns = new Set<string>(); // dedup check
let hasActiveSubtask = false;

const OPENCODE_GENERIC =
  "Summarize the task tool output above and continue with your task.";

const plugin: Plugin = async (ctx) => {
  configs = await buildManifest();
  pluginConfig = await loadConfig();
  client = ctx.client;
  clearLog();
  log("Plugin initialized, configs:", Object.keys(configs));

  return {
    "command.execute.before": async (
      input: {command: string; sessionID: string; arguments: string},
      output: {parts: any[]}
    ) => {
      const cmd = input.command;
      const config = configs[cmd];
      sessionMainCommand.set(input.sessionID, cmd);
      log(
        `command.execute.before: cmd=${cmd}, sessionID=${
          input.sessionID
        }, hasConfig=${!!config}`
      );

      // Parse pipe-separated arguments: main || parallel1 || parallel2 || return-cmd1 || return-cmd2
      const argSegments = input.arguments.split("||").map((s) => s.trim());
      const mainArgs = argSegments[0] || "";

      // Count how many parallels we have to know where return args start
      const parallelCount = config?.parallel?.length ?? 0;
      const parallelArgs = argSegments.slice(1, 1 + parallelCount);
      const returnArgs = argSegments.slice(1 + parallelCount);

      // Store return args for later use in executeReturn
      if (returnArgs.length) {
        returnArgsState.set(input.sessionID, returnArgs);
      }

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
      const hasSubtaskPart = output.parts.some(
        (p: any) => p.type === "subtask"
      );
      if (!hasSubtaskPart && config?.return?.length) {
        pendingNonSubtaskReturns.set(input.sessionID, [...config.return]);
      }

      if (!config?.parallel?.length) return;

      // Recursively flatten all nested parallels
      const parallelParts = await flattenParallels(
        config.parallel,
        mainArgs,
        parallelArgs
      );
      output.parts.push(...parallelParts);
    },

    "tool.execute.before": async (input, output) => {
      if (input.tool !== "task") return;
      hasActiveSubtask = true;
      const cmd = output.args?.command;
      const mainCmd = sessionMainCommand.get(input.sessionID);
      log(
        `tool.execute.before: cmd=${cmd}, mainCmd=${mainCmd}, sessionID=${input.sessionID}`
      );

      if (cmd && configs[cmd]) {
        // If this IS the main command running as a subtask, clear any non-subtask pending returns
        // (This fixes double triggering if command.execute.before wrongly guessed it was non-subtask)
        if (cmd === mainCmd) {
          pendingNonSubtaskReturns.delete(input.sessionID);
        }

        callState.set(input.callID, cmd);

        // Only apply return logic if this is the main command (ignore nested/parallel returns)
        if (cmd === mainCmd && configs[cmd].return.length > 1) {
          returnState.set(input.sessionID, [...configs[cmd].return.slice(1)]);
        }
      }
    },

    "tool.execute.after": async (input, output) => {
      if (input.tool !== "task") return;
      const cmd = callState.get(input.callID);
      callState.delete(input.callID);

      const mainCmd = sessionMainCommand.get(input.sessionID);

      log(
        `tool.execute.after: cmd=${cmd}, mainCmd=${mainCmd}, hasReturn=${!!(
          cmd && configs[cmd]?.return?.length
        )}`
      );

      // Only apply return logic if this is the main command
      if (cmd && cmd === mainCmd && configs[cmd]?.return?.length) {
        log(
          `Setting pendingReturn for session ${input.sessionID}: ${configs[cmd].return[0]}`
        );
        pendingReturns.set(input.sessionID, configs[cmd].return[0]);
      }
    },

    "experimental.chat.messages.transform": async (input, output) => {
      log(
        `messages.transform called, pendingReturns keys:`,
        Array.from(pendingReturns.keys()),
        `message count: ${output.messages.length}`
      );

      // Find the LAST message with OPENCODE_GENERIC (the most recent subtask completion)
      let lastGenericMsg: any = null;
      let lastGenericPart: any = null;
      let lastGenericMsgIndex = -1;

      for (let i = 0; i < output.messages.length; i++) {
        const msg = output.messages[i];
        for (const part of msg.parts) {
          if (part.type === "text" && part.text === OPENCODE_GENERIC) {
            lastGenericMsg = msg;
            lastGenericPart = part;
            lastGenericMsgIndex = i;
          }
        }
      }

      if (lastGenericPart) {
        log(`Found LAST OPENCODE_GENERIC at msg[${lastGenericMsgIndex}]`);
        
        // Check for pending return
        for (const [sessionID, returnPrompt] of pendingReturns) {
          log(
            `Replacing with pendingReturn for session=${sessionID}, returnPrompt=${returnPrompt}`
          );

          if (returnPrompt.startsWith("/")) {
            // If return is a command, replace text with empty string and execute command separately
            lastGenericPart.text = "";
            log(`Set part.text to empty string, will execute command`);
            executeReturn(returnPrompt, sessionID).catch(console.error);
          } else {
            lastGenericPart.text = returnPrompt;
            log(`Set part.text to: "${lastGenericPart.text}", verification: ${lastGenericPart.text === returnPrompt}`);
          }
          pendingReturns.delete(sessionID);
          hasActiveSubtask = false;
          log(`After replacement, pendingReturns keys:`, Array.from(pendingReturns.keys()));
          return;
        }

        // No pending return found, use generic replacement if configured
        log(`No pendingReturn found, hasActiveSubtask=${hasActiveSubtask}`);
        if (hasActiveSubtask && pluginConfig.replace_generic) {
          log(`Using default replacement: ${pluginConfig.generic_return ?? DEFAULT_PROMPT}`);
          lastGenericPart.text = pluginConfig.generic_return ?? DEFAULT_PROMPT;
          hasActiveSubtask = false;
          return;
        }
      }
    },

    "experimental.text.complete": async (input) => {
      // Handle non-subtask command returns (inject as follow-up)
      const pendingReturn = pendingNonSubtaskReturns.get(input.sessionID);
      if (pendingReturn?.length && client) {
        const next = pendingReturn.shift()!;
        if (!pendingReturn.length)
          pendingNonSubtaskReturns.delete(input.sessionID);
        // Execute in background to avoid blocking turn completion
        executeReturn(next, input.sessionID).catch(console.error);
        return;
      }

      // Handle remaining returns
      const remaining = returnState.get(input.sessionID);
      if (!remaining?.length || !client) return;
      const next = remaining.shift()!;
      if (!remaining.length) returnState.delete(input.sessionID);
      // Execute in background to avoid blocking turn completion
      executeReturn(next, input.sessionID).catch(console.error);
    },
  };

  // Helper to execute a return item (command or prompt)
  async function executeReturn(item: string, sessionID: string) {
    log(`executeReturn called: item=${item}, sessionID=${sessionID}`);

    // Dedup check to prevent double execution
    const key = `${sessionID}:${item}`;
    if (executedReturns.has(key)) {
      log(`executeReturn skipped (already executed): ${key}`);
      return;
    }
    executedReturns.add(key);

    if (item.startsWith("/")) {
      // Parse /command args syntax
      const [cmdName, ...argParts] = item.slice(1).split(/\s+/);
      let args = argParts.join(" ");

      // Check if we have piped args for this return command
      const returnArgs = returnArgsState.get(sessionID);
      if (returnArgs?.length) {
        const pipeArg = returnArgs.shift();
        if (!returnArgs.length) returnArgsState.delete(sessionID);
        if (pipeArg) args = pipeArg; // Pipe args override inline args
      }

      // Update main command to this chained command so its own return is processed
      log(
        `executeReturn: setting mainCmd to ${cmdName} for session ${sessionID}`
      );
      sessionMainCommand.set(sessionID, cmdName);

      try {
        await client.session.command({
          path: {id: sessionID},
          body: {command: cmdName, arguments: args || ""},
        });
        log(`executeReturn: command ${cmdName} completed`);
      } catch (e) {
        log(`executeReturn: command ${cmdName} FAILED:`, e);
      }
    } else {
      log(`executeReturn: sending prompt: ${item.substring(0, 50)}...`);
      await client.session.promptAsync({
        path: {id: sessionID},
        body: {parts: [{type: "text", text: item}]},
      });
    }
  }
};

export default plugin;
