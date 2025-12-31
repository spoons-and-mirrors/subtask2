/// <reference types="bun-types" />

import type {CommandConfig} from "./types";
import {parseFrontmatter, getTemplateBody, parseParallelConfig} from "./parser";

export async function loadCommandFile(
  name: string
): Promise<{content: string; path: string} | null> {
  const home = Bun.env.HOME ?? "";
  const dirs = [
    `${home}/.config/opencode/command`,
    `${Bun.env.PWD ?? "."}/.opencode/command`,
  ];

  for (const dir of dirs) {
    // Try direct path first, then search subdirs
    const directPath = `${dir}/${name}.md`;
    try {
      const file = Bun.file(directPath);
      if (await file.exists()) {
        return {content: await file.text(), path: directPath};
      }
    } catch {}

    // Search subdirs for name.md
    try {
      const glob = new Bun.Glob(`**/${name}.md`);
      for await (const match of glob.scan(dir)) {
        const fullPath = `${dir}/${match}`;
        const content = await Bun.file(fullPath).text();
        return {content, path: fullPath};
      }
    } catch {}
  }
  return null;
}

export async function buildManifest(): Promise<Record<string, CommandConfig>> {
  const manifest: Record<string, CommandConfig> = {};
  const home = Bun.env.HOME ?? "";
  const dirs = [
    `${home}/.config/opencode/command`,
    `${Bun.env.PWD ?? "."}/.opencode/command`,
  ];

  for (const dir of dirs) {
    try {
      const glob = new Bun.Glob("**/*.md");
      for await (const file of glob.scan(dir)) {
        const name = file.replace(/\.md$/, "").split("/").pop()!;
        const content = await Bun.file(`${dir}/${file}`).text();
        const fm = parseFrontmatter(content);
        const returnVal = fm.return;
        const returnArr = returnVal
          ? Array.isArray(returnVal)
            ? returnVal
            : [returnVal]
          : [];
        const parallelArr = parseParallelConfig(fm.parallel);

        manifest[name] = {
          return: returnArr,
          parallel: parallelArr,
          agent: fm.agent as string | undefined,
          description: fm.description as string | undefined,
          template: getTemplateBody(content),
        };
      }
    } catch {}
  }
  return manifest;
}
