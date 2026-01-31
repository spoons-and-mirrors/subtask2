// CLI interface for /subtask command
import { log } from "../state";
import { getAliases, setAlias, deleteAlias, formatAliases } from "./aliases";

// Client reference (set by hooks)
let clientRef: any = null;

export const setClient = (client: any) => {
  clientRef = client;
};

// Sentinel error to stop command execution
export const COMMAND_HANDLED = "__SUBTASK_COMMAND_HANDLED__";

/**
 * Parse CLI flags from arguments
 * Returns: { flags, remaining }
 */
function parseFlags(args: string): {
  flags: Record<string, string | boolean>;
  remaining: string;
} {
  const flags: Record<string, string | boolean> = {};
  let remaining = args.trim();

  // Parse -a (alias management)
  if (remaining.startsWith("-a")) {
    flags.alias = true;
    remaining = remaining.slice(2).trim();
  }

  // Parse -d (delete)
  if (remaining.includes("-d")) {
    flags.delete = true;
    remaining = remaining.replace("-d", "").trim();
  }

  return { flags, remaining };
}

/**
 * Show help message
 */
async function showHelp(sessionID: string): Promise<void> {
  const aliases = formatAliases();

  const help = `## /subtask - Inline Subtask Command

### Usage
\`\`\`
/subtask {overrides} prompt text
\`\`\`

### Available Overrides
- \`model:provider/model-id\` - Use specific model
- \`model:alias\` - Use model alias
- \`agent:name\` - Use specific agent (build, explore, general)
- \`as:name\` - Capture result for \$RESULT[name]
- \`return:prompt\` - Chain a return prompt

### Examples
\`\`\`
/subtask Analyze this code
/subtask {model:opus} Review the implementation
/subtask {agent:explore && as:research} Find auth patterns
/subtask {model:gpt-4o && return:Summarize findings} Research topic
\`\`\`

### Model Aliases
Manage aliases with \`/subtask -a\`:
\`\`\`
/subtask -a                              # List aliases
/subtask -a opus github-copilot/claude-opus-4.5   # Create alias
/subtask -a opus -d                      # Delete alias
\`\`\`

### Current Aliases
${aliases}
`;

  await clientRef.session.prompt({
    path: { id: sessionID },
    body: {
      parts: [{ type: "text", text: help, ignored: true }],
      noReply: true,
    },
  });
}

/**
 * Handle alias management
 */
async function handleAlias(
  sessionID: string,
  args: string,
  deleteFlag: boolean
): Promise<void> {
  const parts = args.trim().split(/\s+/);

  // /subtask -a → list aliases
  if (parts.length === 0 || (parts.length === 1 && !parts[0])) {
    const aliases = formatAliases();
    await clientRef.session.prompt({
      path: { id: sessionID },
      body: {
        parts: [
          {
            type: "text",
            text: `## Model Aliases\n\n${aliases}`,
            ignored: true,
          },
        ],
        noReply: true,
      },
    });
    return;
  }

  const aliasName = parts[0];

  // /subtask -a name -d → delete
  if (deleteFlag) {
    const deleted = deleteAlias(aliasName);
    const msg = deleted
      ? `Deleted alias: ${aliasName}`
      : `Alias not found: ${aliasName}`;
    await clientRef.session.prompt({
      path: { id: sessionID },
      body: {
        parts: [{ type: "text", text: msg, ignored: true }],
        noReply: true,
      },
    });
    return;
  }

  // /subtask -a name model → create
  if (parts.length >= 2) {
    const model = parts.slice(1).join(" ");
    await setAlias(aliasName, model);
    await clientRef.session.prompt({
      path: { id: sessionID },
      body: {
        parts: [
          {
            type: "text",
            text: `Created alias: ${aliasName} → ${model}`,
            ignored: true,
          },
        ],
        noReply: true,
      },
    });
    return;
  }

  // /subtask -a name → show specific alias
  const aliases = getAliases();
  const model = aliases[aliasName];
  const msg = model
    ? `${aliasName} → ${model}`
    : `Alias not found: ${aliasName}`;
  await clientRef.session.prompt({
    path: { id: sessionID },
    body: {
      parts: [{ type: "text", text: msg, ignored: true }],
      noReply: true,
    },
  });
}

/**
 * Handle CLI interface for /subtask command
 * Returns true if handled (should stop execution), false to continue
 */
export async function handleCLI(
  sessionID: string,
  args: string
): Promise<boolean> {
  if (!clientRef) {
    log("No client reference for CLI");
    return false;
  }

  const trimmed = args.trim();

  // No args → show help
  if (!trimmed) {
    await showHelp(sessionID);
    return true;
  }

  // Check for flags
  const { flags, remaining } = parseFlags(trimmed);

  // -a flag → alias management
  if (flags.alias) {
    await handleAlias(sessionID, remaining, !!flags.delete);
    return true;
  }

  // Not a CLI command, continue with normal processing
  return false;
}
