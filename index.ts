import type {Plugin} from "@opencode-ai/plugin";

interface CommandConfig {
  return?: string;
  chain: string[];
}

function parseFrontmatter(content: string): Record<string, string | string[]> {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  const fm: Record<string, string | string[]> = {};
  const lines = match[1].split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const keyMatch = line.match(/^(\w+):\s*(.*)/);
    if (!keyMatch) continue;
    const [, key, value] = keyMatch;
    if (!value.trim()) {
      const items: string[] = [];
      while (i + 1 < lines.length && lines[i + 1].match(/^\s+-\s+/)) {
        i++;
        items.push(lines[i].replace(/^\s+-\s+/, "").trim());
      }
      if (items.length) {
        fm[key] = items;
        continue;
      }
    }
    fm[key] = value.trim();
  }
  return fm;
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
        const chain = fm.chain;
        const chainArr = chain ? (Array.isArray(chain) ? chain : [chain]) : [];
        if (fm.return || chainArr.length) {
          manifest[name] = {
            return: fm.return as string | undefined,
            chain: chainArr,
          };
        }
      }
    } catch {}
  }
  return manifest;
}

let configs: Record<string, CommandConfig> = {};
let client: any = null;
const callState = new Map<string, string>();
const chainState = new Map<string, string[]>();
const pendingReturns = new Map<string, string>();

const OPENCODE_GENERIC =
  "Summarize the task tool output above and continue with your task.";

const plugin: Plugin = async (ctx) => {
  configs = await buildManifest();
  client = ctx.client;

  return {
    "tool.execute.before": async (input, output) => {
      if (input.tool !== "task") return;
      const cmd = output.args?.command;
      if (cmd && configs[cmd]) {
        callState.set(input.callID, cmd);
        if (configs[cmd].chain.length) {
          chainState.set(input.sessionID, [...configs[cmd].chain]);
        }
      }
    },

    "tool.execute.after": async (input, output) => {
      if (input.tool !== "task") return;
      const cmd = callState.get(input.callID);
      callState.delete(input.callID);
      if (cmd && configs[cmd]?.return) {
        pendingReturns.set(input.sessionID, configs[cmd].return);
      }
    },

    "experimental.chat.messages.transform": async (_input, output) => {
      for (const msg of output.messages) {
        for (const part of msg.parts) {
          if (part.type === "text" && part.text === OPENCODE_GENERIC) {
            for (const [sessionID, returnPrompt] of pendingReturns) {
              part.text = returnPrompt;
              pendingReturns.delete(sessionID);
              return;
            }
          }
        }
      }
    },

    "experimental.text.complete": async (input) => {
      const chain = chainState.get(input.sessionID);
      if (!chain?.length || !client) return;
      const next = chain.shift()!;
      if (!chain.length) chainState.delete(input.sessionID);
      await client.session.promptAsync({
        path: {id: input.sessionID},
        body: {parts: [{type: "text", text: next}]},
      });
    },
  };
};

export default plugin;
