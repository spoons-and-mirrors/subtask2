# Deferred Features

These features are **not in scope** for the v2 refactor. They will be considered for future versions after the core functionality is stable and tested.

---

## 1. Loop (`loop:`, `until:`)

### What It Does

Repeat a command a fixed number of times or until a condition is met.

**Fixed count:**

```
/fix-tests {loop:5}
```

**Conditional:**

```yaml
loop:
  max: 10
  until: "all tests pass"
```

### Why Deferred

- Adds significant cross-session state complexity
- Requires evaluation prompts and LLM decision parsing
- Current implementation had race conditions
- Core return chaining needs to be solid first

### Future Approach

When implementing:

1. Keep loop state simple (iteration count only)
2. Use session.idle for evaluation (if needed)
3. OR use a purely text.complete based approach
4. Consider whether `until:` is truly needed vs just fixed count

---

## 2. Auto Mode (`subtask2: auto`)

### What It Does

Automatically parse a prompt into a structured workflow:

```yaml
subtask2: auto
---
First research the codebase, then implement the feature, finally run tests.
```

Becomes:

```yaml
return:
  - /research the codebase
  - /implement the feature
  - /run-tests
```

### Why Deferred

- Highly experimental POC
- Adds complexity to parsing
- LLM-dependent behavior
- Core features need to work first

### Future Approach

- Implement as a preprocessing step before normal parsing
- Make it optional and clearly labeled as experimental

---

## 3. Nested Inline Returns

### What It Does

Allow multiple returns within inline subtasks:

```
/subtask {return:step1 || step2 || step3} initial prompt
```

### Why Deferred

- Requires returnStack (stack of arrays)
- Adds complexity for limited use case
- Users can chain returns in command files instead
- Single return per inline subtask is sufficient

### Future Consideration

- May add if strong user demand
- Would require careful stack management
- Clear limits on nesting depth

---

## 4. Visible Returns

### What It Does

Make return prompts appear as real user messages in the TUI instead of being invisible orchestration.

### Why Deferred

- Requires hacking OpenCode's internal HTTP client
- Uses undocumented `client.client.patch` API
- Modifies database directly (fragile)
- Breaks on OpenCode updates

### Alternative Approach (If Revisited)

Instead of making synthetic messages visible:

1. Accept that orchestration is invisible
2. OR inject a visible "ignored" message for user awareness
3. OR work with OpenCode team to add official support

---

## 5. Prompt-Based Session Mapping

### What It Was

v0.3.x used `pendingParentByPrompt` to map subtasks to parents by prompt content.

### Why Removed

- Fragile: prompt modifications break lookup
- Race-prone: duplicate prompts collide
- Unnecessary: we can track by subtask session ID instead

### v2 Approach

- Track by subtask session ID only
- Set in tool.execute.before when Task tool is invoked
- Consume in tool.execute.after using output.state.sessionID

---

## Priority Order (When to Add)

If/when these are implemented:

1. **Loop (fixed count only)** - Most requested, simplest
2. **Loop (with until:)** - After fixed count works
3. **Nested inline returns** - If user demand exists
4. **Auto mode** - Experimental, low priority
5. **Visible returns** - Requires OC changes, lowest priority

---

## Notes for Future Implementation

### Loop Architectural Notes

- Consider: is session.idle actually needed?
- Could we detect loop completion via tool.execute.after?
- Keep iteration state minimal: just `{ current: number, max: number }`

### Auto Mode Notes

- Could be a separate plugin entirely
- Or a preprocessing hook before main parsing
- Would benefit from structured output parsing

### Visible Returns Notes

- Would need OpenCode PR to add official support
- OR accept invisible orchestration as the design
- User feedback will determine if this is actually needed
