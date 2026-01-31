# Feature Spec: Parallel Execution

## Status: PENDING

This feature is pending the merge of [PR #6478](https://github.com/sst/opencode/pull/6478) into OpenCode. Once merged, parallel execution will be available.

---

## Summary

The `parallel:` frontmatter option allows running multiple subtasks concurrently. All parallel subtasks run simultaneously, and the main session waits for ALL to complete before processing the `return:` chain.

---

## Syntax

### Basic Parallel

```yaml
parallel:
  - /plan-gemini
  - /plan-opus
return: Compare both plans
```

### Parallel with Arguments

```yaml
parallel:
  - command: research-docs
    arguments: authentication flow
  - command: research-codebase
    arguments: auth middleware
```

### Inline Syntax

```yaml
parallel: /security-review, /perf-review
```

### With Result Capture

```yaml
parallel:
  - /plan {as:plan-a}
  - /plan {model:openai/gpt-4o && as:plan-b}
return: Compare $RESULT[plan-a] vs $RESULT[plan-b]
```

---

## Pipe Arguments (`||`)

Different arguments can be passed to parallel commands using `||` separators:

```
/mycommand main args || parallel1 args || parallel2 args
```

Mapping order:

1. First segment → main command
2. Second segment → first parallel
3. Third segment → second parallel
4. etc.

---

## Execution Flow

```
1. command.execute.before parses parallel: config

2. Main command starts

3. All parallel commands start simultaneously
   ├── Each becomes a subtask
   ├── Each may have its own overrides
   └── Each may capture results with {as:}

4. Wait for ALL to complete
   └── OpenCode handles this with Task tool concurrency

5. return: chain fires for main command
   └── All $RESULT references now available
```

---

## Constraints

- Parallel commands are forced into subtask mode regardless of their own `subtask:` setting
- Parallel commands' own `return:` chains are ignored (only main command's return applies)
- Nested parallels are flattened with maximum depth of 5

---

## State Requirements

### Parallel Tracking

```typescript
const pendingParallels = new Map<
  sessionID,
  {
    commands: string[];
    completed: Set<string>;
    results: Map<string, string>;
  }
>();
```

### Completion Detection

Need to track when ALL parallels complete before firing main return.

---

## Implementation Notes

This feature requires OpenCode's ability to:

1. Launch multiple Task tools from a single message
2. Properly track their completion
3. Allow continuation after all complete

The PR adds these capabilities. Without it, parallel execution is not possible.

---

## Test Cases (Post-PR)

1. **Basic parallel**: Two commands run concurrently
2. **With capture**: Each parallel captures result
3. **With pipe args**: Each gets different arguments
4. **Nested**: Parallel within parallel → flattened
5. **Mixed**: Some parallels with overrides, some without
6. **Completion**: Return fires only after ALL complete

---

## Implementation Checklist

- [ ] Wait for PR #6478 merge
- [ ] Parse parallel: syntax (array, inline, object form)
- [ ] Parse pipe arguments ||
- [ ] Build multiple Task tool calls
- [ ] Track parallel completion
- [ ] Handle result capture per parallel
- [ ] Fire return after all complete
