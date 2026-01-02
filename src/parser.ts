import YAML from "yaml";
import type {ParallelCommand} from "./types";

export function parseFrontmatter(content: string): Record<string, unknown> {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  try {
    return YAML.parse(match[1]) ?? {};
  } catch {
    return {};
  }
}

export function getTemplateBody(content: string): string {
  const match = content.match(/^---\n[\s\S]*?\n---\n([\s\S]*)$/);
  return match ? match[1].trim() : content.trim();
}

// Parse a parallel item - handles "/cmd args" syntax, plain "cmd", or {command, arguments} object
export function parseParallelItem(p: unknown): ParallelCommand | null {
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

export function parseParallelConfig(parallel: unknown): ParallelCommand[] {
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

// $TURN[n] - last n messages
// $TURN[:n] or $TURN[:n:m:o] - specific messages at indices (1-based from end)
const TURN_LAST_N_PATTERN = "\\$TURN\\[(\\d+)\\]";
const TURN_SPECIFIC_PATTERN = "\\$TURN\\[([:\\d]+)\\]";

export type TurnReference = 
  | { type: "lastN"; match: string; count: number }
  | { type: "specific"; match: string; indices: number[] };

/**
 * Extract all $TURN references from a string
 * - $TURN[n] -> last n messages
 * - $TURN[:n] or $TURN[:2:5:8] -> specific indices (1-based from end)
 */
export function extractTurnReferences(text: string): TurnReference[] {
  const refs: TurnReference[] = [];
  
  // Match $TURN[...] patterns
  const regex = /\$TURN\[([^\]]+)\]/g;
  let match: RegExpExecArray | null;
  
  while ((match = regex.exec(text)) !== null) {
    const inner = match[1];
    
    if (inner.startsWith(":")) {
      // Specific indices: $TURN[:2] or $TURN[:2:5:8]
      const indices = inner.split(":").filter(Boolean).map(n => parseInt(n, 10));
      if (indices.length > 0 && indices.every(n => !isNaN(n))) {
        refs.push({ type: "specific", match: match[0], indices });
      }
    } else {
      // Last N: $TURN[5]
      const count = parseInt(inner, 10);
      if (!isNaN(count)) {
        refs.push({ type: "lastN", match: match[0], count });
      }
    }
  }
  return refs;
}

/**
 * Check if text contains any $TURN references
 */
export function hasTurnReferences(text: string): boolean {
  return /\$TURN\[[^\]]+\]/.test(text);
}

/**
 * Replace all $TURN references in text with the provided content map
 */
export function replaceTurnReferences(
  text: string,
  replacements: Map<string, string>
): string {
  let result = text;
  for (const [pattern, replacement] of replacements) {
    result = result.replaceAll(pattern, replacement);
  }
  return result;
}

// Keep old names as aliases for backward compat during transition
export const extractSessionReferences = extractTurnReferences;
export const hasSessionReferences = hasTurnReferences;
export const replaceSessionReferences = replaceTurnReferences;
export type SessionReference = TurnReference;
