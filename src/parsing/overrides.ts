// Parse inline override syntax: {model:x && agent:y && return:z && as:name}

import { resolveModelAlias } from "../config";

export interface ParsedOverrides {
  model?: string; // After alias resolution: "openai/gpt-4o"
  agent?: string; // "build", "explore", "general"
  return?: string; // Single return prompt
  as?: string; // Result capture name
  loop?: number; // Loop count (deferred feature)
  until?: string; // Loop condition (deferred feature)
  remainder: string; // Prompt text after overrides
}

// Pattern to match override block at start of text
const OVERRIDE_PATTERN = /^\{([^}]+)\}\s*/;

// Parse "model:x && agent:y" style override string
const parseOverrideString = (str: string): Record<string, string> => {
  const result: Record<string, string> = {};
  const parts = str.split(/\s*&&\s*/);

  for (const part of parts) {
    const colonIdx = part.indexOf(":");
    if (colonIdx === -1) continue;

    const key = part.slice(0, colonIdx).trim();
    const value = part.slice(colonIdx + 1).trim();

    if (key && value) {
      result[key] = value;
    }
  }

  return result;
};

// Check if text has override syntax at start
export const hasOverrides = (text: string): boolean => {
  return OVERRIDE_PATTERN.test(text.trim());
};

// Parse overrides from text, resolve model aliases
export const parseOverrides = (text: string): ParsedOverrides => {
  const trimmed = text.trim();
  const match = trimmed.match(OVERRIDE_PATTERN);

  if (!match) {
    return { remainder: trimmed };
  }

  const overrideStr = match[1];
  const parsed = parseOverrideString(overrideStr);
  const remainder = trimmed.slice(match[0].length);

  const result: ParsedOverrides = { remainder };

  // Model - resolve alias before storing
  if (parsed.model) {
    result.model = resolveModelAlias(parsed.model);
  }

  // Agent
  if (parsed.agent) {
    result.agent = parsed.agent;
  }

  // Return (single prompt)
  if (parsed.return) {
    result.return = parsed.return;
  }

  // Result capture name
  if (parsed.as) {
    result.as = parsed.as;
  }

  // Loop count (deferred - parse for future use)
  if (parsed.loop) {
    const num = parseInt(parsed.loop, 10);
    if (!isNaN(num)) {
      result.loop = num;
    }
  }

  // Until condition (deferred)
  if (parsed.until) {
    result.until = parsed.until;
  }

  return result;
};

// Split model string into provider and model ID
export const splitModel = (
  model: string
): { providerID: string; modelID: string } | null => {
  const idx = model.indexOf("/");
  if (idx === -1) return null;

  return {
    providerID: model.slice(0, idx),
    modelID: model.slice(idx + 1),
  };
};

// Parse model and split in one call (convenience)
export const parseModelOverride = (
  model: string
): { providerID: string; modelID: string } | null => {
  const resolved = resolveModelAlias(model);
  return splitModel(resolved);
};
