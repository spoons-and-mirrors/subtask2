/// <reference types="bun-types" />

/**
 * Commands: File loading
 */

export async function loadCommandFile(
  name: string
): Promise<{ content: string; path: string } | null> {
  const home = Bun.env.HOME ?? "";
  const dirs = [
    `${home}/.config/opencode/commands`,
    `${Bun.env.PWD ?? "."}/.opencode/commands`,
  ];

  for (const dir of dirs) {
    // Try direct path first, then search subdirs
    const directPath = `${dir}/${name}.md`;
    try {
      const file = Bun.file(directPath);
      if (await file.exists()) {
        return { content: await file.text(), path: directPath };
      }
    } catch {}

    // Search subdirs for name.md
    try {
      const glob = new Bun.Glob(`**/${name}.md`);
      for await (const match of glob.scan(dir)) {
        const fullPath = `${dir}/${match}`;
        const content = await Bun.file(fullPath).text();
        return { content, path: fullPath };
      }
    } catch {}
  }
  return null;
}
