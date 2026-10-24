import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import type { CommandConfig } from "../types";
import {
  parseFrontmatter,
  getTemplateBody,
  parseParallelConfig,
} from "../parsing";

/**
 * Commands: Manifest building
 */

async function scanMarkdownFiles(dir: string, baseDir: string = dir): Promise<Array<{ relativePath: string; fullPath: string }>> {
  const results: Array<{ relativePath: string; fullPath: string }> = [];
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        const nested = await scanMarkdownFiles(fullPath, baseDir);
        results.push(...nested);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        const rel = relative(baseDir, fullPath);
        results.push({ relativePath: rel, fullPath });
      }
    }
  } catch {}
  return results;
}

export async function buildManifest(): Promise<Record<string, CommandConfig>> {
  const manifest: Record<string, CommandConfig> = {};
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

    try {
      const files = await scanMarkdownFiles(dir);
      for (const { relativePath, fullPath } of files) {
        const pathKey = relativePath.replace(/\.md$/, "");
        const name = pathKey.split("/").pop()!;

        const content = await readFile(fullPath, "utf-8");
        const fm = parseFrontmatter(content);
        const returnVal = fm.return;
        const returnArr = returnVal
          ? Array.isArray(returnVal)
            ? returnVal
            : [returnVal]
          : [];
        const parallelArr = parseParallelConfig(fm.parallel);

        const config: CommandConfig = {
          return: returnArr,
          parallel: parallelArr,
          agent: fm.agent as string | undefined,
          description: fm.description as string | undefined,
          template: getTemplateBody(content),
          loop: fm.loop as any,
          model: fm.model as string | undefined,
          auto: fm.subtask2 === "auto",
        };

        // Store with filename-only key
        manifest[name] = config;

        // Also store with full relative path for subfolder commands
        if (pathKey !== name) {
          manifest[pathKey] = config;
        }
      }
    } catch (e) {
      // Ignore errors scanning directories that don't exist
    }
  }
  return manifest;
}

