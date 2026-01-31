# Feature Spec: Result Capture (`{as:}` and `$RESULT`)

## Summary

Result capture allows naming subtask outputs and referencing them later. When a subtask completes, its output can be captured with `{as:name}` and later referenced via `$RESULT[name]` in subsequent prompts or returns.

---

## Syntax

### Capture with `{as:name}`

```yaml
return:
  - /research {as:findings} analyze the codebase
  - Based on $RESULT[findings], implement the feature
```

### In Inline Subtasks

```
/subtask {as:analysis && model:openai/gpt-4o} analyze this code
```

### In Parallel (when available)

```yaml
parallel:
  - /plan {as:plan-a}
  - /plan {model:openai/gpt-4o && as:plan-b}
return: Compare $RESULT[plan-a] vs $RESULT[plan-b]
```

---

## What Gets Captured

When a subtask (Task tool) completes, OpenCode returns the task's output. This is typically the **last text part** from the subtask session's final assistant message.

**Captured content**:

- The string value of `output.state.output` from `tool.execute.after`
- This is what OpenCode considers the "result" of the Task tool

---

## Storage Model

```typescript
// State structure
const subtaskResults = new Map<parentSessionID, Map<name, result>>();

// Registration (before subtask runs)
const pendingResultCapture = new Map<
  subtaskSessionID,
  {
    parentSessionID: string;
    name: string;
  }
>();
```

Results are scoped to the **parent session** so they can be referenced in that session's return chain.

---

## Execution Flow

```
1. Command with {as:name} parsed
   └── In command.execute.before or override parsing

2. tool.execute.before fires (for Task tool)
   └── pendingResultCapture[subtaskSessionID] = { parentSessionID, name }

3. Subtask runs and completes

4. tool.execute.after fires
   ├── Check pendingResultCapture[subtaskSessionID]
   ├── Extract result from output.state.output
   ├── Store: subtaskResults[parentSessionID][name] = result
   └── Delete pendingResultCapture[subtaskSessionID]

5. Return prompt processing
   ├── Prompt contains $RESULT[name]
   ├── Resolve: subtaskResults[parentSessionID][name]
   └── Replace $RESULT[name] with captured text
```

---

## Resolution

### $RESULT Syntax

```
$RESULT[name]       // Reference captured result by name
$RESULT[plan-a]     // Hyphenated names allowed
$RESULT[my_result]  // Underscores allowed
```

### Resolution Context

- Happens during return prompt processing
- Before prompt is sent to LLM
- In same session as the capture's parent

### Resolution Function

```typescript
function resolveResults(text: string, sessionID: string): string {
  const results = subtaskResults.get(sessionID);
  if (!results) return text;

  return text.replace(/\$RESULT\[([^\]]+)\]/g, (match, name) => {
    return results.get(name) ?? `[Result '${name}' not found]`;
  });
}
```

---

## Scope and Lifetime

### Scope

- Results are scoped to parent session
- Not accessible from sibling subtasks (unless captured to shared parent)
- Not accessible after session ends

### Lifetime

- Created when subtask completes (tool.execute.after)
- Available until parent session cleanup
- Cleaned up with other session state

---

## Edge Cases

### Missing Result

```yaml
return: Use $RESULT[nonexistent] here
```

Resolution: Replace with `[Result 'nonexistent' not found]`
LLM sees the error message and can handle appropriately.

### Duplicate Names

```yaml
return:
  - /step1 {as:data}
  - /step2 {as:data}
  - Use $RESULT[data]
```

Later capture overwrites earlier. Last value wins.

### No Output from Subtask

If subtask has no output (edge case), capture empty string.

### Result in Command Arguments

```yaml
return: /analyze {model:x} $RESULT[data]
```

$RESULT is resolved before command execution.

---

## State Management

### Single Registration Path

Unlike v0.3.x which had 3+ registration methods, v2 uses ONE:

- Register by subtaskSessionID in tool.execute.before
- Consume by subtaskSessionID in tool.execute.after

No prompt-based registration (fragile, race-prone).

### Session ID Availability

In tool.execute.before:

```typescript
input.sessionID; // Parent session (where Task tool was called)
// Subtask session ID comes from Task tool's state after execution
```

In tool.execute.after:

```typescript
input.sessionID; // Still parent session
output.state.sessionID; // Subtask session ID
```

We need to map: subtaskSessionID → parentSessionID.

---

## OpenCode SDK Usage

### Accessing Task Output

```typescript
// tool.execute.after
const taskOutput = output.state?.output; // The result text
const subtaskSessionID = output.state?.sessionID;
```

### No Additional SDK Calls Needed

Result capture is entirely internal state management.

---

## Test Cases

1. **Basic capture**: `{as:x}` → $RESULT[x] resolves
2. **Multiple captures**: Different names, all accessible
3. **Overwrite**: Same name captured twice → last value
4. **Missing**: Unknown name → error message in output
5. **In inline subtask**: `/subtask {as:x}` → Works
6. **In return chain**: Command returns with {as:} → Works
7. **Resolution in prompt**: `$RESULT[x]` replaced
8. **Resolution in command args**: `$RESULT[x]` in args → Resolved

---

## Implementation Checklist

- [ ] Parse `{as:name}` from command/return syntax
- [ ] Store pending capture in tool.execute.before
- [ ] Capture result in tool.execute.after
- [ ] Implement subtaskResults storage (parent-scoped)
- [ ] Implement $RESULT resolution function
- [ ] Apply resolution in return prompt processing
- [ ] Handle missing/error cases gracefully
- [ ] Cleanup results with session state
