# Feature Spec: Inline Subtask (`/subtask`)

## Summary

The `/subtask` command allows users to spawn ad-hoc subtasks directly from the chat input or within return chains, without creating a command file. It supports inline overrides for model, agent, and a single return.

---

## Syntax

### Basic Usage

```
/subtask tell me a joke
```

Runs "tell me a joke" as a subtask with default model/agent.

### With Model Override

```
/subtask {model:openai/gpt-4o} analyze this code
```

### With Agent Override

```
/subtask {agent:build} implement the feature
```

### With Return

```
/subtask {return:validate the output} implement the auth system
```

### Combined Overrides

```
/subtask {model:anthropic/claude-sonnet-4 && agent:build && return:test it} implement auth
```

---

## Override Parsing

### Syntax Rules

- Overrides enclosed in `{...}` immediately after `/subtask`
- Multiple overrides separated by `&&`
- Prompt text follows after the closing `}`
- Space between `/subtask` and `{` is required for instant execution

### Supported Overrides (v2)

| Override                  | Purpose                               |
| ------------------------- | ------------------------------------- |
| `model:provider/model-id` | Override LLM model                    |
| `agent:agent-name`        | Override agent                        |
| `return:prompt`           | Single return prompt after completion |
| `as:name`                 | Capture result with name for $RESULT  |

### Deferred Overrides

| Override          | Status                     |
| ----------------- | -------------------------- |
| `loop:n`          | Deferred to future version |
| `until:condition` | Deferred to future version |
| `parallel:...`    | Pending OC PR merge        |

---

## Registration

The `/subtask` command is registered via the `config` hook:

```typescript
config: async input => {
  input.commands.subtask = {
    description: "Run an inline subtask with optional overrides",
    // This makes /subtask a valid command
  };
};
```

This allows OpenCode to recognize `/subtask` as a command and route it through `command.execute.before`.

---

## Execution Flow

```
1. User types: /subtask {model:x} prompt

2. command.execute.before fires
   ├── Detect command is "subtask"
   ├── Parse {model:x} overrides from arguments
   ├── Extract prompt text
   ├── Build Task tool call part with:
   │   ├── model override applied
   │   ├── prompt as description
   │   └── subtask: true equivalent
   └── Set output.parts = [taskPart]

3. OpenCode executes the Task tool
   └── Creates new session for subtask

4. tool.execute.before fires (for Task tool)
   ├── Map subtaskSession → parentSession
   └── Register result capture if {as:name}

5. Subtask runs, LLM responds

6. tool.execute.after fires
   ├── Capture result if registered
   └── Set pendingReturns = inline return (if specified)

7. Normal return chain processing continues
```

---

## Output Part Structure

When `/subtask` is intercepted, we build a Task tool call:

```typescript
const taskPart = {
  type: "tool-invocation",
  tool: {
    type: "tool",
    id: "task",
    name: "task",
  },
  input: {
    description: "inline subtask",
    prompt: resolvedPrompt, // With $TURN resolved
    subagent_type: agentOverride || "build",
  },
  state: {
    status: "pending",
  },
};
```

If model override is specified, we also set `pendingModelOverride[sessionID]` which is consumed in `tool.execute.before`.

---

## Model/Agent Override Application

### How OpenCode Handles Model

Looking at the Task tool, model selection happens at the subtask session level. The hook approach:

1. In `command.execute.before`: Store `pendingModelOverride[sessionID] = model`
2. In subtask's `chat.params` or `chat.message` hook: Apply override

**Alternative**: If Task tool accepts model in input, pass it directly.

### Research Needed

- Does Task tool `input` support a `model` field?
- If not, how to override model for the spawned subtask session?

---

## Return Handling

Inline subtasks support ONE return:

```
/subtask {return:validate output} implement feature
```

- Return is stored in `pendingReturns[subtaskSessionID]`
- Processed normally via messages.transform when subtask completes
- No nested returns (no `return:a || b || c` syntax in v2)

---

## Result Capture

```
/subtask {as:my-result} generate some data
```

- Result capture registered in tool.execute.before
- Result captured in tool.execute.after
- Available as `$RESULT[my-result]` in parent session

---

## Edge Cases

### Empty Prompt

```
/subtask {model:x}
```

Error or warning: "Missing prompt for inline subtask"

### Invalid Override Syntax

```
/subtask {model:} prompt
```

Parse error handling: Log warning, use defaults

### /subtask in Return Chain

```yaml
return:
  - /subtask {model:openai/gpt-4o} analyze this
  - Compare with the analysis above
```

Works like any command return, with inline overrides parsed.

### Recursive /subtask

```yaml
return: /subtask {return:/subtask {return:done} step2} step1
```

Technically possible but not recommended. Single return per inline limits depth.

---

## OpenCode SDK Usage

### Reading Command Info

```typescript
// command.execute.before input
input.command; // "subtask"
input.arguments; // "{model:x} prompt text"
input.sessionID; // current session
```

### Building Tool Invocation

```typescript
output.parts = [
  {
    type: "tool-invocation",
    tool: { type: "tool", id: "task", name: "task" },
    input: { prompt, description, subagent_type },
    state: { status: "pending" },
  },
];
```

---

## Test Cases

1. **Basic subtask**: `/subtask prompt` → Runs as subtask
2. **Model override**: `/subtask {model:x} prompt` → Uses model x
3. **Agent override**: `/subtask {agent:explore} prompt` → Uses explore agent
4. **Combined**: `/subtask {model:x && agent:y} prompt` → Both applied
5. **With return**: `/subtask {return:next} prompt` → Return fires after
6. **With capture**: `/subtask {as:res} prompt` → Result captured
7. **In return chain**: Used as command return → Works normally
8. **Empty prompt**: Error handling
9. **Invalid syntax**: Graceful degradation

---

## Implementation Checklist

- [ ] Register `/subtask` via config hook
- [ ] Parse override syntax `{key:value && ...}`
- [ ] Extract prompt text after `}`
- [ ] Build Task tool invocation part
- [ ] Store model/agent overrides for application
- [ ] Handle single `return:` override
- [ ] Handle `as:` capture registration
- [ ] Resolve $TURN in prompt
- [ ] Error handling for invalid syntax
