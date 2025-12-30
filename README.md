# @openspoon/subtask2 - an opencode plugin

## The Problem

When a subtask command completes, OpenCode tells the main agent to "summarize the findings." The main agent reports back to you and no further action is taken on the subtask results. The agentic loop dies.

This plugin replaces that "summarize" message with the instructions you want to give it, sending the main agent off on a mission given the subtask results.

## Prerequisites

**This plugin ONLY works with commands that have `subtask: true` in their frontmatter.**

```markdown
---
subtask: true   ← REQUIRED for this plugin to do anything
---
```

## Features

### 1. `return` — Per-command instructions

Tell the main agent exactly what to do after THIS specific subtask:

```markdown
---
subtask: true
return: Assess the code review. Challenge the findings, then implement the valid fixes.
---

Review this PR for bugs.
```

### 2. `parallel` — Run multiple subtasks concurrently ⚠️ **PENDING PR** (ignored for now)

Spawn additional command subtasks alongside the main one:

```markdown
---
subtask: true
parallel: security-review, perf-review
return: Synthesize all review results and create a unified action plan.
---

Review this code for correctness.
```

This runs 3 subtasks in parallel:

1. The main command (correctness review)
2. `security-review` command
3. `perf-review` command

When ALL complete, the main agent gets the `return` prompt.

**Note:** Parallel commands must be other command files. Their own `return`/`chain` are ignored — only the parent's `return` applies.

**Requires:** OpenCode with `command.execute.before` hook (pending PR).

### 3. `chain` — Sequential follow-up prompts

Queue user messages that fire after the subtask completes:

```markdown
---
subtask: true
return: Implement the fix.
chain:
  - Now write tests for the fix.
  - Run the tests and fix any failures.
---

Find the bug in auth.ts
```

Flow: Subtask → return prompt → LLM works → chain[0] fires → LLM works → chain[1] fires → ...

### 4. Global fallback — Better default for all subtasks

Even without `return`, this plugin will replace OpenCode's generic "summarize" injected message with something "better".
By default it uses: "Challenge and validate the task tool output above. Verify assumptions, identify gaps or errors, then continue with the next logical step."

Configure in `~/.config/opencode/subtask2.jsonc`:

```jsonc
{
  // Replace generic prompt when no 'return' is specified
  "replace_generic": true,

  // Custom fallback (optional - has built-in default)
  "generic_return": "your custom return prompt here"
}
```

## Priority Order

When a subtask completes, what message does the main agent see?

1. **`return` param** → Your specific instructions (highest priority)
2. **Config `generic_return`** → Your custom fallback (if `replace_generic: true`)
3. **Built-in default** → "Challenge and validate..." (if `replace_generic: true`)
4. **OpenCode original** → "Summarize..." (if `replace_generic: false`)

## Installation

```json
{
  "plugins": ["@openspoon/subtask2"]
}
```

## Quick Examples

**Simple: Make the agent act on results**

```markdown
---
subtask: true
return: Implement the suggested improvements.
---

Analyze this function for performance issues.
```

**Parallel: Multiple perspectives at once**

```markdown
---
subtask: true
parallel: brainstorm-solutions, research-prior-art
return: Evaluate all ideas and create an implementation plan.
---

Identify the core problem in our auth flow.
```

**Chain: Multi-step workflow**

```markdown
---
subtask: true
return: Create the component.
chain:
  - Add unit tests.
  - Update the documentation.
---

Design a React modal component.
```

## License

MIT
