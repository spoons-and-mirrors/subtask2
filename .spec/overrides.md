# Feature Spec: Inline Overrides (`{model:}`, `{agent:}`)

## Summary

Inline overrides allow changing the model or agent for any command invocation without modifying the command file. This enables multi-model workflows where different steps use different LLMs.

---

## Syntax

### Model Override

```
/mycommand {model:anthropic/claude-sonnet-4} arguments here
```

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

## Implementation Approaches

### Approach A: Modify chat.params Hook

Register a `chat.params` hook that applies pending overrides:

```typescript
"chat.params": async (input, output) => {
  const override = pendingModelOverride.get(input.sessionID);
  if (override) {
    // Modify output to use override model
    // Need to research exact mechanism
  }
}
```

**Research needed**: How does `chat.params` interact with model selection?

### Approach B: Modify Task Tool Input

If we can intercept in `tool.execute.before`:

```typescript
"tool.execute.before": async (input, output) => {
  if (input.tool === "task") {
    const modelOverride = consumeModelOverride(parentSessionID);
    if (modelOverride) {
      output.args.model = modelOverride; // If Task accepts this
    }
  }
}
```

**Research needed**: Does Task tool accept a model field?

### Approach C: Session-level Model Setting

Check if `client.session.update()` can change the model.

**Research needed**: Can session model be changed after creation?

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

### Pending Override Storage

```typescript
// Set in command.execute.before
pendingModelOverride.set(sessionID, modelID);
pendingAgentOverride.set(sessionID, agentName);

// Consumed in tool.execute.before (when Task tool is called)
const model = consumeModelOverride(sessionID);
const agent = consumeAgentOverride(sessionID);
```

### Cleanup

Overrides are consumed when used. If not used (no Task tool call), cleaned up with session.

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

## OpenCode SDK Research Needed

1. **Task tool model field**: Does `output.args` in `tool.execute.before` for Task tool accept a model field?

2. **chat.params model override**: Can we change the model via this hook for a session?

3. **Session update**: Does `client.session.update()` support model changes?

---

## Test Cases

1. **Model override**: `/cmd {model:x}` → Subtask uses model x
2. **Agent override**: `/cmd {agent:explore}` → Uses explore agent
3. **Combined**: Both model and agent applied
4. **In return**: Override in return chain works
5. **Priority**: Inline > frontmatter > default
6. **Invalid**: Graceful handling of invalid IDs
7. **Non-subtask**: No crash, possible warning

---

## Implementation Checklist

- [ ] Parse `{...}` override syntax
- [ ] Extract model and agent values
- [ ] Store pending overrides (command.before)
- [ ] Research model application mechanism
- [ ] Apply agent override in tool.before
- [ ] Apply model override (pending research)
- [ ] Handle priority correctly
- [ ] Cleanup unused overrides
