# Feature Spec: Inline Subtask (`/subtask`)

## Summary

The `/subtask` command allows users to spawn ad-hoc subtasks directly from the chat input or within return chains, without creating a command file. It supports inline overrides for model, agent, and a single return.

Additionally, `/subtask` provides a CLI interface for help and model alias management.

---

## CLI Interface

See `cli-interface.md` for full details.

### Quick Reference

```
/subtask                          Show help menu
/subtask -a                       List model aliases
/subtask -a opus provider/model   Create alias
/subtask -a opus -d               Delete alias
/subtask {overrides} prompt       Execute subtask
```

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

### With Model Alias (NEW)

```
/subtask {model:opus} analyze this code
```

Aliases are resolved before model parsing. See `cli-interface.md`.

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
| `model:alias`             | Override using model alias (NEW)      |
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
   ├── Check for CLI commands (no args, -a flag)
   │   └── If CLI: show help/manage aliases, throw to stop
   ├── Parse {model:x} overrides from arguments
   ├── Resolve model aliases (NEW)
   ├── Extract prompt text
   ├── Build SubtaskPart with:
   │   ├── model override applied
   │   ├── prompt as description
   │   └── agent override if specified
   └── Set output.parts = [subtaskPart]

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

When `/subtask` is intercepted, we build a SubtaskPart directly:

```typescript
// Resolve alias first
const resolvedModel = resolveModelAlias(modelOverride);
const [providerID, modelID] = resolvedModel?.split("/") ?? [];

const subtaskPart = {
  type: "subtask",
  agent: agentOverride || "build",
  description: "inline subtask",
  prompt: resolvedPrompt, // With $TURN resolved
  // Model is set directly on the part (no pending state needed)
  ...(resolvedModel && {
    model: { providerID, modelID },
  }),
};

output.parts = [subtaskPart];
```

This is cleaner than building a "tool-invocation" part. OpenCode handles SubtaskPart natively.

---

## Model/Agent Override Application

**CONFIRMED**: Model override is natively supported via `SubtaskPart.model`.

### Model Override

Set directly on the SubtaskPart:

```typescript
part.model = { providerID: "openai", modelID: "gpt-4o" };
```

### Agent Override

Set directly on the SubtaskPart:

```typescript
part.agent = "explore"; // or "build", "general"
```

No pending state needed. Both are applied inline in `command.execute.before`.

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

1. **Help menu**: `/subtask` → Shows help (NEW)
2. **Alias management**: `/subtask -a opus model` → Creates alias (NEW)
3. **Basic subtask**: `/subtask prompt` → Runs as subtask
4. **Model override**: `/subtask {model:openai/gpt-4o} prompt` → Uses model
5. **Model alias**: `/subtask {model:opus} prompt` → Resolves alias (NEW)
6. **Agent override**: `/subtask {agent:explore} prompt` → Uses explore agent
7. **Combined**: `/subtask {model:x && agent:y} prompt` → Both applied
8. **With return**: `/subtask {return:next} prompt` → Return fires after
9. **With capture**: `/subtask {as:res} prompt` → Result captured
10. **In return chain**: Used as command return → Works normally
11. **Empty prompt**: Error handling
12. **Invalid syntax**: Graceful degradation

---

## Implementation Checklist

- [ ] Register `/subtask` via config hook
- [ ] Handle CLI interface (help, aliases) - see `cli-interface.md`
- [ ] Parse override syntax `{key:value && ...}`
- [ ] Resolve model aliases before parsing
- [ ] Extract prompt text after `}`
- [ ] Build SubtaskPart (not tool-invocation)
- [ ] Apply model/agent directly to SubtaskPart
- [ ] Handle single `return:` override
- [ ] Handle `as:` capture registration
- [ ] Resolve $TURN in prompt
- [ ] Error handling for invalid syntax
- [ ] Throw to stop command after CLI actions
