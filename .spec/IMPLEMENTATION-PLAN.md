# Implementation Plan: Subtask2 v2 Refactor

## Overview

This plan outlines the phased implementation of the v2 refactor, starting from the current v0.3.5 codebase on the `main` branch. We will rewrite files to align with the v0.2.9 architecture while preserving the modular file structure.

---

## Pre-Implementation: Codebase Preparation

### Step 0: Clean Slate

1. Delete all files in `src/` except directory structure
2. Keep `test/` directory (will update tests later)
3. Keep `.spec/` directory (our source of truth)
4. Keep `package.json`, `tsconfig.json`, `README.md`

---

## Phase 1: Core Infrastructure

**Goal**: Establish the minimal working plugin with state management and hook registration.

### 1.1 State Module (`src/state.ts`)

- Implement all Maps as defined in ARCHITECTURE.md
- Implement getters/setters for each state
- Implement `cleanupSession()` function
- Implement logging utility

**State Maps** (simplified from v0.3.5):

```typescript
callState: Map<string, string>;
sessionMainCommand: Map<string, string>;
pendingReturns: Map<string, string>;
returnState: Map<string, string[]>;
pendingNonSubtaskReturns: Map<string, string[]>;
executedReturns: Set<string>;
subtaskParentSession: Map<string, string>;
pendingResultCapture: Map<string, { parentSessionID: string; name: string }>;
subtaskResults: Map<string, Map<string, string>>;
```

### 1.2 Config Module (`src/config.ts`)

- Load `~/.config/opencode/subtask2.jsonc`
- Define `PluginConfig` interface:
  ```typescript
  interface PluginConfig {
    replace_generic: boolean;
    generic_return?: string;
    model_aliases: Record<string, string>; // NEW: alias → full model ID
  }
  ```
- Provide defaults for `replace_generic`, `generic_return`
- Implement `saveConfig()` for alias persistence

### 1.3 Plugin Entry (`src/plugin.ts` + `src/index.ts`)

- Export `createPlugin` function
- Register all hooks
- Register `/subtask` command via config hook

**Deliverable**: Plugin loads without errors, `/subtask` command recognized.

---

## Phase 2: Parsing Layer

**Goal**: Parse frontmatter, inline overrides, and command syntax.

### 2.1 Frontmatter Parsing (`src/parsing/frontmatter.ts`)

- Parse YAML frontmatter from command templates
- Extract: `return`, `parallel`, `model`, `agent`, `subtask`, `description`
- Handle both string and array `return:`

### 2.2 Override Parsing (`src/parsing/overrides.ts`)

- Parse `{model:x && agent:y && return:z && as:name}` syntax
- Extract model (split to providerID/modelID)
- **Resolve model aliases** before splitting (NEW)
- Extract agent, return, as
- Return remainder text (the actual prompt)

### 2.3 Command Parsing (`src/parsing/commands.ts`)

- Detect if string starts with `/` (is command)
- Extract command name and arguments
- Parse overrides from command strings

**Deliverable**: All parsing functions work, covered by unit tests.

---

## Phase 3: Feature Modules

**Goal**: Implement core feature logic separate from hooks.

### 3.1 Return Execution (`src/features/returns.ts`)

- `executeReturn(returnPrompt, sessionID, client)` function
- Handle prompt returns (inject via SDK)
- Handle command returns (execute via SDK)
- Deduplication via `executedReturns`
- Resolve `$RESULT` references before execution

### 3.2 Result Resolution (`src/features/results.ts`)

- `resolveResults(text, sessionID)` function
- Replace `$RESULT[name]` with captured values
- Handle missing results gracefully

### 3.3 Turn Resolution (`src/features/turns.ts`)

- `resolveTurns(text, sessionID, client)` function
- Fetch session messages
- Build turns array (last text part per agent)
- Replace `$TURN[n]`, `$TURN[:n]`, `$TURN[:a:b:c]`, `$TURN[*]`

**Deliverable**: All feature functions work, covered by unit tests.

---

## Phase 4: Hook Implementation

