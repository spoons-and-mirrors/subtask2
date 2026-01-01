/// <reference types="bun-types" />

import type {Subtask2Config} from "./types";

export const DEFAULT_PROMPT =
  "Review, challenge and validate the task output against the codebase then continue with the next logical step.";

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
