// @ts-nocheck
import type { Plugin } from "@opencode-ai/plugin";

// Build manifest of command name → returnPrompt from command files
async function buildManifest(): Promise<Record<string, string>> {
  const manifest: Record<string, string> = {};

  const home = Bun.env.HOME ?? "";
  const globalDir = `${home}/.config/opencode/command`;
  const localDir = `${Bun.env.PWD ?? "."}/.opencode/command`;

  // Parse frontmatter from markdown file
  const parseFrontmatter = (content: string): Record<string, string> => {
    const match = content.match(/^---\n([\s\S]*?)\n---/);
    if (!match) return {};
    const frontmatter: Record<string, string> = {};
    for (const line of match[1].split("\n")) {
      const [key, ...rest] = line.split(":");
      if (key && rest.length) {
        frontmatter[key.trim()] = rest.join(":").trim();
      }
    }
    return frontmatter;
  };

  // Scan directory for command files
  const scanDir = async (dir: string) => {
    try {
      const glob = new Bun.Glob("*.md");
      for await (const file of glob.scan(dir)) {
        const name = file.replace(/\.md$/, "");
        const content = await Bun.file(`${dir}/${file}`).text();
        const fm = parseFrontmatter(content);
        if (fm.return) {
          manifest[name] = fm.return;
        }
      }
    } catch {
      // Directory doesn't exist, skip
    }
  };

  // Global first, then local (local overrides global)
  await scanDir(globalDir);
  await scanDir(localDir);

  return manifest;
}

// State
let returnPrompts: Record<string, string> = {};
const callState = new Map<string, string>();

const plugin: Plugin = async () => {
  // Build manifest on plugin load
  returnPrompts = await buildManifest();
  console.log("[sub-return] Loaded commands:", Object.keys(returnPrompts));

  return {
    "tool.execute.before": async (input, output) => {
      if (input.tool !== "task") return;
      const command = output.args?.command;
      if (command && returnPrompts[command]) {
        callState.set(input.callID, command);
      }
    },

    "tool.execute.after": async (input, output) => {
      if (input.tool !== "task") return;
      const command = callState.get(input.callID);
      if (!command) return;
      const returnPrompt = returnPrompts[command];
      if (returnPrompt) {
        output.output += `\n\n${returnPrompt}`;
      }
      callState.delete(input.callID);
    },
  };
};

export default plugin;
