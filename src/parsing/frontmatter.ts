// Parse YAML frontmatter from command templates

export interface ParallelConfig {
  command: string;
  arguments?: string;
}

export interface CommandConfig {
  subtask?: boolean;
  model?: string;
  agent?: string;
  description?: string;
  return?: string | string[];
  parallel?: string | string[] | ParallelConfig[];
}

interface FrontmatterResult {
  config: CommandConfig;
  body: string;
}

// Simple YAML value parser (handles strings, booleans, arrays)
const parseValue = (val: string): unknown => {
  const trimmed = val.trim();

  // Boolean
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;

  // Number
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);

  // Quoted string - remove quotes
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }

  // Inline array: [a, b, c]
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    const inner = trimmed.slice(1, -1);
    if (!inner.trim()) return [];
    return inner.split(",").map(s => parseValue(s));
  }

  return trimmed;
};

// Parse multiline array (YAML list format)
const parseArrayItems = (lines: string[], startIdx: number): string[] => {
  const items: string[] = [];
  let i = startIdx;

  while (i < lines.length) {
    const line = lines[i];
    const match = line.match(/^\s+-\s+(.+)$/);
    if (match) {
      items.push(match[1].trim());
      i++;
    } else if (line.match(/^\s*$/)) {
      // Empty line, continue
      i++;
    } else {
      // Non-array line, stop
      break;
    }
  }

  return items;
};

// Parse parallel config - handles string, array, or object format
const parseParallelValue = (
  val: string,
  lines: string[],
  startIdx: number
): string | string[] | ParallelConfig[] => {
  const trimmed = val.trim();

  // Inline string: parallel: /cmd1, /cmd2
  if (trimmed && !trimmed.startsWith("-")) {
    // Check if it's a comma-separated list
    if (trimmed.includes(",")) {
      return trimmed.split(",").map(s => s.trim());
    }
    return trimmed;
  }

  // Array format - check for object items or string items
  const items: Array<string | ParallelConfig> = [];
  let i = startIdx;

  while (i < lines.length) {
    const line = lines[i];

    // String item: - /command
    const stringMatch = line.match(/^\s+-\s+(\/.+)$/);
    if (stringMatch) {
      items.push(stringMatch[1].trim());
      i++;
      continue;
    }

    // Object item start: - command: name
    const objMatch = line.match(/^\s+-\s+command:\s*(.+)$/);
    if (objMatch) {
      const config: ParallelConfig = { command: objMatch[1].trim() };

      // Check next line for arguments
      if (i + 1 < lines.length) {
        const argsMatch = lines[i + 1].match(/^\s+arguments:\s*(.+)$/);
        if (argsMatch) {
          config.arguments = argsMatch[1].trim();
          i++;
        }
      }

      items.push(config);
      i++;
      continue;
    }

    // Empty line, continue
    if (line.match(/^\s*$/)) {
      i++;
      continue;
    }

    // Non-matching line, stop
    break;
  }

  // Determine return type based on items
  if (items.length === 0) return [];
  if (items.every(item => typeof item === "string")) {
    return items as string[];
  }
  return items as ParallelConfig[];
};

export const parseFrontmatter = (template: string): FrontmatterResult => {
  const lines = template.split("\n");

  // Check for frontmatter markers
  if (!lines[0]?.trim().startsWith("---")) {
    return { config: {}, body: template };
  }

  // Find closing marker
  let endIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      endIdx = i;
      break;
    }
  }

  if (endIdx === -1) {
    return { config: {}, body: template };
  }

  // Parse frontmatter content
  const config: CommandConfig = {};
  const fmLines = lines.slice(1, endIdx);

  let i = 0;
  while (i < fmLines.length) {
    const line = fmLines[i];

    // Skip empty lines
    if (!line.trim()) {
      i++;
      continue;
    }

    // Parse key: value
    const match = line.match(/^(\w+):\s*(.*)$/);
    if (!match) {
      i++;
      continue;
    }

    const [, key, value] = match;

    // Handle special cases
    if (key === "return") {
      if (value.trim()) {
        // Inline value
        config.return = parseValue(value) as string | string[];
      } else {
        // Multiline array
        config.return = parseArrayItems(fmLines, i + 1);
        // Skip parsed lines
        while (i + 1 < fmLines.length && fmLines[i + 1].match(/^\s+-/)) {
          i++;
        }
      }
    } else if (key === "parallel") {
      config.parallel = parseParallelValue(value, fmLines, i + 1);
      // Skip parsed lines if array
      while (i + 1 < fmLines.length && fmLines[i + 1].match(/^\s+-/)) {
        i++;
      }
    } else if (key === "subtask") {
      config.subtask = value.trim() === "true";
    } else if (key === "model") {
      config.model = value.trim();
    } else if (key === "agent") {
      config.agent = value.trim();
    } else if (key === "description") {
      config.description = value.trim();
    }

    i++;
  }

  // Extract body (everything after frontmatter)
  const body = lines.slice(endIdx + 1).join("\n");

  return { config, body };
};

// Extract just the config without body
export const extractFrontmatterConfig = (template: string): CommandConfig => {
  return parseFrontmatter(template).config;
};

// Check if template has frontmatter
export const hasFrontmatter = (template: string): boolean => {
  return template.trimStart().startsWith("---");
};
