import { expect, test, describe, mock } from "bun:test";
import { parseFrontmatter, hasFrontmatter } from "../src/parsing/frontmatter";
import {
  parseOverrides,
  hasOverrides,
  splitModel,
} from "../src/parsing/overrides";
import {
  parseCommand,
  parseCommandWithOverrides,
  isCommand,
  isSubtaskCommand,
  parsePipeArgs,
} from "../src/parsing/commands";

// Mock resolveModelAlias to avoid FS access during parsing tests
mock.module("../src/config", () => ({
  resolveModelAlias: (m: string) =>
    m === "opus" ? "anthropic/claude-3-opus" : m,
  getPluginConfig: () => ({
    model_aliases: { opus: "anthropic/claude-3-opus" },
  }),
}));

describe("Parsing: Frontmatter", () => {
  test("should parse simple frontmatter", () => {
    const template = `---
subtask: true
model: gpt-4o
---
Body text`;
    const { config, body } = parseFrontmatter(template);
    expect(config.subtask).toBe(true);
    expect(config.model).toBe("gpt-4o");
    expect(body.trim()).toBe("Body text");
  });

  test("should parse multiline returns", () => {
    const template = `---
return:
  - Step 1
  - Step 2
---
Body`;
    const { config } = parseFrontmatter(template);
    expect(config.return).toEqual(["Step 1", "Step 2"]);
  });

  test("should parse parallel configs (array of strings)", () => {
    const template = `---
parallel:
  - /cmd1
  - /cmd2
---
Body`;
    const { config } = parseFrontmatter(template);
    expect(config.parallel).toEqual(["/cmd1", "/cmd2"]);
  });

  test("should parse parallel configs (array of objects)", () => {
    const template = `---
parallel:
  - command: /cmd1
    arguments: arg1
  - command: /cmd2
---
Body`;
    const { config } = parseFrontmatter(template);
    expect(config.parallel).toEqual([
      { command: "/cmd1", arguments: "arg1" },
      { command: "/cmd2" },
    ]);
  });

  test("should handle missing frontmatter", () => {
    const template = "No frontmatter here";
    const { config, body } = parseFrontmatter(template);
    expect(config).toEqual({});
    expect(body).toBe(template);
    expect(hasFrontmatter(template)).toBe(false);
  });
});

describe("Parsing: Overrides", () => {
  test("should parse all override types", () => {
    const text =
      "{model:opus && agent:build && as:myresult && return:Summarize} Do something";
    const parsed = parseOverrides(text);

    expect(parsed.model).toBe("anthropic/claude-3-opus");
    expect(parsed.agent).toBe("build");
    expect(parsed.as).toBe("myresult");
    expect(parsed.return).toBe("Summarize");
    expect(parsed.remainder.trim()).toBe("Do something");
  });

  test("should handle missing overrides", () => {
    const text = "Just a prompt";
    const parsed = parseOverrides(text);
    expect(parsed.remainder).toBe("Just a prompt");
    expect(parsed.model).toBeUndefined();
    expect(hasOverrides(text)).toBe(false);
  });

  test("should split model correctly", () => {
    expect(splitModel("openai/gpt-4o")).toEqual({
      providerID: "openai",
      modelID: "gpt-4o",
    });
    expect(splitModel("invalid-model")).toBeNull();
  });
});

describe("Parsing: Commands", () => {
  test("should parse command and args", () => {
    const text = "/test arg1 arg2";
    const parsed = parseCommand(text);
    expect(parsed?.name).toBe("test");
    expect(parsed?.args).toBe("arg1 arg2");
    expect(isCommand(text)).toBe(true);
  });

  test("should parse command with overrides", () => {
    const text = "/test {model:gpt-4o} the prompt";
    const parsed = parseCommandWithOverrides(text);
    expect(parsed?.name).toBe("test");
    expect(parsed?.overrides.model).toBe("gpt-4o");
    expect(parsed?.args).toBe("the prompt");
  });

  test("should detect /subtask command", () => {
    expect(isSubtaskCommand("/subtask do something")).toBe(true);
    expect(isSubtaskCommand("/other do something")).toBe(false);
  });

  test("should parse pipe args", () => {
    const args = "main || pipe1 || pipe2";
    expect(parsePipeArgs(args)).toEqual(["main", "pipe1", "pipe2"]);
  });
});
