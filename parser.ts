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
