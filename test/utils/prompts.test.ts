import { describe, it, expect } from "bun:test";
import {
  DEFAULT_RETURN_PROMPT,
  S2_INLINE_INSTRUCTION,
  loopEvaluationPrompt,
  loopYieldPrompt,
  AUTO_WORKFLOW_PROMPT_TEMPLATE,
  getAutoWorkflowPrompt,
} from "../../src/utils/prompts";

describe("DEFAULT_RETURN_PROMPT", () => {
  it("is a non-empty string", () => {
    expect(typeof DEFAULT_RETURN_PROMPT).toBe("string");
    expect(DEFAULT_RETURN_PROMPT.length).toBeGreaterThan(0);
  });

  it("contains key instruction words", () => {
    expect(DEFAULT_RETURN_PROMPT.toLowerCase()).toContain("review");
    expect(DEFAULT_RETURN_PROMPT.toLowerCase()).toContain("challenge");
  });
});

describe("S2_INLINE_INSTRUCTION", () => {
  it("contains system tag", () => {
    expect(S2_INLINE_INSTRUCTION).toContain("<system>");
    expect(S2_INLINE_INSTRUCTION).toContain("</system>");
  });

  it("instructs minimal response", () => {
    expect(S2_INLINE_INSTRUCTION.toLowerCase()).toContain("running");
  });
});

describe("loopEvaluationPrompt", () => {
  it("includes the condition", () => {
    const prompt = loopEvaluationPrompt("all tests pass", 3, 10);
    expect(prompt).toContain("all tests pass");
  });

  it("includes iteration count", () => {
    const prompt = loopEvaluationPrompt("done", 5, 10);
    expect(prompt).toContain("5/10");
  });

  it("includes instructions tag", () => {
    const prompt = loopEvaluationPrompt("x", 1, 5);
    expect(prompt).toContain("<instructions subtask2=loop-evaluation>");
    expect(prompt).toContain("</instructions>");
  });

  it("includes break signal syntax", () => {
    const prompt = loopEvaluationPrompt("x", 1, 1);
    expect(prompt).toContain("<subtask2 loop=break/>");
  });

  it("includes user-condition tags", () => {
    const prompt = loopEvaluationPrompt("my condition", 1, 5);
    expect(prompt).toContain("<user-condition>");
    expect(prompt).toContain("</user-condition>");
    expect(prompt).toContain("my condition");
  });

  it("instructs not to write files", () => {
    const prompt = loopEvaluationPrompt("x", 1, 1);
    expect(prompt.toLowerCase()).toContain("do not write");
  });
});

describe("loopYieldPrompt", () => {
  it("includes iteration count", () => {
    const prompt = loopYieldPrompt(3, 5);
    expect(prompt).toContain("3/5");
  });

  it("includes instructions tag", () => {
    const prompt = loopYieldPrompt(1, 3);
    expect(prompt).toContain("<instructions subtask2=loop-yield>");
    expect(prompt).toContain("</instructions>");
  });

  it("instructs to yield", () => {
    const prompt = loopYieldPrompt(1, 1);
    expect(prompt.toLowerCase()).toContain("yield");
  });
});

describe("AUTO_WORKFLOW_PROMPT_TEMPLATE", () => {
  it("is a non-empty string", () => {
    expect(typeof AUTO_WORKFLOW_PROMPT_TEMPLATE).toBe("string");
    expect(AUTO_WORKFLOW_PROMPT_TEMPLATE.length).toBeGreaterThan(0);
  });

  it("contains README placeholder", () => {
    expect(AUTO_WORKFLOW_PROMPT_TEMPLATE).toContain("{{SUBTASK2_README}}");
  });

  it("includes output format instructions", () => {
    expect(AUTO_WORKFLOW_PROMPT_TEMPLATE).toContain('<subtask2 auto="true">');
    expect(AUTO_WORKFLOW_PROMPT_TEMPLATE).toContain("</subtask2>");
  });

  it("ends with USER INPUT marker", () => {
    expect(AUTO_WORKFLOW_PROMPT_TEMPLATE.trim()).toMatch(/USER INPUT:?\s*$/);
  });
});

describe("getAutoWorkflowPrompt", () => {
  it("returns a promise", () => {
    const result = getAutoWorkflowPrompt();
    expect(result).toBeInstanceOf(Promise);
  });

  it("resolves to a string with README content injected", async () => {
    const prompt = await getAutoWorkflowPrompt();
    expect(typeof prompt).toBe("string");
    // README placeholder should be replaced
    expect(prompt).not.toContain("{{SUBTASK2_README}}");
    // Should contain some README content (or fallback message)
    expect(prompt.length).toBeGreaterThan(
      AUTO_WORKFLOW_PROMPT_TEMPLATE.length - 50
    );
  });

  it("includes output format instructions", async () => {
    const prompt = await getAutoWorkflowPrompt();
    expect(prompt).toContain('<subtask2 auto="true">');
    expect(prompt).toContain("</subtask2>");
  });

  it("ends with USER INPUT marker", async () => {
    const prompt = await getAutoWorkflowPrompt();
    expect(prompt.trim()).toMatch(/USER INPUT:?\s*$/);
  });
});

describe("loadReadmeContent fallback", () => {
  it("returns fallback message when README cannot be loaded", async () => {
    // Import the reset function and mock Bun.file to throw
    const { _resetReadmeCache } = await import("../../src/utils/prompts");
    _resetReadmeCache();

    // Save original Bun.file
    const originalBunFile = Bun.file;

    // Mock Bun.file to throw an error
    (Bun as any).file = () => {
      throw new Error("Simulated file read error");
    };

    try {
      const prompt = await getAutoWorkflowPrompt();
      expect(prompt).toContain("README could not be loaded");
      expect(prompt).toContain(
        "https://github.com/spoons-and-mirrors/subtask2"
      );
    } finally {
      // Restore original Bun.file and reset cache for other tests
      (Bun as any).file = originalBunFile;
      _resetReadmeCache();
    }
  });
});
