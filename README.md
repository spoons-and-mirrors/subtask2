# @openspoon/subtask2

OpenCode plugin that controls what happens **after** a subtask completes.

## The Problem

When a subtask (subagent) finishes, OpenCode injects a generic prompt: `"Summarize the task tool output above and continue with your task."`

This often leads to the main agent just relaying the response:

> "Here's what the subagent found: [result]" — *end of turn*

The main agent becomes a passive messenger rather than an active participant.

## The Solution

This plugin intercepts OpenCode's synthetic message and replaces it with something better:

1. **Per-command `return` prompt** — Give specific instructions for what the main agent should do with the subtask result
2. **`parallel`** — Spawn additional subtasks alongside the main command, all running concurrently
3. **Global fallback** — Even without `return`, replace the generic prompt with one that encourages critical thinking
4. **`chain`** — Queue follow-up prompts that execute sequentially after the subtask completes

## Installation

Add to your `opencode.json`:

```json
{
  "plugins": ["@openspoon/subtask2"]
}
```

## Configuration

On first run, the plugin creates `~/.config/opencode/subtask2.jsonc`:

```jsonc
{
  // Replace OpenCode's generic "Summarize..." prompt when no return is specified
  "replace_generic": true

  // Custom prompt to use (uses built-in default if not set)
  // "prompt": "Your custom prompt here"
}
```

**Options:**

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `replace_generic` | boolean | `true` | Replace the generic prompt for subtasks without a `return` param |
| `prompt` | string | (built-in) | Custom replacement prompt. Default: "Challenge and validate the task output above. Verify assumptions, identify gaps or errors, then continue with the next logical step." |

**Priority:**

1. Command `return` param → always wins
2. Config `prompt` → used when no `return` and `replace_generic: true`
3. Built-in default → used when no `return`, `replace_generic: true`, and no custom `prompt`
4. OpenCode's original → only if `replace_generic: false`

## Usage

Add `return`, `parallel`, and/or `chain` to your command frontmatter:

### Example: Code Review Command

`.opencode/command/review.md`

```markdown
---
description: subtask2 return and chain prompt example
agent: general
subtask: true
return: You are the agent in charge of assessing the bug review, challenge, verify and validate it, then discard it or implement it.
chain:
  - Let's now rinse and repeat with PR#356, use the task tool to review it for bugs etc... then assess, challenge, validate -> discard or implement.
  - Rinse and repeat, with next PR.
---

Review PR#355 for bugs, security issues, and code style problems.
```

### Example: Parallel Research Command

`.opencode/command/research.md`

```markdown
---
description: Research a topic from multiple angles simultaneously
agent: general
subtask: true
parallel: security-research, performance-research, ux-research
return: Synthesize the parallel research results. Identify common themes, conflicts, and actionable recommendations.
---

Research best practices for implementing authentication in our app.
```

When you run `/research`, the plugin spawns three additional subtasks (`security-research`, `performance-research`, `ux-research`) in parallel alongside the main command. All four run concurrently, and when they complete, the main agent synthesizes the results.

**Note:** Parallel commands ignore their own `return`/`chain` params when invoked via `parallel`. The parent command's `return` applies to the combined result.

## How It Works

**Without this plugin:**

```
Subagent → "Found 3 bugs" → OpenCode adds "Summarize..." → Main agent → "The subagent found 3 bugs" → END
```

**With `return`:**

```
Subagent → "Found 3 bugs" → Plugin replaces with "Assess and implement fixes" → Main agent → *starts working on fixes*
```

**Without `return` but `replace_generic: true`:**

```
Subagent → "Found 3 bugs" → Plugin replaces with "Challenge and validate..." → Main agent → *critically evaluates and acts*
```

The plugin intercepts OpenCode's synthetic user message and replaces it, so the main agent receives instructions from the "user" rather than just being told to summarize.

`chain` allows you to queue additional prompts that fire sequentially after each completion, enabling multi-step automated workflows.

`parallel` spawns multiple subtasks concurrently - useful for research, brainstorming, or any task that benefits from multiple perspectives running in parallel.

## Requirements

The `parallel` feature requires OpenCode with the `command.execute.before` hook (added in a recent update). Ensure you're running the latest version.

## License

MIT