**Goal**: Wire everything together via OpenCode hooks.

### 4.1 Command Hook (`src/hooks/command.ts`)

```typescript
"command.execute.before": async (input, output) => {
  // 1. If /subtask: parse overrides, build SubtaskPart
  // 2. Else: parse frontmatter from command config
  // 3. Resolve $TURN in prompt
  // 4. Apply model/agent to SubtaskPart directly
  // 5. Store returnState (remaining returns)
  // 6. Store sessionMainCommand
}
```

### 4.2 Tool Hook (`src/hooks/tool.ts`)

```typescript
"tool.execute.before": async (input, output) => {
  // For task tool only:
  // 1. Register subtaskParentSession mapping
  // 2. Register pendingResultCapture if {as:name}
  // 3. Store callState[callID]
}

"tool.execute.after": async (input, output) => {
  // For task tool only:
  // 1. Capture result if pending
  // 2. Shift first return to pendingReturns
  // 3. Mark hasActiveSubtask
}
```

### 4.3 Messages Hook (`src/hooks/messages.ts`)

```typescript
"experimental.chat.messages.transform": async (input, output) => {
  // 1. Find "Summarize the task tool output..." part
  // 2. Get pendingReturns for session
  // 3. If return is prompt: replace text
  // 4. If return is /command: replace with "", execute command
  // 5. If no return: apply generic_return
}
```

### 4.4 Complete Hook (`src/hooks/complete.ts`)

```typescript
"experimental.text.complete": async (input, output) => {
  // 1. Check returnState for session
  // 2. If has items: shift and execute next return
  // 3. If empty: cleanup session state
}
```

### 4.5 Config Hook (`src/plugin.ts`)

```typescript
config: async opencodeConfig => {
  opencodeConfig.command ??= {};
  opencodeConfig.command.subtask = {
    template: "",
    description: "Run inline subtask with overrides. Use /subtask for help.",
  };
};
```

**Deliverable**: Full return chaining works for basic cases.

---

## Phase 5: Inline Subtask

**Goal**: `/subtask` command fully functional with CLI interface.

### 5.1 CLI Interface (NEW)

Handle management commands before execution:

```typescript
// In command.execute.before for /subtask:
const args = input.arguments.trim();

// No args → show help
if (!args) {
  await showHelp(client, input.sessionID);
  throw new Error("__SUBTASK_COMMAND_HANDLED__");
}

// -a flag → alias management
if (args.startsWith("-a")) {
  await handleAliasCommand(args, client, input.sessionID);
  throw new Error("__SUBTASK_COMMAND_HANDLED__");
}

// Otherwise → parse overrides and execute
```

### 5.2 Model Alias Management

- `/subtask -a` → List all aliases (ignored message)
- `/subtask -a name model` → Create/update alias, save to config
- `/subtask -a name -d` → Delete alias

Use `ignored: true` messages for feedback (visible to user, not LLM).

### 5.3 Subtask Command Handler

In `command.execute.before`:

- Detect `input.command === "subtask"`
- Parse overrides from `input.arguments`
- Build SubtaskPart with model/agent applied
- Handle `return:` override (single return only)
- Handle `as:` override (register capture)
- Set `output.parts = [subtaskPart]`

### 5.4 Integration Testing

- `/subtask prompt` → runs as subtask
- `/subtask {model:openai/gpt-4o} prompt` → correct model
- `/subtask {agent:explore} prompt` → correct agent
- `/subtask {return:next step} prompt` → return fires
- `/subtask {as:result} prompt` → result captured
- `/subtask` → shows help menu (NEW)
- `/subtask -a opus github-copilot/claude-opus-4.5` → creates alias (NEW)
- `/subtask {model:opus} prompt` → alias resolves correctly (NEW)

**Deliverable**: `/subtask` works with all overrides and CLI management.

---

## Phase 6: Result Capture

**Goal**: `{as:name}` and `$RESULT[name]` fully functional.

### 6.1 Capture Registration

