# Architecture Specification

This document defines the technical architecture for the v2 refactor, based on lessons learned from v0.3.x and the proven patterns from v0.2.9.

---

## Core Principles

### 1. Work WITH OpenCode, Not Against It

- Use only documented hooks and SDK APIs
- Accept synthetic message behavior, don't fight it
- No internal HTTP client access
- No database modifications

### 2. Single Responsibility per Hook

- Each hook has ONE job
- No overlapping state consumption
- Clear ownership of state transitions

### 3. Linear Execution Flow

- Predictable order: command → tool.before → tool.after → messages.transform → text.complete
- No racing between hooks
- No dual processing paths

### 4. Minimal State

- Only store what's needed
- Session-scoped with cleanup
- One setter, one consumer per state item

---

## Hook Responsibilities

### `command.execute.before`

**Input**: command name, arguments, sessionID
**Output**: parts array (can modify)

**Responsibilities**:

1. For `/subtask` command: handle CLI interface first
   - No args → show help (ignored message), throw to stop
   - `-a` flag → alias management, throw to stop
2. Parse frontmatter (return, parallel, model, agent)
3. Detect `/subtask` command and build SubtaskPart
4. Resolve model aliases before applying
5. Apply inline overrides to SubtaskPart
6. Resolve $TURN in prompt
7. Store returnState[1..n] (remaining returns)

**State Written**:

- `returnState[sessionID]` - remaining returns (index 1+)
- `sessionMainCommand[sessionID]` - track which command

Note: Model/agent overrides are applied directly to SubtaskPart, no pending state needed.

---

### `tool.execute.before`

**Input**: tool name, callID, sessionID
**Output**: args (can modify)

**Responsibilities**:

1. For Task tool only: register parent session mapping
2. Register result capture if {as:name} pending

**State Written**:

- `subtaskParentSession[subtaskSessionID]` - maps to parent
- `pendingResultCapture[subtaskSessionID]` - capture registration
- `callState[callID]` - tracks tool to command mapping

---

### `tool.execute.after`

**Input**: tool name, callID, sessionID
**Output**: title, output, metadata

**Responsibilities**:

1. Capture result if pendingResultCapture exists
2. Set pendingReturns[0] (first return)
3. Handle non-subtask command returns

**State Written**:

- `subtaskResults[parentSessionID][name]` - captured result
- `pendingReturns[sessionID]` - first return to fire

**State Consumed**:

- `callState[callID]` - to identify which command
- `pendingResultCapture[subtaskSessionID]` - capture info
- `returnState[sessionID][0]` - first return (moved to pendingReturns)

---

### `experimental.chat.messages.transform`

**Input**: empty
**Output**: messages array

**Responsibilities**:

1. Find "Summarize the task tool output..." part
2. Replace with pendingReturns or generic_return
3. If return is /command, set text empty and execute command

**State Consumed**:

- `pendingReturns[sessionID]` - first return

**Side Effects**:

- May call `client.session.command()` for command returns

---

### `experimental.text.complete`

**Input**: sessionID, messageID, partID
**Output**: text (can modify)

**Responsibilities**:

1. Fire remaining returns from returnState
2. Handle prompt returns via session.prompt
3. Handle command returns via session.command
4. Cleanup when chain complete

**State Consumed**:

- `returnState[sessionID]` - remaining returns

**Side Effects**:

- Calls `client.session.prompt()` or `client.session.command()`

**Cleanup Trigger**:

- When returnState empty and no pending returns

---

### `config`

**Input**: config object with commands

**Responsibilities**:

1. Register `/subtask` command

---

## State Design

### Core Maps

```typescript
// === Command Tracking ===
// Maps tool callID to command name for identification
const callState = new Map<string, string>();
// Tracks which command initiated a session
const sessionMainCommand = new Map<string, string>();

// === Return Processing ===
// First return (consumed by messages.transform)
const pendingReturns = new Map<string, string>();
// Remaining returns (consumed by text.complete)
const returnState = new Map<string, string[]>();
// Returns for non-subtask commands
const pendingNonSubtaskReturns = new Map<string, string[]>();
// Deduplication
const executedReturns = new Set<string>();

// === Parent/Child Session ===
// Maps subtask session to parent session
const subtaskParentSession = new Map<string, string>();

// === Result Capture ===
// Pending capture registration
const pendingResultCapture = new Map<
  string,
  {
    parentSessionID: string;
    name: string;
  }
>();
// Stored results by parent session
const subtaskResults = new Map<string, Map<string, string>>();

// === Override Application ===
// Note: Model/agent are applied directly to SubtaskPart, no Maps needed

// === Config ===
// Plugin configuration (persisted to file)
interface PluginConfig {
  replace_generic: boolean;
  generic_return?: string;
  model_aliases: Record<string, string>; // alias → full model ID
}
let pluginConfig: PluginConfig;
```

