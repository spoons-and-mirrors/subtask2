# Feature Spec: Inline Overrides (`{model:}`, `{agent:}`)

## Summary

Inline overrides allow changing the model or agent for any command invocation without modifying the command file. This enables multi-model workflows where different steps use different LLMs.

**Model aliases** allow users to define short names for frequently used models.

---

## Syntax

### Model Override (Full ID)

```
/mycommand {model:anthropic/claude-sonnet-4} arguments here
```

### Model Override (Alias) - NEW

```
/mycommand {model:opus} arguments here
```

Aliases are defined via `/subtask -a`. See `cli-interface.md`.

### Agent Override

```
/mycommand {agent:explore} arguments here
```

### Combined

```
/mycommand {model:openai/gpt-4o && agent:build} arguments
```

### In Return Chains

```yaml
return:
  - /research {model:openai/gpt-4o}
  - /implement {model:anthropic/claude-sonnet-4 && agent:build}
```

### In Inline Subtasks

```
/subtask {model:openai/gpt-4o && agent:explore} find auth patterns
```

---

## Model Format

Model IDs follow OpenCode's format:

```
provider/model-name

Examples:
- openai/gpt-4o
- anthropic/claude-sonnet-4
- anthropic/claude-opus-4
- github-copilot/claude-sonnet-4.5
```

### Model Aliases (NEW)

Users can define aliases for convenience:

```
/subtask -a opus github-copilot/claude-opus-4.5
/subtask -a sonnet anthropic/claude-sonnet-4
/subtask -a gpt openai/gpt-4o
```

Then use in any override:

```
{model:opus}
```

Aliases work in:

- Inline overrides: `{model:opus}`
- Frontmatter: `model: opus`
- Return chains: `/cmd {model:opus}`

---

## Agent Names

Standard OpenCode agents:

- `build` - The default agent for coding tasks
- `explore` - Fast agent for codebase exploration
- `general` - General-purpose agent

---

## How Overrides Are Applied

### For Commands (via frontmatter model/agent)

Commands can specify model/agent in frontmatter:

```yaml
model: openai/gpt-4o
agent: build
```

Inline overrides should OVERRIDE these settings.

### For Subtasks (Task tool)

The Task tool input includes:

```typescript
input: {
  subagent_type: "build" | "explore" | "general",
  // model is NOT a direct input to Task tool
}
```

Model override for subtasks requires a different approach.

---

## Implementation (CONFIRMED)

**Model override is officially supported** via the `SubtaskPart.model` field.

### The Mechanism

In `command.execute.before`, when building a SubtaskPart (for `/subtask` or any `subtask: true` command):

```typescript
// Resolve alias first (NEW)
const resolvedModel = resolveModelAlias(modelString);

// Parse model from resolved value
const [providerID, modelID] = resolvedModel.split("/");

// Set on the subtask part
const subtaskPart = {
  type: "subtask",
  agent: agentOverride || "build",
  description: "inline subtask",
  prompt: resolvedPrompt,
  model: {
    providerID, // e.g., "openai"
    modelID, // e.g., "gpt-4o"
  },
};

output.parts = [subtaskPart];
```

### Alias Resolution

```typescript
function resolveModelAlias(model: string): string {
  const aliases = getPluginConfig().model_aliases ?? {};
  return aliases[model] ?? model; // Return alias value or original
}
```

### How OpenCode Uses It

From `session/prompt.ts`:

```typescript
// When subtask executes:
const taskModel = task.model
  ? await Provider.getModel(task.model.providerID, task.model.modelID)
  : model; // fallback to parent model
```

### No Pending State Needed for Model

Since we set `part.model` directly on the SubtaskPart in `command.execute.before`, we don't need `pendingModelOverride` state. The model travels with the part itself.

**Simplification**: Remove `pendingModelOverride` from state design. Model is applied inline.

---

## Agent Override Application

Agent is easier - it's directly in Task tool input:

```typescript
"tool.execute.before": async (input, output) => {
  if (input.tool === "task") {
    const agentOverride = consumeAgentOverride(parentSessionID);
    if (agentOverride) {
      output.args.subagent_type = agentOverride;
    }
  }
}
```

---

## Parsing

### Override Detection

```typescript
const overridePattern = /^\{([^}]+)\}\s*/;

function parseOverrides(text: string): {
  model?: string;
  agent?: string;
  remainder: string;
} {
  const match = text.match(overridePattern);
  if (!match) return { remainder: text };

  const overrides = parseOverrideString(match[1]); // Parse "model:x && agent:y"
  return {
    model: overrides.model,
    agent: overrides.agent,
    remainder: text.slice(match[0].length),
  };
}
```

### Override String Parsing

```typescript
// "model:openai/gpt-4o && agent:build"
function parseOverrideString(str: string): Record<string, string> {
  const parts = str.split(/\s*&&\s*/);
  const result: Record<string, string> = {};

  for (const part of parts) {
    const [key, ...valueParts] = part.split(":");
    result[key.trim()] = valueParts.join(":").trim();
  }

  return result;
}
```

---

## State Management

### No Pending State Needed

Model and agent are applied directly to SubtaskPart in command.before.
No Maps required for overrides.

### Alias Storage

Aliases stored in config file, not runtime state:

```jsonc
// ~/.config/opencode/subtask2.jsonc
{
  "model_aliases": {
    "opus": "github-copilot/claude-opus-4.5",
  },
}
```

---

## Priority

From highest to lowest:

1. Inline override: `/cmd {model:x}`
2. Frontmatter: `model: y` in command file
3. OpenCode default

---

## Edge Cases

### Invalid Model ID

```
/cmd {model:invalid}
```

Pass through to OpenCode, let it handle the error.

### Invalid Agent

```
/cmd {agent:nonexistent}
```

Pass through to OpenCode, let it handle the error.

### Override on Non-Subtask Command

```
/regular-cmd {model:x} args
```

The model override has no effect (no Task tool created).
Could log a warning.

### Multiple Overrides in Chain

```yaml
return:
  - /step1 {model:a}
  - /step2 {model:b}
```

Each command gets its own override, no conflicts.

---

## Test Cases

1. **Model override (full)**: `/cmd {model:openai/gpt-4o}` → Uses gpt-4o
2. **Model override (alias)**: `/cmd {model:opus}` → Resolves to full ID (NEW)
3. **Agent override**: `/cmd {agent:explore}` → Uses explore agent
4. **Combined**: Both model and agent applied
5. **In return**: Override in return chain works
6. **Priority**: Inline > frontmatter > default
7. **Invalid**: Graceful handling of invalid IDs
8. **Non-subtask**: No crash, possible warning
9. **Unknown alias**: Passed through as-is, OC handles error

---

## Implementation Checklist

- [ ] Parse `{...}` override syntax
- [ ] Extract model and agent values
- [ ] Resolve model aliases before splitting provider/model
- [ ] Apply model directly to SubtaskPart.model in command.before
- [ ] Apply agent to SubtaskPart.agent in command.before
- [ ] Handle priority correctly (inline > frontmatter > default)
- [ ] Graceful error handling for invalid model/agent
