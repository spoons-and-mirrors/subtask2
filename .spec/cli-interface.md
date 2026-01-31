# Feature Spec: `/subtask` CLI Interface

## Summary

The `/subtask` command serves dual purposes:

1. **Execution mode**: Run inline subtasks with overrides
2. **Management mode**: Help display and model alias management

---

## CLI Interface

### Help (No Arguments)

```
/subtask
```

Shows help menu and current configuration via an `ignored` message (visible to user, invisible to LLM).

**Output:**

```
Subtask2 - Inline Subtask Command

Usage:
  /subtask {overrides} prompt     Run inline subtask
  /subtask                        Show this help
  /subtask -a alias model         Create model alias
  /subtask -a                     List model aliases
  /subtask -a alias -d            Delete model alias

Overrides:
  {model:provider/model}    Override model (or use alias)
  {agent:name}              Override agent (build, explore, general)
  {return:prompt}           Single return after completion
  {as:name}                 Capture result as $RESULT[name]

Examples:
  /subtask {model:openai/gpt-4o} analyze this code
  /subtask {model:opus && agent:explore} find auth patterns
  /subtask {as:analysis && return:summarize} deep dive on auth

Model Aliases:
  opus → github-copilot/claude-opus-4.5
  sonnet → anthropic/claude-sonnet-4
  (user-defined aliases shown here)
```

### Model Alias Management

#### Create/Update Alias

```
/subtask -a opus github-copilot/claude-opus-4.5
```

Creates alias `opus` → `github-copilot/claude-opus-4.5`

Now users can do:

```
/subtask {model:opus} prompt
```

Or in frontmatter:

```yaml
model: opus
```

#### List Aliases

```
/subtask -a
```

Shows all configured aliases.

#### Delete Alias

```
/subtask -a opus -d
```

Deletes the `opus` alias.

---

## Execution Mode

When arguments don't start with `-`:

```
/subtask {model:opus && agent:explore} analyze the auth flow
```

Parses overrides, builds SubtaskPart, executes as subtask.

---

## Implementation

### Ignored Messages Pattern

From the `aa` plugin, to show messages to user without LLM seeing them:

```typescript
await client.session.prompt({
  path: { id: sessionID },
  body: {
    noReply: true,
    parts: [{ type: "text", text: message, ignored: true }],
  },
});
```

- `ignored: true` - User sees it, LLM doesn't
- `noReply: true` - Don't trigger LLM response

### Command Stopping

After handling help/alias commands, throw to stop further processing:

```typescript
throw new Error("__SUBTASK_COMMAND_HANDLED__");
```

This prevents OpenCode from trying to execute the command normally.

---

## Alias Storage

Aliases stored in plugin config file:

```jsonc
// ~/.config/opencode/subtask2.jsonc
{
  "replace_generic": true,
  "generic_return": "...",
  "model_aliases": {
    "opus": "github-copilot/claude-opus-4.5",
    "sonnet": "anthropic/claude-sonnet-4",
    "gpt": "openai/gpt-4o",
  },
}
```

### Alias Resolution

In override parsing, before splitting `model:x`:

```typescript
function resolveModelAlias(model: string): string {
  const aliases = getPluginConfig().model_aliases ?? {};
  return aliases[model] ?? model;
}
```

Applied:

1. In inline override parsing: `{model:opus}` → resolves to full ID
2. In frontmatter parsing: `model: opus` → resolves to full ID

---

## State

### Config Extension

```typescript
interface PluginConfig {
  replace_generic: boolean;
  generic_return?: string;
  model_aliases: Record<string, string>; // NEW
}
```

### No Runtime State Needed

Aliases are persisted to config file, loaded on demand.

---

## Test Cases

1. **Help**: `/subtask` → Shows help with aliases
2. **Create alias**: `/subtask -a opus github-copilot/claude-opus-4.5` → Saved
3. **List aliases**: `/subtask -a` → Shows all
4. **Delete alias**: `/subtask -a opus -d` → Removed
5. **Use alias inline**: `/subtask {model:opus}` → Resolves correctly
6. **Use alias frontmatter**: `model: opus` → Resolves correctly
7. **Invalid alias**: `{model:nonexistent}` → Passes through as-is (let OC error)
8. **Override alias**: User can still use full model ID

---

## Implementation Checklist

- [ ] Detect no-args case, show help
- [ ] Parse `-a` flag for alias management
- [ ] Implement alias CRUD (create, read, delete)
- [ ] Persist aliases to config file
- [ ] Implement alias resolution in model parsing
- [ ] Apply resolution in both override and frontmatter parsing
- [ ] Use `ignored: true` for help/status messages
- [ ] Throw to stop command processing after management actions