- In command parsing: detect `{as:name}`
- Store pending capture with parent session
- In tool.before: register by subtask session ID

### 6.2 Capture Execution

- In tool.after: extract `output.state.output`
- Store in `subtaskResults[parentSessionID][name]`

### 6.3 Resolution

- Before return prompt execution: resolve `$RESULT[name]`
- Before command args execution: resolve `$RESULT[name]`

**Deliverable**: Full result capture flow works.

---

## Phase 7: Turn Injection

**Goal**: `$TURN[n]` fully functional.

### 7.1 Implementation

- Fetch messages via `client.session.messages()`
- Build turns array with proper ordering
- Handle all patterns: `[n]`, `[:n]`, `[:a:b:c]`, `[*]`

### 7.2 Integration Points

- In command.before: resolve in prompt
- In return processing: resolve before execution

**Deliverable**: $TURN works in all contexts.

---

## Phase 8: Non-Subtask Commands

**Goal**: Commands without `subtask: true` also support returns.

### 8.1 Implementation

- Store returns in `pendingNonSubtaskReturns`
- Process in `text.complete` hook
- No synthetic message replacement (different flow)

**Deliverable**: Returns work for all command types.

---

## Phase 9: Polish & Testing

### 9.1 Edge Cases

- Empty returns
- Missing results
- Invalid overrides
- Session cleanup verification

### 9.2 Unit Tests

- Update existing tests in `test/`
- Add new tests for v2 features

### 9.3 Integration Tests

- Full workflow tests
- Multi-model workflows
- Nested command returns

### 9.4 Documentation

- Update README.md
- Verify examples work

---

## Phase 10: Parallel (Conditional)

**Goal**: Parallel execution if OC PR is merged.

### 10.1 Check PR Status

- Verify PR #6478 is merged
- If not: skip this phase

### 10.2 Implementation

- Parse `parallel:` syntax
- Build multiple SubtaskParts
- Track completion of all parallels
- Fire return after all complete

---

## Implementation Order

```
Phase 1 → Phase 2 → Phase 3 → Phase 4 → Phase 5
    ↓         ↓         ↓         ↓         ↓
  Core     Parsing  Features   Hooks    /subtask

→ Phase 6 → Phase 7 → Phase 8 → Phase 9 → Phase 10
      ↓         ↓         ↓         ↓         ↓
  $RESULT   $TURN   Non-sub   Polish   Parallel
```

---

## Success Criteria

### Minimum Viable (Phases 1-5)

- [x] Plugin loads without errors
- [x] `/subtask` command works
- [x] Model/agent overrides work
- [x] Single return works
- [x] Return chains work

### Feature Complete (Phases 6-8)

- [x] `{as:name}` capture works
- [x] `$RESULT[name]` resolution works
- [x] `$TURN[n]` injection works
- [x] Non-subtask returns work

### Production Ready (Phase 9)

- [ ] All edge cases handled
- [ ] Unit tests pass
- [ ] Integration tests pass
- [ ] Documentation updated

---

## Estimated Effort

| Phase          | Effort  | Dependencies  |
| -------------- | ------- | ------------- |
| 1: Core        | 1 hour  | None          |
| 2: Parsing     | 1 hour  | Phase 1       |
| 3: Features    | 2 hours | Phase 1, 2    |
| 4: Hooks       | 2 hours | Phase 1, 2, 3 |
| 5: /subtask    | 1 hour  | Phase 4       |
| 6: $RESULT     | 1 hour  | Phase 5       |
| 7: $TURN       | 1 hour  | Phase 3       |
| 8: Non-subtask | 30 min  | Phase 4       |
| 9: Polish      | 2 hours | All above     |
| 10: Parallel   | TBD     | OC PR merge   |

**Total**: ~11-12 hours of focused work

---

## Notes

- Start fresh in `src/`, don't try to salvage v0.3.5 code
- Keep the modular file structure (easier to maintain)
- Restore v0.2.9's linear flow pattern
- Test each phase before moving to next
- No session.idle, no makePartVisible, no prompt-based mapping