### State Flow Diagram

```
command.execute.before
  │
  ├─→ returnState[sessionID] = [return2, return3, ...]
  └─→ Apply model/agent directly to SubtaskPart (no pending state)

tool.execute.before
  │
  ├─→ subtaskParentSession[subtaskSID] = parentSID
  └─→ pendingResultCapture[subtaskSID] = {parent, name}

tool.execute.after
  │
  ├─→ subtaskResults[parentSID][name] = result
  ├─→ pendingReturns[sessionID] = return1
  └─← consumes pendingResultCapture, callState

messages.transform
  │
  └─← consumes pendingReturns
      (replaces synthetic message text)

text.complete
  │
  └─← consumes returnState
      (fires remaining returns, then cleanup)
```

---

## Session Cleanup

### When to Cleanup

- After text.complete processes last return
- When returnState is empty AND pendingReturns is consumed

### What to Cleanup

```typescript
function cleanupSession(sessionID: string) {
  returnState.delete(sessionID);
  pendingReturns.delete(sessionID);
  pendingNonSubtaskReturns.delete(sessionID);
  sessionMainCommand.delete(sessionID);
  subtaskResults.delete(sessionID);

  // Clean subtaskParentSession entries where parent is sessionID
  for (const [child, parent] of subtaskParentSession) {
    if (parent === sessionID) {
      subtaskParentSession.delete(child);
      pendingResultCapture.delete(child);
    }
  }

  // Clean executedReturns for this session
  for (const key of executedReturns) {
    if (key.startsWith(`${sessionID}:`)) {
      executedReturns.delete(key);
    }
  }
}
```

---

## File Structure

```
src/
├── index.ts              # Export point
│
├── plugin.ts             # Hook registration
│   └── Returns hooks object to OpenCode
│
├── state.ts              # All state management
│   ├── Map definitions
│   ├── Getters/setters
│   └── Cleanup function
│
├── hooks/
│   ├── command.ts        # command.execute.before
│   ├── tool.ts           # tool.before + tool.after
│   ├── messages.ts       # messages.transform
│   └── complete.ts       # text.complete
│
├── features/
│   ├── returns.ts        # Return execution helpers
│   ├── results.ts        # $RESULT resolution
│   ├── turns.ts          # $TURN resolution
│   └── aliases.ts        # Model alias resolution (NEW)
│
├── parsing/
│   ├── frontmatter.ts    # YAML parsing
│   ├── overrides.ts      # {model:...} syntax
│   └── commands.ts       # Command detection
│
└── config.ts             # Plugin config loading + saving (for aliases)
```

---

## Error Handling

### Graceful Degradation

- Invalid override syntax → use defaults, log warning
- Missing $RESULT → replace with error message
- SDK errors → log, don't crash

### Logging

```typescript
const log = (...args: any[]) => {
  if (process.env.DEBUG) {
    console.log("[subtask2]", ...args);
  }
};
```

---

## Testing Strategy

### Unit Tests

- Parsing (frontmatter, overrides, commands)
- State management (get/set/cleanup)
- $TURN resolution
- $RESULT resolution

### Integration Tests

- Full return chain execution
- Inline subtask with overrides
- Result capture and retrieval
- Session cleanup

### Manual Testing

- TUI verification
- Multi-model workflows
- Edge cases (empty returns, missing results)

---

## Migration from v0.3.5

### Remove

- session.idle event handler
- makePartVisible function
- prompt-based session mapping
- returnStack (nested returns)
- loop functionality
- auto mode

### Keep (Refactor)

- Frontmatter parsing
- Override parsing
- $TURN resolution
- Result capture (simplified)
- Return execution (simplified)

### Restore from v0.2.9

- text.complete hook usage
- Simple linear return flow
- Single-owner state management
