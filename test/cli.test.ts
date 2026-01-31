import { expect, test, describe, mock, beforeEach } from "bun:test";
import {
  setAlias,
  getAliases,
  deleteAlias,
  formatAliases,
} from "../src/features/aliases";
import { handleCLI, setClient } from "../src/features/cli";

// Mock config
let mockConfig = {
  model_aliases: {} as Record<string, string>,
};

mock.module("../src/config", () => ({
  getPluginConfig: () => mockConfig,
  saveConfig: (cfg: any) => {
    mockConfig = cfg;
  },
}));

describe("Features: Aliases", () => {
  beforeEach(() => {
    mockConfig = { model_aliases: {} };
  });

  test("should set and get aliases", async () => {
    await setAlias("opus", "anthropic/claude-3-opus");
    expect(getAliases()).toEqual({ opus: "anthropic/claude-3-opus" });
  });

  test("should delete aliases", async () => {
    await setAlias("opus", "anthropic/claude-3-opus");
    deleteAlias("opus");
    expect(getAliases()).toEqual({});
  });

  test("should format aliases for display", async () => {
    await setAlias("opus", "anthropic/claude-3-opus");
    const formatted = formatAliases();
    expect(formatted).toContain("opus → anthropic/claude-3-opus");
  });
});

describe("Features: CLI", () => {
  const sid = "session-cli";
  let lastPrompt: any = null;

  const mockClient = {
    session: {
      prompt: mock(async (req: any) => {
        lastPrompt = req;
        return {};
      }),
    },
  };

  beforeEach(() => {
    setClient(mockClient);
    lastPrompt = null;
    mockConfig = { model_aliases: {} };
  });

  test("should show help when no args", async () => {
    const handled = await handleCLI(sid, "");
    expect(handled).toBe(true);
    expect(lastPrompt.body.parts[0].text).toContain(
      "## /subtask - Inline Subtask Command"
    );
  });

  test("should handle alias creation via CLI", async () => {
    const handled = await handleCLI(sid, "-a gpt openai/gpt-4o");
    expect(handled).toBe(true);
    expect(getAliases().gpt).toBe("openai/gpt-4o");
  });

  test("should handle alias deletion via CLI", async () => {
    await setAlias("gpt", "openai/gpt-4o");
    const handled = await handleCLI(sid, "-a gpt -d");
    expect(handled).toBe(true);
    expect(getAliases().gpt).toBeUndefined();
  });

  test("should return false for non-CLI command", async () => {
    const handled = await handleCLI(sid, "{model:opus} some prompt");
    expect(handled).toBe(false);
  });
});
