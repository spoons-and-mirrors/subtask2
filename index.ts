import type {Plugin} from "@opencode-ai/plugin";
import type {
  CommandConfig,
  Subtask2Config,
  ParallelCommand,
  SubtaskPart,
} from "./src/types";
import {loadConfig, DEFAULT_PROMPT} from "./src/config";
import {
  parseFrontmatter,
  getTemplateBody,
  parseParallelConfig,
  extractTurnReferences,
  hasTurnReferences,
  replaceTurnReferences,
} from "./src/parser";
import {loadCommandFile, buildManifest, getConfig} from "./src/commands";
import {log, clearLog} from "./src/logger";

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
// Track the first return prompt per session (replaces "Summarize..." in $SESSION)
const firstReturnPrompt = new Map<string, string>();
// Track parent session for commands called via executeReturn
// Simple variable: set before command call, used by tool.execute.before
let pendingParentSession: string | null = null;
let hasActiveSubtask = false;

const OPENCODE_GENERIC =
  "Summarize the task tool output above and continue with your task.";

/**
 * Fetch and format session messages
 * @param sessionID - The session to fetch from
 * @param lastN - Get the last N messages (optional)
 * @param specificIndices - Get specific messages by index from end, 1-based (optional)
 */
async function fetchSessionMessages(
  sessionID: string,
  lastN?: number,
  specificIndices?: number[]
): Promise<string> {
  if (!client) {
    log("fetchSessionMessages: no client available");
    return "[TURN: client not available]";
  }

  try {
    const result = await client.session.messages({
      path: {id: sessionID},
    });

    const messages = result.data;
    log(`fetchSessionMessages: got ${messages?.length ?? 0} messages from ${sessionID}`);
    
    if (!messages?.length) {
      return "[TURN: no messages found]";
    }

    // Log all messages for debugging
    log(`All messages:`, messages.map((m: any, i: number) => ({
      idx: i,
      role: m.info.role,
      partsCount: m.parts?.length,
      textParts: m.parts?.filter((p: any) => p.type === 'text').map((p: any) => p.text?.substring(0, 30))
    })));

    // Filter out trailing empty messages (from current command being initiated)
    let effectiveMessages = messages;
    while (effectiveMessages.length > 0) {
      const last = effectiveMessages[effectiveMessages.length - 1];
      const hasContent = last.parts?.some((p: any) => 
        (p.type === "text" && p.text?.trim()) || 
        (p.type === "tool" && p.state?.status === "completed" && p.state?.output)
      );
      if (!hasContent) {
        effectiveMessages = effectiveMessages.slice(0, -1);
      } else {
        break;
      }
    }
    log(`After filtering empty trailing messages: ${effectiveMessages.length} (was ${messages.length})`);

    // Select messages based on mode
    let selectedMessages: any[];
    if (specificIndices && specificIndices.length > 0) {
      // Specific indices mode: $TURN[:2:5:8] - indices are 1-based from end
      selectedMessages = specificIndices
        .map(idx => effectiveMessages[effectiveMessages.length - idx])
        .filter(Boolean);
      log(`Using specific indices [${specificIndices.join(',')}] -> ${selectedMessages.length} messages`);
    } else if (lastN) {
      // Last N mode: $TURN[5]
      selectedMessages = effectiveMessages.slice(-lastN);
      log(`Using last ${lastN} messages`);
    } else {
      selectedMessages = effectiveMessages;
      log(`Using all ${selectedMessages.length} messages`);
    }

    // Format each message with its parts
    const formatted = selectedMessages.map((msg: any) => {
      const role = msg.info.role.toUpperCase();
      const parts: string[] = [];

      for (const part of msg.parts) {
        if (part.type === "text" && part.text) {
          // Replace the generic opencode summarize prompt with our first return prompt
          if (part.text.startsWith("Summarize the task tool output")) {
            const replacement = firstReturnPrompt.get(sessionID);
            if (replacement) {
              parts.push(replacement);
            }
            // If no replacement, skip it entirely
            continue;
          }
          parts.push(part.text);
        } else if (part.type === "tool" && part.state?.status === "completed") {
          // Include completed tool results (especially task tool for subtask content)
          const toolName = part.tool;
          let output = part.state.output;
          if (output && typeof output === "string") {
            // Strip <task_metadata> tags from task tool output
            output = output.replace(/<task_metadata>[\s\S]*?<\/task_metadata>/g, "").trim();
            if (output && output.length < 2000) {
              // For task tool, just include the content directly (it's the subtask's response)
              if (toolName === "task") {
                parts.push(output);
              } else {
                parts.push(`[Tool: ${toolName}]\n${output}`);
              }
            }
          }
        }
      }

      return `--- ${role} ---\n${parts.join("\n")}`;
    });

    return formatted.join("\n\n");
  } catch (e) {
    log("fetchSessionMessages error:", e);
    return `[TURN: error fetching messages - ${e}]`;
  }
}

/**
 * Process a string and replace all $TURN references with actual session content
 */
