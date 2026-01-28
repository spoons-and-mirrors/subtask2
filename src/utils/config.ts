/// <reference types="bun-types" />

import { dirname, join } from "path";
import type { Subtask2Config } from "../types";

// Re-export from prompts.ts for backwards compatibility
export { DEFAULT_RETURN_PROMPT as DEFAULT_PROMPT } from "./prompts";

const CONFIG_PATH = `${Bun.env.HOME ?? ""}/.config/opencode/subtask2.jsonc`;

/**
 * Cached README content
 */
let cachedReadmeContent: string | null = null;

/**
 * Reset the README cache (for testing)
 */
export function _resetReadmeCache(): void {
  cachedReadmeContent = null;
}

/**
 * Load README.md content from plugin root
 */
export async function loadReadmeContent(): Promise<string> {
  if (cachedReadmeContent !== null) {
    return cachedReadmeContent;
  }

  try {
    // Navigate from src/utils/config.ts to plugin root
    const pluginRoot = join(dirname(import.meta.path), "..", "..");
    const readmePath = join(pluginRoot, "README.md");
    const file = Bun.file(readmePath);

    if (await file.exists()) {
      cachedReadmeContent = await file.text();
      return cachedReadmeContent;
    }
  } catch {
    // Fall through to fallback
  }

  // Fallback if README can't be loaded
  cachedReadmeContent = `[README could not be loaded - see https://github.com/spoons-and-mirrors/subtask2 for documentation]`;
  return cachedReadmeContent;
}

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

export async function loadConfig(): Promise<Subtask2Config> {
  const defaultConfig: Subtask2Config = {
    replace_generic: true,
  };

  try {
    const file = Bun.file(CONFIG_PATH);
    if (await file.exists()) {
      const text = await file.text();
      const stripped = text
        .replace(/\/\/.*$/gm, "")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/,\s*([}\]])/g, "$1");
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
  "replace_generic": true,

  // Custom prompt to use when replace_generic: true | optional
  //\"generic_return\": \"Review, challenge and verify the task tool output above against the codebase. Then validate or revise it, before continuing with the next logical step.\"
}
`
  );
  return defaultConfig;
}
