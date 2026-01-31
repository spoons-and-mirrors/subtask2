## A better opencode `/command` handler

![subtask2 header](media/header.webp)

### TL:DR - Lower session entropy with a more deterministic agentic loop

This plugin allows your opencode `/commands` to:

- **Chain** `prompts`, `/commands` and `subagents` seamlessly
- **Relay** subagent results or session context to other subagents
- **Run** commands on the fly with the `/subtask` command
- **Override** `/commands` parameters inline (model, agent, return...)
- **Alias** models for quick access (`/subtask -a opus github-copilot/claude-opus-4.5`)

If you already use opencode `/commands`, you'll be right at home, if not, start with [this page](https://opencode.ai/docs/commands/)

![citation](media/quote.webp)

**To install**, add subtask2 to your opencode configuration

```json
{
  "plugins": ["@spoons-and-mirrors/subtask2@latest"]
}
```

---

### Key Features

- `return` instruct main session on command/subtask(s) result
- `$TURN[n]` pass session turns (user/assistant messages)
- `{as:name}` + `$RESULT[name]` capture and reference subtask outputs
- Inline syntax for model, agent, and ad-hoc subtasks
- Model aliases for quick model switching

### Coming Soon

- `loop` loop subtask until user condition is met - _in development_
- `parallel` run subtasks concurrently - _pending [PR #6478](https://github.com/sst/opencode/pull/6478)_

---

<details>
<summary><strong>1. <code>return</code> - Chaining prompts and commands</strong></summary>

### 1. `return` - Chaining prompts and commands

Use `return` to tell the main agent what to do after a command completes. Supports prompts, /commands, and chaining.

```yaml
subtask: true
return: Look again, challenge the findings, then implement the valid fixes.
---
Review the PR# $ARGUMENTS for bugs.
```

For multiple sequential prompts, use an array:

```yaml
subtask: true
return:
  - Implement the fix
  - Run the tests
---
Find the bug in auth.ts
```

**Trigger /commands in return**

```yaml
subtask: true
return:
  - /revise-plan make the UX as horribly impractical as imaginable
  - /implement-plan
  - Send this to my mother in law
---
Design the auth system for $ARGUMENTS
```

**How return prompts work:**

When a `subtask: true` completes, OpenCode injects a synthetic user message asking the model to "summarize the task tool output..." - Subtask2 intercepts this and replaces it with your return prompt.

- **Prompt returns**: The synthetic message text is replaced with your prompt. The LLM responds to your prompt instead of summarizing.
- **Command returns** (starting with `/`): The command executes immediately.

`/commands` are executed as full commands with their own `return` chains.

</details>

<details>
<summary><strong>2. Context & Results - <code>$TURN</code>, <code>{as:name}</code>, <code>$RESULT</code></strong></summary>

### 2. Context & Results

Pass conversation context to subtasks and capture their outputs for later use.

---

#### `$TURN[n]` - Reference previous conversation turns

Use `$TURN[n]` to inject the last N conversation turns into your command. A "turn" is the last meaningful text output from each agent in the conversation.

```yaml
---
description: summarize our conversation so far
subtask: true
---
Review the following conversation and provide a concise summary:

$TURN[10]
```

**Syntax options:**

- `$TURN[6]` - last 6 turns (in chronological order)
- `$TURN[:3]` - just the 3rd turn from the end
- `$TURN[:2:5:8]` - specific turns at indices 2, 5, and 8
- `$TURN[*]` - all turns in the session

**Usage in arguments:**

```bash
/my-command analyze this $TURN[5]
```

**Format output:**

```
--- USER ---
What's the best way to implement auth?

--- ASSISTANT ---
I'd recommend using JWT tokens with...

--- USER ---
Can you show me an example?
...
```

Works in:

- Command body templates
- Command arguments
- Return prompts

---

#### `{as:name}` and `$RESULT[name]` - Named results

Capture command outputs and reference them later in return chains.

**In return chains:**

```yaml
return:
  - /research {as:research}
  - /design {as:design}
  - "Implement based on $RESULT[research] and $RESULT[design]"
```

**With inline subtasks:**

```yaml
return:
  - /subtask {model:openai/gpt-4o && as:gpt-take} analyze the auth flow
  - /subtask {model:anthropic/claude-sonnet-4 && as:claude-take} analyze the auth flow
  - "Synthesize $RESULT[gpt-take] and $RESULT[claude-take] into a unified analysis"
```

**Syntax:** `{as:name}` - can be combined with other overrides using `&&`.

**How it works:**

1. When a subtask with `as:name` completes, its final output is captured
2. The result is stored and associated with the parent session
3. When processing return prompts, `$RESULT[name]` is replaced with the captured output
4. If a result isn't found, it's replaced with `[Result 'name' not found]`

</details>

<details>
<summary><strong>3. Inline Syntax - Overrides and ad-hoc subtasks</strong></summary>

### 3. Inline Syntax

Override command parameters or create subtasks on the fly without modifying command files.

---

#### `{model:...}` - Model override

Override the model for any command invocation:

```bash
/plan {model:anthropic/claude-sonnet-4} design auth system
```

```yaml
return:
  - /plan {model:github-copilot/claude-sonnet-4.5}
  - /plan {model:openai/gpt-4o}
  - Compare both plans and pick the best approach
```

**Model Aliases:** You can use short aliases instead of full model IDs:

```bash
/plan {model:opus} design auth system
```

See section 4 for how to create aliases.

---

#### `{agent:...}` - Agent override

Override the agent for any command invocation:

```bash
/research {agent:explore} find auth patterns
```

```yaml
return:
  - /implement {agent:build}
  - /review {agent:explore}
```

---

#### Combining overrides

Use `&&` to combine multiple overrides:

```bash
/plan {model:opus && agent:build && as:plan} implement the feature
```

---

#### `/subtask {...} prompt` - Ad-hoc subtasks

Create a subtask directly in return chains or chat without needing a command file:

```yaml
return:
  - /subtask {model:openai/gpt-4o && agent:build} Implement the feature
  - Summarize what was done
```

**With result capture:**

```yaml
return:
  - /subtask {model:opus && as:analysis} Analyze the codebase
  - Based on $RESULT[analysis], implement the feature
```

**With single return:**

```yaml
return:
  - /subtask {model:opus && return:validate the output} implement the feature
```

**Syntax:** `/subtask {key:value && ...} prompt text`

---

#### `/subtask prompt` - Simple inline subtasks

For simple subtasks without overrides:

```bash
/subtask tell me a joke
/subtask {model:openai/gpt-4o} analyze this code
/subtask {agent:explore && as:findings} find auth patterns
```

</details>

<details>
<summary><strong>4. <code>/subtask</code> CLI - Help and Model Aliases</strong></summary>

### 4. `/subtask` CLI - Help and Model Aliases

The `/subtask` command includes a CLI for help and model alias management.

---

#### Help

Run `/subtask` with no arguments to see usage:

```bash
/subtask
```

Shows available overrides, examples, and current model aliases.

---

#### Model Aliases

Create short names for frequently used models:

**Create/update alias:**

```bash
/subtask -a opus github-copilot/claude-opus-4.5
/subtask -a sonnet anthropic/claude-sonnet-4
/subtask -a gpt openai/gpt-4o
```

**List aliases:**

```bash
/subtask -a
```

**Delete alias:**

```bash
/subtask -a opus -d
```

**Using aliases:**

Once defined, use the short name anywhere you'd use a model ID:

```bash
/subtask {model:opus} analyze this code
/mycommand {model:sonnet && agent:build} do the thing
```

Or in frontmatter:

```yaml
model: opus
subtask: true
---
Your prompt here
```

Aliases are stored in `~/.config/opencode/subtask2.jsonc`.

</details>

<details>
<summary><strong>5. OpenCode's Generic Message</strong></summary>

### 5. OpenCode's Generic Message

When a `subtask: true` command completes, OpenCode injects a synthetic user message asking the model to "summarize the task tool output..." This message is hidden from the user but visible to the model.

**Subtask2 intercepts this message** and replaces it with your `return` prompt (or a configurable default).

**When `return` is defined:**

- The synthetic message text is replaced with your first return prompt
- Remaining returns fire after each LLM response

**When `return` is not defined:**
If `replace_generic` is enabled (default), subtask2 replaces the synthetic message with a fallback prompt:

> Review, challenge and verify the task tool output above against the codebase. Then validate or revise it, before continuing with the next logical step.

Configure in `~/.config/opencode/subtask2.jsonc`:

```jsonc
{
  // Replace generic prompt when no 'return' is specified
  "replace_generic": true, // defaults to true

  // Custom fallback (optional - has built-in default)
  "generic_return": "custom return prompt",

  // Model aliases
  "model_aliases": {
    "opus": "github-copilot/claude-opus-4.5",
    "sonnet": "anthropic/claude-sonnet-4",
  },
}
```

#### Priority: `return` param > config `generic_return` > built-in default > opencode original

</details>

<details>
<summary><strong>Examples</strong></summary>

**Two-step planning and validation**

```yaml
---
description: plan then validate
agent: build
subtask: true
return:
  - Challenge, verify and validate the plan by reviewing the codebase directly. Then approve, revise, or reject the plan. Implement if solid
  - Take a step back, review what was done/planned for correctness, revise if needed
---
In this session you WILL ONLY PLAN AND NOT IMPLEMENT. Research the codebase until you have gathered enough knowledge to elaborate a full implementation plan.

Consider alternative paths and keep researching until you are confident you found the BEST possible implementation.

BEST often means simple, lean, clean, low surface and coupling.

USER INPUT
$ARGUMENTS
```

**Multi-step workflow**

```yaml
---
description: design, implement, test, document
agent: build
model: opus
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

**Multi-model comparison with result capture**

```yaml
---
subtask: true
return:
  - /subtask {model:opus && as:opus-plan} Plan the auth system
  - /subtask {model:gpt && as:gpt-plan} Plan the auth system
  - "Compare $RESULT[opus-plan] vs $RESULT[gpt-plan] and pick the best approach"
---
We need to implement authentication for our API.
```

</details>

---

### Coming Soon

<details>
<summary><strong>Loop (in development)</strong></summary>

Run a command repeatedly until a condition is met:

```yaml
loop:
  max: 10
  until: "all tests pass"
```

</details>

<details>
<summary><strong>Parallel (pending PR)</strong></summary>

Run multiple subtasks concurrently:

```yaml
parallel:
  - /plan-gemini
  - /plan-opus
return: Compare and unify the plans
```

Requires [PR #6478](https://github.com/sst/opencode/pull/6478) to be merged.

</details>

---

**Contributing**: By submitting a PR, you assign copyright to spoons-and-mirrors. See [CONTRIBUTING.md](CONTRIBUTING.md).

**License**: PolyForm Noncommercial 1.0.0. Commercial use requires a separate commercial license. Contact spoons-and-mirrors via the repository.
