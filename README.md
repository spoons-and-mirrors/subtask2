# A stronger opencode /command handler

### TL:DR - Keep the agentic loop alive + parallel commands

This plugins affects how opencode handles slash commands with additional frontmatter parameters and enables parallel command execution. Super powers for your slash commands

- `return` tell the main agent what to do with **command** or **subtask(s)** results. Supports multiple sequential prompts.
- `parallel` run multiple subtasks concurrently (accepts arguments)

⚠️ Requires [this PR](https://github.com/sst/opencode/pull/6478) for `parallel` and non-subtask command features, as well as proper model inheritance (piping the right model and agent to the right subtask) to work.

---

<details>
<summary><strong>Some examples</strong> (click to expand)</summary>

**Parallel subtask with different models (A/B plan comparison)**

```yaml
---
description: multi-model ensemble, 3 models plan in parallel, best ideas unified
model: github-copilot/claude-opus-4.5
subtask: true
parallel: plan-gemini, plan-gpt
return:
  - Compare all 3 plans and validate each directly against the codebase. Pick the best ideas from each and create a unified implementation plan.
  - Feed the implementation plan to a review subagent, let's poke holes.
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
return:
  - Challenge, verify and validate the plan by reviewing the codebase directly. Then approve, revise, or reject the plan. Implement if solid
  - Take a step back, review what was done/planned for correctness, revise if needed
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
return:
  - Implement the component following the conceptual design specifications.
  - Write comprehensive unit tests for all edge cases.
  - Update the documentation and add usage examples.
  - Run the test suite and fix any failures.
---
Conceptually design a React modal component with the following requirements
> $ARGUMENTS
```

</details>

<details>
<summary><strong>Feature documentation</strong> (click to expand)</summary>

### 1. `return` - Command return instructions (supports chaining)

Tell the main agent exactly what to do after a command completes:

```yaml
---
subtask: true
return: Look again, challenge the findings, then implement the valid fixes.
---
Review the PR# $ARGUMENTS for bugs.
```

For multiple sequential prompts, use an array:

```yaml
---
subtask: true
return: [Implement the fix, Run the tests]
---
Find the bug in auth.ts
```

- **First return** replaces opencode's "summarize" message (for subtasks) or fires as follow-up (for non-subtasks)
- **Additional returns** fire sequentially after each LLM turn completes

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

```bash
/mycommand main args || parallel1 args || parallel2 args
```

or

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

**Note:** Parallel commands are forced into subtasks regardless of their own `subtask` setting. Their `return` are ignored — only the parent's `return` applies.

**Tip:** If all commands share the same arguments, use the simple syntax:

```yaml
parallel: research-docs, research-codebase, security-audit
```

All three inherit the main command's `$ARGUMENTS`.

**Tip:** You can also pass arguments inline using `||` separator:

```bash
/mycommand main args || parallel1 args || parallel2 args
```

Each segment maps to a parallel command in order. Priority: **pipe args > frontmatter args > inherit main args**.

### 3. Global fallback - 'Better' default for subtasks

By default opencode injects a prompt in the main session once a **subtask** is completed.

For `subtask: true` commands without a `return`, this plugin replaces the opencode generic "summarize" message with by default: "Challenge and validate the task output. Verify assumptions, identify gaps or errors, then continue with the next logical step."

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

</details>

---

To install, add subtask2 to your opencode config plugin array

```json
{
  "plugins": ["@openspoon/subtask2"]
}
```
