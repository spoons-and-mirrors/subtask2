# Feature Spec: Return Chaining

## Summary

The `return:` frontmatter option allows commands to specify what happens after the subtask completes. Returns can be prompts (text the LLM should process) or commands (other `/commands` to execute).

---

## Syntax

### Single Return (Prompt)

```yaml
return: Look again and challenge the findings.
```

### Single Return (Command)

```yaml
return: /review-code
```

### Multiple Returns (Array)

```yaml
return:
  - Implement the fix
  - Run the tests
  - /commit
```

Returns execute in order: first prompt is injected, LLM responds, next return fires, etc.

---

## Behavior

### What "return" Replaces

When a `subtask: true` command completes, OpenCode injects a synthetic user message:

> "Summarize the task tool output above and continue with your task."

**Without subtask2**: The LLM sees this message and responds with a summary.

**With subtask2**: We intercept this message in `messages.transform` and replace its text with:

1. The first `return:` item (if defined)
2. The plugin's `generic_return` config (if no return defined)
3. A sensible default prompt (fallback)

The synthetic message remains synthetic (we don't fight OC), but its content changes.

---

## Execution Flow

### First Return (messages.transform)

```
1. tool.execute.after fires
   └── pendingReturns[sessionID] = returnState[0]  // First return
   └── returnState[sessionID] = remaining returns

2. OpenCode adds synthetic "Summarize..." message

3. experimental.chat.messages.transform fires
   └── Find message with "Summarize the task tool output..."
   └── Get pendingReturns[sessionID]
   └── If return is prompt: Replace text with prompt
   └── If return is /command: Replace text with "", execute command
   └── Delete pendingReturns[sessionID]
```

### Remaining Returns (text.complete)

```
4. LLM responds to first return prompt

5. experimental.text.complete fires
   └── Check returnState[sessionID]
   └── If has items: shift next return
       └── If prompt: Inject via client.session.prompt({ noReply: true })
       └── If /command: Execute via client.session.command()
   └── If empty: Cleanup session state
```

---

## Return Types

### Prompt Returns

Any return that doesn't start with `/` is a prompt:

```yaml
return: Validate the implementation against the requirements.
```

- Text replaces the synthetic message
- LLM sees this as a user message and responds

### Command Returns

Returns starting with `/` are commands:

```yaml
return: /run-tests
```

- Synthetic message text becomes empty string
- Command executes immediately
- Command may have its own `return:` chain (recursive)

---

## State Management

### State Maps Used

| Map               | Set By           | Consumed By        |
| ----------------- | ---------------- | ------------------ |
| `pendingReturns`  | tool.after       | messages.transform |
| `returnState`     | command.before   | text.complete      |
| `executedReturns` | return execution | dedup check        |

### Cleanup

When returnState is empty after processing:

1. Delete all session state
2. Prevent duplicate execution via executedReturns Set

---

## Edge Cases

### No Return Defined

```yaml
subtask: true
# No return: key
```

Behavior: Replace "Summarize..." with `generic_return` from config (or plugin default).

### Empty Return Array

```yaml
return: []
```

Behavior: Same as no return defined.

### Command Return with Arguments

```yaml
return: /analyze deep-dive on the auth module
```

The text after the command name is passed as arguments.

### Command Return with Overrides

```yaml
return: /analyze {model:anthropic/claude-sonnet-4} auth module
```

Command inherits any inline overrides. Parsed by same override logic.

### Non-Subtask Commands

Commands without `subtask: true` don't have the "Summarize..." message.
For these, `return:` is stored in `pendingNonSubtaskReturns` and fired in text.complete.

---

## Config Options

```jsonc
// ~/.config/opencode/subtask2.jsonc
{
  // Replace OC's generic when no return specified
  "replace_generic": true, // default: true

  // Custom default (optional)
  "generic_return": "Review, challenge and verify the output above.",
}
```

---

## OpenCode SDK Usage

### Injecting Prompt Returns

```typescript
await client.session.prompt({
  sessionID,
  parts: [{ type: "text", text: returnPrompt }],
  // Note: noReply is NOT used for normal prompts
  // We want the LLM to respond
});
```

### Executing Command Returns

```typescript
await client.session.command({
  sessionID,
  command: commandName,
  arguments: args,
});
```

---

## Test Cases

1. **Single prompt return**: Command with `return: "test"` → LLM sees "test"
2. **Single command return**: `return: /other` → /other executes
3. **Multiple returns**: `return: [a, b, c]` → a, b, c fire in order
4. **Mixed returns**: `return: [/cmd, prompt, /cmd2]` → proper interleaving
5. **No return**: Replace with generic_return
6. **Nested returns**: Command in return has its own return chain
7. **Non-subtask command**: Returns still work, different hook path

---

## Implementation Checklist

- [ ] Parse `return:` from frontmatter (string or array)
- [ ] Store first return in pendingReturns, rest in returnState
- [ ] Replace synthetic message text in messages.transform
- [ ] Fire remaining returns in text.complete
- [ ] Handle both prompt and command returns
- [ ] Implement dedup with executedReturns
- [ ] Implement session cleanup
- [ ] Support override syntax in command returns
