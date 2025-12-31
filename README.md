# subtask2 - a stronger opencode /command handler

Give super powers to your slash commands with `@openspoon/subtask2`

## Installation

Add subtask2 to your opencode config plugin array

```json
{
  "plugins": ["@openspoon/subtask2"]
}
```

## TL:DR - Keep the agentic loop alive + parallel commands

This plugins affects how opencode handles commands with additional frontmatter parameters and enables parallel commands

- `return` tells the main agent what to do with subtask(s) results (not just "summarize it and end turn")
- `parallel` runs multiple subtasks concurrently (accepts arguments)
- `chain` queues follow-up prompts that fire automatically (because why not...)
- 'better' defaults replace the generic opencode's "summarize..." on subtask completion with something that keeps the agent working, or a custom generic prompt

⚠️ Requires [this PR](https://github.com/sst/opencode/pull/6478) for `parallel` and non-subtask features, as well as proper model inheritance to work.

## Examples

**Parallel subtask with different models (A/B plan comparison)**

```yaml
---
description: multi-model ensemble, 3 models plan in parallel, best ideas unified
model: github-copilot/claude-opus-4.5
subtask: true
parallel: plan-gemini, plan-gpt
return: Compare all 3 plans and validate each directly against the codebase. Pick the best ideas from each and create a unified implementation plan.
chain: feed the implementation plan to a @review subagent, let's poke holes.
---
Plan the implementation for the following feature
> $ARGUMENTS
```

**Isolated "Plan" mode**

```yaml
---
description: two-step implementation planning and validation
agent: build
subtask: true
return: Challenge, verify and validate the plan by reviewing the codebase directly. Then approve, revise, or reject the plan. Implement if solid
chain: take a step back, review what was done/planned for correctness, revise if needed
---
In this session you WILL ONLY PLAN AND NOT IMPLEMENT. You are to take the `USER INPUT` and research the codebase until you have gathered enough knowledge to elaborate a full fledged implementation plan

You MUST consider alternative paths and keep researching until you are confident you found the BEST possible implementation

BEST often means simple, lean, clean, low surface and coupling
Make it practical, maintainable and not overly abstracted

Follow your heart
> DO NOT OVERENGINEER SHIT

USER INPUT
$ARGUMENTS
```

**Multi-step workflow**

```yaml
---
description: design, implement, test, document
agent: build
model: github-copilot/claude-opus-4.5
subtask: true
return: Implement the component following the conceptual design specifications.
chain:
  - Write comprehensive unit tests for all edge cases.
  - Update the documentation and add usage examples.
  - Run the test suite and fix any failures.
---
Conceptually design a React modal component with the following requirements
> $ARGUMENTS
```

## Features

### 1. `return` - Command 'return' instructions or the old 'look again' trick.

Tell the main agent exactly what to do after a command completes:

```yaml
---
subtask: true
return: Look again, challenge the findings, then implement the valid fixes.
---
Review the PR# $ARGUMENTS for bugs.
```

- For `subtask: true` commands, it replaces opencode's default injected "summarize" message.
- For regular commands, it injects the return prompt as a follow-up message when the LLM turn ends, identical to what the "chain" param does

**Note:** For non-subtask commands, requires opencode with `command.execute.before` hook (pending PR).

### 2. `parallel` - Run multiple subtasks concurrently ⚠️ **PENDING PR** (ignored for now)

Spawn additional command subtasks alongside the main one:

```yaml
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

**With custom arguments per command:**

```yaml
---
subtask: true
parallel:
  - command: research-docs
    arguments: authentication flow
  - command: research-codebase
    arguments: auth middleware implementation
  - security-audit
return: Synthesize all findings into an implementation plan.
---
Design a new auth system for $ARGUMENTS
```

- `research-docs` gets "authentication flow" as `$ARGUMENTS`
- `research-codebase` gets "auth middleware implementation"
- `security-audit` inherits the main command's `$ARGUMENTS`

**Note:** Parallel commands are forced into subtasks regardless of their own `subtask` setting. Their `return`/`chain` are ignored — only the parent's `return`/`chain` applies.

**Tip:** If all commands share the same arguments, use the simple syntax:

```yaml
parallel: research-docs, research-codebase, security-audit
```

All three inherit the main command's `$ARGUMENTS`.

**Tip:** You can also pass arguments inline using `||` separator:

```
/mycommand main args || parallel1 args || parallel2 args
```

Each segment maps to a parallel command in order. Priority: **frontmatter args > pipe args > inherit main args**.

### 3. `chain` - Sequential follow-up prompts

Queue user messages that fire after the command completes:

```yaml
---
subtask: true
return: Implement the fix.
chain:
  - Review your implementation for correctness, make sure this work on the first try
  - Tell me a joke
---
Find the bug in auth.ts
```

Flow: Command → return prompt → LLM works → chain[0] fires → LLM works → chain[1] fires → ...

**Note:** For non-subtask commands, requires opencode with `command.execute.before` hook (pending PR).

### 4. Global fallback - 'Better' default for subtasks

For `subtask: true` commands without a `return`, this plugin replaces opencode's generic "summarize" message with something better.

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

#### Priority Order

1. **`return` param** → Your specific instructions (highest priority)
2. **Config `generic_return`** → Your custom fallback (if `replace_generic: true`)
3. **Built-in default** → "Challenge and validate..." (if `replace_generic: true`)
4. **OpenCode original** → "Summarize..." (if `replace_generic: false`)

---

## License

MIT
