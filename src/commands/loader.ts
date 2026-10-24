import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Commands: File loading
 */

export async function loadCommandFile(
  name: string
): Promise<{ content: string; path: string } | null> {
  const home = homedir();
  const cwd = process.cwd();
  const dirs = [
    join(home, ".config/opencode/command"),
    join(home, ".config/opencode/commands"),
    join(cwd, ".opencode/command"),
    join(cwd, ".opencode/commands"),
  ];

  for (const dir of dirs) {
    if (!existsSync(dir)) continue;

    // Try direct path first
    const directPath = join(dir, `${name}.md`);
    if (existsSync(directPath)) {
      try {
        const content = await readFile(directPath, "utf-8");
        return { content, path: directPath };
      } catch {}
    }

    // Search recursively for name.md
    try {
      const found = await searchDirForFile(dir, `${name}.md`);
      if (found) {
        const content = await readFile(found, "utf-8");
        return { content, path: found };
      }
    } catch {}
  }
  return null;
}

async function searchDirForFile(dir: string, filename: string): Promise<string | null> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        const nested = await searchDirForFile(fullPath, filename);
        if (nested) return nested;
      } else if (entry.isFile() && entry.name === filename) {
        return fullPath;
      }
    }
  } catch {}
  return null;
}

