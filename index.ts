import type {Plugin} from "@opencode-ai/plugin";
import type {
  CommandConfig,
  Subtask2Config,
  ParallelCommand,
  SubtaskPart,
} from "./types";
import {loadConfig, DEFAULT_PROMPT} from "./config";
import {
  parseFrontmatter,
  getTemplateBody,
  parseParallelConfig,
} from "./parser";
import {loadCommandFile, buildManifest} from "./commands";
import {log, clearLog} from "./logger";

// Session state
let configs: Record<string, CommandConfig> = {};
let pluginConfig: Subtask2Config = {replace_generic: true};
let client: any = null;
const callState = new Map<string, string>();
const returnState = new Map<string, string[]>();
const pendingReturns = new Map<string, string>();
const pendingNonSubtaskReturns = new Map<string, string[]>();
const pipedArgsQueue = new Map<string, string[]>();
const returnArgsState = pipedArgsQueue; // alias for backward compat
const sessionMainCommand = new Map<string, string>();
const executedReturns = new Set<string>();
let hasActiveSubtask = false;

const OPENCODE_GENERIC =
  "Summarize the task tool output above and continue with your task.";

async function flattenParallels(
  parallels: ParallelCommand[],
  mainArgs: string,
  sessionID: string,
  visited: Set<string> = new Set(),
  depth: number = 0,
  maxDepth: number = 5
): Promise<SubtaskPart[]> {
  if (depth > maxDepth) return [];

  const queue = pipedArgsQueue.get(sessionID) ?? [];
  log(`flattenParallels called:`, {
    depth,
    parallels: parallels.map(
      (p) => `${p.command}${p.arguments ? ` (args: ${p.arguments})` : ""}`
    ),
    mainArgs,
    queueRemaining: [...queue],
  });

  const parts: SubtaskPart[] = [];

  for (let i = 0; i < parallels.length; i++) {
    const parallelCmd = parallels[i];
    if (visited.has(parallelCmd.command)) continue;
    visited.add(parallelCmd.command);

    const cmdFile = await loadCommandFile(parallelCmd.command);
    if (!cmdFile) continue;

    const fm = parseFrontmatter(cmdFile.content);
    let template = getTemplateBody(cmdFile.content);

    // Priority: piped arg (from queue) > frontmatter args > main args
    const pipeArg = queue.shift();
    const args = pipeArg ?? parallelCmd.arguments ?? mainArgs;
    log(
      `Parallel ${parallelCmd.command}: using args="${args}" (pipeArg=${pipeArg}, fmArg=${parallelCmd.arguments}, mainArgs=${mainArgs})`
    );
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
          sessionID,
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

const plugin: Plugin = async (ctx) => {
  configs = await buildManifest();
  pluginConfig = await loadConfig();
  client = ctx.client;
  clearLog();
  log("Plugin initialized, configs:", Object.keys(configs));

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
      const inlineArgs = args;

      // Log the chained command's frontmatter
      if (configs[cmdName]) {
        log(`executeReturn: chained command "${cmdName}" config:`, {
          return: configs[cmdName].return,
          parallel: configs[cmdName].parallel,
          agent: configs[cmdName].agent,
          description: configs[cmdName].description,
        });
      } else {
        log(`executeReturn: command "${cmdName}" not found in configs`);
      }

      // Check if we have piped args for this return command
      const returnArgs = returnArgsState.get(sessionID);
      log(
        `executeReturn /command: cmdName=${cmdName}, inlineArgs="${inlineArgs}", returnArgsState=`,
        returnArgs
      );

      if (returnArgs?.length) {
        const pipeArg = returnArgs.shift();
        if (!returnArgs.length) returnArgsState.delete(sessionID);
        if (pipeArg) args = pipeArg;
        log(`executeReturn: using pipeArg="${pipeArg}" instead of inlineArgs`);
      }

      log(`executeReturn: final args="${args}"`);

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

  return {
    "command.execute.before": async (
      input: {command: string; sessionID: string; arguments: string},
      output: {parts: any[]}
    ) => {
      const cmd = input.command;
      const config = configs[cmd];
      sessionMainCommand.set(input.sessionID, cmd);
      log(
        `command.execute.before: cmd=${cmd}, sessionID=${input.sessionID}, hasConfig=${!!config}`
      );

      // Parse pipe-separated arguments: main || arg1 || arg2 || arg3 ...
      const argSegments = input.arguments.split("||").map((s) => s.trim());
      const mainArgs = argSegments[0] || "";

      // Store ALL piped args (after main) in a shared queue
      const allPipedArgs = argSegments.slice(1);

      log(`Pipe args parsing:`, {
        fullArgs: input.arguments,
        argSegments,
        mainArgs,
        allPipedArgs,
        configParallel: config?.parallel,
        configReturn: config?.return,
      });

      // Store piped args for consumption by parallels and return commands
      if (allPipedArgs.length) {
        pipedArgsQueue.set(input.sessionID, allPipedArgs);
        log(
          `Stored pipedArgsQueue for session ${input.sessionID}:`,
          allPipedArgs
        );
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
        input.sessionID
      );
      output.parts.push(...parallelParts);
    },

    "tool.execute.before": async (input, output) => {
      if (input.tool !== "task") return;
      hasActiveSubtask = true;
      const cmd = output.args?.command;
      const prompt = output.args?.prompt;
      let mainCmd = sessionMainCommand.get(input.sessionID);
      
      // If mainCmd is not set (command.execute.before didn't fire - no PR), 
      // set the first subtask command as the main command
      if (!mainCmd && cmd && configs[cmd]) {
        sessionMainCommand.set(input.sessionID, cmd);
        mainCmd = cmd;
        log(`tool.execute.before: no mainCmd set, setting to ${cmd} (fallback for non-PR)`);
        
        // Log the command's frontmatter for debugging
        log(`Command ${cmd} config:`, {
          return: configs[cmd].return,
          parallel: configs[cmd].parallel,
          agent: configs[cmd].agent,
          description: configs[cmd].description,
        });
        
        // Parse piped args from prompt if present (fallback for non-PR)
        // The prompt may contain "|| arg2 || arg3" if pipes were used
        if (prompt && prompt.includes("||")) {
          const pipeMatch = prompt.match(/\|\|(.+)/);
          if (pipeMatch) {
            const pipedPart = pipeMatch[1];
            const pipedArgs = pipedPart.split("||").map((s: string) => s.trim()).filter(Boolean);
            if (pipedArgs.length) {
              pipedArgsQueue.set(input.sessionID, pipedArgs);
              log(`Parsed piped args from prompt (fallback):`, pipedArgs);
              
              // Also fix the prompt to remove the piped args portion
              const cleanPrompt = prompt.replace(/\s*\|\|.+$/, "").trim();
              output.args.prompt = cleanPrompt;
              log(`Cleaned prompt: "${cleanPrompt.substring(0, 100)}..."`);
            }
          }
        }
        
        // Also set up return state since command.execute.before didn't run
        if (configs[cmd].return.length > 1) {
          returnState.set(input.sessionID, [...configs[cmd].return.slice(1)]);
        }
      }
      
      log(
        `tool.execute.before: cmd=${cmd}, mainCmd=${mainCmd}, sessionID=${input.sessionID}`
      );
      log(`tool.execute.before: prompt preview: "${(prompt || "").substring(0, 150)}..."`);
      log(`tool.execute.before: output.args:`, output.args);

      if (cmd && configs[cmd]) {
        // Log command frontmatter for all commands passing through
        if (cmd !== mainCmd) {
          log(`tool.execute.before: command "${cmd}" config:`, {
            return: configs[cmd].return,
            parallel: configs[cmd].parallel,
            agent: configs[cmd].agent,
            description: configs[cmd].description,
          });
        }
        
        if (cmd === mainCmd) {
          pendingNonSubtaskReturns.delete(input.sessionID);
        }

        callState.set(input.callID, cmd);

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

      // Find the LAST message with OPENCODE_GENERIC
      let lastGenericPart: any = null;
      let lastGenericMsgIndex = -1;

      for (let i = 0; i < output.messages.length; i++) {
        const msg = output.messages[i];
        for (const part of msg.parts) {
          if (part.type === "text" && part.text === OPENCODE_GENERIC) {
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
            lastGenericPart.text = "";
            log(`Set part.text to empty string, will execute command`);
            executeReturn(returnPrompt, sessionID).catch(console.error);
          } else {
            lastGenericPart.text = returnPrompt;
            log(
              `Set part.text to: "${lastGenericPart.text}", verification: ${
                lastGenericPart.text === returnPrompt
              }`
            );
          }
          pendingReturns.delete(sessionID);
          hasActiveSubtask = false;
          log(
            `After replacement, pendingReturns keys:`,
            Array.from(pendingReturns.keys())
          );
          return;
        }

        // No pending return found, use generic replacement if configured
        log(`No pendingReturn found, hasActiveSubtask=${hasActiveSubtask}`);
        if (hasActiveSubtask && pluginConfig.replace_generic) {
          log(
            `Using default replacement: ${
              pluginConfig.generic_return ?? DEFAULT_PROMPT
            }`
          );
          lastGenericPart.text = pluginConfig.generic_return ?? DEFAULT_PROMPT;
          hasActiveSubtask = false;
          return;
        }
      }
    },

    "experimental.text.complete": async (input) => {
      // Handle non-subtask command returns
      const pendingReturn = pendingNonSubtaskReturns.get(input.sessionID);
      if (pendingReturn?.length && client) {
        const next = pendingReturn.shift()!;
        if (!pendingReturn.length)
          pendingNonSubtaskReturns.delete(input.sessionID);
        executeReturn(next, input.sessionID).catch(console.error);
        return;
      }

      // Handle remaining returns
      const remaining = returnState.get(input.sessionID);
      if (!remaining?.length || !client) return;
      const next = remaining.shift()!;
      if (!remaining.length) returnState.delete(input.sessionID);
      executeReturn(next, input.sessionID).catch(console.error);
    },
  };
};

export default plugin;
