import YAML from "yaml";

/**
 * Parsing: YAML frontmatter extraction
 */

export function parseFrontmatter(content: string): Record<string, unknown> {
  const match = content.replace(/^\uFEFF/, '').match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};
  try {
    return YAML.parse(match[1]) ?? {};
  } catch {
    return {};
  }
}

export function getTemplateBody(content: string): string {
  const match = content.replace(/^\uFEFF/, '').match(/^---\r?\n[\s\S]*?\r?\n---\r?\n([\s\S]*)$/);
  return match ? match[1].trim() : content.trim();
}
