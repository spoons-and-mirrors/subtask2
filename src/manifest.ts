// Command manifest loader - scans and loads command configs at startup
import * as fs from "fs";
import * as path from "path";
import { log } from "./logger";
import { parseFrontmatter, type CommandConfig } from "./parsing/frontmatter";

export interface StoredCommandConfig extends CommandConfig {
  template: string;
}

// Scan directory recursively for .md files
function scanDir(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];

  const files: string[] = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...scanDir(full));
    } else if (entry.name.endsWith(".md")) {
      files.push(full);
    }
  }

  return files;
}

// Extract command key from file path
// e.g., /path/.opencode/command/subtask2/as.md -> subtask2/as
function extractKey(file: string, baseDir: string): string {
  const rel = path.relative(baseDir, file);
  return rel.replace(/\.md$/, "");
}

// Build manifest from command directories
export function buildManifest(): Record<string, StoredCommandConfig> {
  const configs: Record<string, StoredCommandConfig> = {};
  const home = process.env.HOME ?? "";

  // Directories to scan (order matters - local overrides global)
  const dirs = [
    path.join(home, ".config", "opencode", "command"),
    path.join(process.cwd(), ".opencode", "command"),
  ];

  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;

    const files = scanDir(dir);
    log(`Scanning ${dir}: found ${files.length} command files`);

    for (const file of files) {
      try {
        const content = fs.readFileSync(file, "utf-8");
        const { config, body } = parseFrontmatter(content);
        const key = extractKey(file, dir);

        configs[key] = {
          ...config,
          template: content,
        };

        log(`Loaded command: ${key}`);
      } catch (err) {
        log(`Error loading ${file}:`, err);
      }
    }
  }

  return configs;
}
