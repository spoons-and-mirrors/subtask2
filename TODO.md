# Subtask2 Plugin TODO

## High Priority

### Memory Cleanup for Session State Maps

**Issue**: The plugin stores session state in multiple Maps (`src/core/state.ts`):

- `returnState`, `pendingReturns`, `pipedArgsQueue`, `sessionMainCommand`
- `subtaskResults`, `pendingResultCapture`, `deferredReturnPrompt`
- And many more...

**Problem**: There's no cleanup mechanism when sessions end. For long-running OpenCode instances, this could leak memory over time.

**Solution**:

- Add a `session.end` or `session.close` event handler
- Clear all Maps for the ending sessionID
- Or implement a TTL/LRU cache strategy

**Priority**: Medium-High (not critical for beta, but should be addressed before 1.0)

---

- [] auto mode refactor
  `/subtask --auto prompt goes here` would generate a subtask2 workflow based on the user query, using question tool if available to define returns, parallels and maybe more?

- [] model aliases
  introduce alias for model overrides, e.g. `{model:opus}` instead of `{model:github-copilot/claude-opus-4.5}`

- [] use -- syntax for inline overrides?
