# @openspoon/subtask2 - an opencode plugin

## The Problem

When a subtask command completes, OpenCode tells the main agent to "summarize the findings." The main agent reports back to you and no further action is taken on the subtask results. The agentic loop dies.

This plugin replaces that "summarize" message with the instructions you want to give it, sending the main agent off on a mission given the subtask results.

## Features

### 1. `return` — Per-command instructions

Tell the main agent exactly what to do after a command completes:

```markdown
---
subtask: true
return: Assess the code review. Challenge the findings, then implement the valid fixes.
---

Review this PR for bugs.
```

- For `subtask: true` commands, it replaces OpenCode's "summarize" message.
- For regular commands, it's injected as a follow-up message after the LLM turn ends, identical to what the "chain" param does

**Note:** For non-subtask commands, requires OpenCode with `command.execute.before` hook (pending PR).

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

**Note:** Parallel commands are forced into subtasks regardless of their own `subtask` setting. Their `return`/`chain` are ignored — only the parent's `return`/`chain` applies.

### 3. `chain` — Sequential follow-up prompts

Queue user messages that fire after the command completes:

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

Flow: Command → return prompt → LLM works → chain[0] fires → LLM works → chain[1] fires → ...

**Note:** For non-subtask commands, requires OpenCode with `command.execute.before` hook (pending PR).

### 4. Global fallback — Better default for subtasks

For `subtask: true` commands without a `return`, this plugin replaces OpenCode's generic "summarize" message with something better.

Default: "Challenge and validate the task output. Verify assumptions, identify gaps or errors, then continue with the next logical step."

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
return: Create the component.
chain:
  - Add unit tests.
  - Update the documentation.
---

Design a React modal component.
```

## License

MIT
