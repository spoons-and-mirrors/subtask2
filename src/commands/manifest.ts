/// <reference types="bun-types" />

import type { CommandConfig } from "../types";
import {
  parseFrontmatter,
  getTemplateBody,
  parseParallelConfig,
} from "../parsing";

/**
 * Commands: Manifest building
 */

export async function buildManifest(): Promise<Record<string, CommandConfig>> {
  const manifest: Record<string, CommandConfig> = {};
  const home = Bun.env.HOME ?? Bun.env.USERPROFILE ?? "";
  const dirs = [
    `${home}/.config/opencode/commands`,
    `${Bun.env.PWD ?? "."}/.opencode/commands`,
  ];

  for (const dir of dirs) {
    try {
      const glob = new Bun.Glob("**/*.md");
      for await (const file of glob.scan(dir)) {
        const name = file.replace(/\.md$/, "").split("/").pop()!;
        const pathKey = file.replace(/\.md$/, "");

        const content = await Bun.file(`${dir}/${file}`).text();
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