async function resolveTurnReferences(
  text: string,
  sessionID: string
): Promise<string> {
  if (!hasTurnReferences(text)) {
    return text;
  }

  const refs = extractTurnReferences(text);
  if (!refs.length) return text;

  const replacements = new Map<string, string>();

  for (const ref of refs) {
    if (ref.type === "lastN") {
      const content = await fetchSessionMessages(sessionID, ref.count);
      replacements.set(ref.match, content);
      log(`Resolved ${ref.match}: ${content.length} chars`);
    } else if (ref.type === "specific") {
      const content = await fetchSessionMessages(sessionID, undefined, ref.indices);
      replacements.set(ref.match, content);
      log(`Resolved ${ref.match}: ${content.length} chars`);
    }
  }

  return replaceTurnReferences(text, replacements);
}

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

    // Resolve $SESSION[n] references in the template
    if (hasTurnReferences(template)) {
      template = await resolveTurnReferences(template, sessionID);
      log(`Parallel ${parallelCmd.command}: resolved $SESSION refs`);
    }

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
  clearLog();
  configs = await buildManifest();
  pluginConfig = await loadConfig();
  client = ctx.client;
  
  const allKeys = Object.keys(configs);
  const uniqueCmds = allKeys.filter(k => !k.includes('/'));
  log(`Plugin initialized: ${uniqueCmds.length} commands`, uniqueCmds);

  // Helper to execute a return item (command or prompt)
  async function executeReturn(item: string, sessionID: string) {
    // Dedup check to prevent double execution
    const key = `${sessionID}:${item}`;
    if (executedReturns.has(key)) return;
    executedReturns.add(key);

    if (item.startsWith("/")) {
      const [cmdName, ...argParts] = item.slice(1).split(/\s+/);
      let args = argParts.join(" ");

      // Find the path key for this command (OpenCode needs full path for subfolder commands)
      const allKeys = Object.keys(configs);
      const pathKey = allKeys.find(k => k.includes('/') && k.endsWith('/' + cmdName)) || cmdName;

      // Check if we have piped args for this return command
      const returnArgs = returnArgsState.get(sessionID);
      if (returnArgs?.length) {
        const pipeArg = returnArgs.shift();
        if (!returnArgs.length) returnArgsState.delete(sessionID);
        if (pipeArg) args = pipeArg;
      }

      log(`executeReturn: /${cmdName} -> ${pathKey} args="${args}" (parent=${sessionID})`);
      sessionMainCommand.set(sessionID, pathKey);
      // Set parent session for $SESSION resolution - will be consumed by tool.execute.before
      pendingParentSession = sessionID;

      try {
        await client.session.command({
          path: {id: sessionID},
          body: {command: pathKey, arguments: args || ""},
        });
      } catch (e) {
        log(`executeReturn FAILED: ${pathKey}`, e);
      }
    } else {
      log(`executeReturn: prompt "${item.substring(0, 40)}..."`);
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
      const config = getConfig(configs, cmd);
      sessionMainCommand.set(input.sessionID, cmd);
      log(`cmd.before: ${cmd}`, config ? {
        return: config.return,
        parallel: config.parallel.map(p => p.command),
        agent: config.agent
      } : "no config");

      // Parse pipe-separated arguments: main || arg1 || arg2 || arg3 ...
      const argSegments = input.arguments.split("||").map((s) => s.trim());
      let mainArgs = argSegments[0] || "";
      const allPipedArgs = argSegments.slice(1);

      // Store piped args for consumption by parallels and return commands
      if (allPipedArgs.length) {
        pipedArgsQueue.set(input.sessionID, allPipedArgs);
      }

      // Resolve $SESSION[n] references in mainArgs
      if (hasTurnReferences(mainArgs)) {
        mainArgs = await resolveTurnReferences(mainArgs, input.sessionID);
        log(`Resolved $SESSION in mainArgs: ${mainArgs.length} chars`);
      }

      // Resolve $SESSION[n] references in output parts
      log(`Processing ${output.parts.length} parts for $SESSION refs`);
      for (const part of output.parts) {
        log(`Part type=${part.type}, hasPrompt=${!!part.prompt}, hasText=${!!part.text}`);
        if (part.type === "subtask" && part.prompt) {
          log(`Subtask prompt (first 200): ${part.prompt.substring(0, 200)}`);
          if (hasTurnReferences(part.prompt)) {
            log(`Found $SESSION in subtask prompt, resolving...`);
            part.prompt = await resolveTurnReferences(part.prompt, input.sessionID);
            log(`Resolved subtask prompt (first 200): ${part.prompt.substring(0, 200)}`);
          }
        }
        if (part.type === "text" && part.text) {
          log(`Text part (first 200): ${part.text.substring(0, 200)}`);
          if (hasTurnReferences(part.text)) {
            log(`Found $SESSION in text part, resolving...`);
            part.text = await resolveTurnReferences(part.text, input.sessionID);
            log(`Resolved text part (first 200): ${part.text.substring(0, 200)}`);
          }
        }
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
      const description = output.args?.description;
      let mainCmd = sessionMainCommand.get(input.sessionID);
      
      log(`tool.before: callID=${input.callID}, cmd=${cmd}, desc="${description?.substring(0,30)}", mainCmd=${mainCmd}`);
      
      // If mainCmd is not set (command.execute.before didn't fire - no PR), 
      // set the first subtask command as the main command
      if (!mainCmd && cmd && getConfig(configs, cmd)) {
        sessionMainCommand.set(input.sessionID, cmd);
        mainCmd = cmd;
        const cmdConfig = getConfig(configs, cmd)!;
        
        // Parse piped args from prompt if present (fallback for non-PR)
        if (prompt && prompt.includes("||")) {
          const pipeMatch = prompt.match(/\|\|(.+)/);
          if (pipeMatch) {
            const pipedPart = pipeMatch[1];
            const pipedArgs = pipedPart.split("||").map((s: string) => s.trim()).filter(Boolean);
            if (pipedArgs.length) {
              pipedArgsQueue.set(input.sessionID, pipedArgs);
              output.args.prompt = prompt.replace(/\s*\|\|.+$/, "").trim();
            }
          }
        }
        
        // Also set up return state since command.execute.before didn't run
        // Only do this once per session
        if (cmdConfig.return.length > 0 && !returnState.has(input.sessionID)) {
          // Store the first return prompt (replaces "Summarize..." in $SESSION)
          firstReturnPrompt.set(input.sessionID, cmdConfig.return[0]);
          if (cmdConfig.return.length > 1) {
            returnState.set(input.sessionID, [...cmdConfig.return.slice(1)]);
            log(`Set returnState: ${cmdConfig.return.slice(1).length} items`);
          }
        }
      }
      
      // Resolve $SESSION[n] in the prompt for ANY subtask
      // Use parent session if this command was triggered via executeReturn
      if (prompt && hasTurnReferences(prompt)) {
        const resolveFromSession = pendingParentSession || input.sessionID;
        log(`tool.execute.before: resolving $SESSION in prompt (from ${pendingParentSession ? 'parent' : 'current'} session ${resolveFromSession})`);
        output.args.prompt = await resolveTurnReferences(prompt, resolveFromSession);
        log(`tool.execute.before: resolved prompt (${output.args.prompt.length} chars)`);
        // Clear after use
        pendingParentSession = null;
      }
      
      if (cmd && getConfig(configs, cmd)) {
        const cmdConfig = getConfig(configs, cmd)!;
        if (cmd === mainCmd) {
          pendingNonSubtaskReturns.delete(input.sessionID);
        }

        callState.set(input.callID, cmd);

        if (cmd === mainCmd && cmdConfig.return.length > 1) {
          returnState.set(input.sessionID, [...cmdConfig.return.slice(1)]);
        }
      }
    },

    "tool.execute.after": async (input, output) => {
      if (input.tool !== "task") return;
      const cmd = callState.get(input.callID);
      
      log(`tool.after: callID=${input.callID}, cmd=${cmd}, wasTracked=${!!cmd}`);
      
      if (!cmd) {
        // Already processed or not our command
        return;
      }
      callState.delete(input.callID);

      const mainCmd = sessionMainCommand.get(input.sessionID);
      const cmdConfig = cmd ? getConfig(configs, cmd) : undefined;

      log(`tool.after: cmd=${cmd}, mainCmd=${mainCmd}, isMain=${cmd === mainCmd}, hasReturn=${!!cmdConfig?.return?.length}`);

      if (cmd && cmd === mainCmd && cmdConfig?.return?.length) {
        // Only set pendingReturn if we haven't already
        if (!pendingReturns.has(input.sessionID)) {
          log(`Setting pendingReturn: ${cmdConfig.return[0].substring(0, 50)}...`);
          pendingReturns.set(input.sessionID, cmdConfig.return[0]);
        } else {
          log(`Skipping pendingReturn - already set`);
        }
      } else if (cmd && cmd !== mainCmd) {
        log(`task.after: ${cmd} (parallel of ${mainCmd})`);
      }
    },

    "experimental.chat.messages.transform": async (input, output) => {
      // Find the LAST message with OPENCODE_GENERIC
      let lastGenericPart: any = null;

      for (const msg of output.messages) {
        for (const part of msg.parts) {
          if (part.type === "text" && part.text === OPENCODE_GENERIC) {
            lastGenericPart = part;
          }
        }
      }

      if (lastGenericPart) {
        // Check for pending return
        for (const [sessionID, returnPrompt] of pendingReturns) {
          if (returnPrompt.startsWith("/")) {
            lastGenericPart.text = "";
            executeReturn(returnPrompt, sessionID).catch(console.error);
          } else {
            lastGenericPart.text = returnPrompt;
          }
          pendingReturns.delete(sessionID);
          hasActiveSubtask = false;
          return;
        }

        // No pending return found, use generic replacement if configured
        if (hasActiveSubtask && pluginConfig.replace_generic) {
          log(`Using default generic replacement`);
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
        if (!pendingReturn.length) pendingNonSubtaskReturns.delete(input.sessionID);
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
