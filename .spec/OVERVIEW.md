# Subtask2 Plugin Specification

## Mission Statement

Subtask2 enhances OpenCode's `/command` system by enabling:

- **Chaining**: Sequential execution of prompts and commands after subtask completion
- **Context Relay**: Passing conversation turns and captured results between agents
- **Overrides**: Inline model/agent specification for any command invocation
- **Ad-hoc Subtasks**: The `/subtask` command for instant subtask creation without command files

## Core Principle: Work WITH OpenCode, Not Against It

**The #1 architectural failure of v0.3.x** was fighting OpenCode's internal mechanisms:

- Patching the database to make synthetic messages visible
- Using undocumented internal HTTP clients
- Racing between multiple hooks for the same state

**The v2 approach**:

- Use only documented plugin hooks and SDK APIs
- Accept OpenCode's synthetic message behavior, transform it in-memory
- Single responsibility per hook - no overlapping state consumption
- Clean, linear execution flow

---

## Feature Scope (v2)

### In Scope

1. **Return Chaining** (`return:`) - Execute prompts/commands after subtask completion
2. **Inline Subtasks** (`/subtask`) - Ad-hoc subtask creation with overrides
3. **Result Capture** (`{as:name}`, `$RESULT[name]`) - Named output storage and retrieval
4. **Overrides** (`{model:...}`, `{agent:...}`) - Per-invocation model/agent switching
5. **Turn Injection** (`$TURN[n]`) - Inject conversation context into subtasks
6. **Parallel Execution** (`parallel:`) - Run multiple subtasks concurrently (pending OC PR)
7. **Pipe Arguments** (`||`) - Pass different arguments to parallel commands

### Deferred (Not in v2)

1. **Loop** (`loop:`, `until:`) - Iterative execution with condition evaluation
2. **Auto Mode** (`subtask2: auto`) - Automatic workflow parsing
3. **Nested Inline Returns** - Multiple returns within inline subtasks
4. **Visible Returns** - Making return prompts appear as real user messages

---

## Decision Log

| Decision                                  | Rationale                                     |
| ----------------------------------------- | --------------------------------------------- |
| Base on 0.2.9 architecture                | Proven simple linear flow, no races           |
| Use `text.complete` for remaining returns | Predictable timing, fires after each LLM turn |
| Use `messages.transform` for first return | Replace synthetic "Summarize..." in-memory    |
| Remove `session.idle` for returns         | Was racing with message-hooks                 |
| Single return per inline subtask          | Nested returns added stack complexity         |
| Implement session cleanup                 | Prevent memory leaks from Maps                |
| Don't modify database                     | No `makePartVisible` hacks                    |

---

## OpenCode Hook Usage

### Hooks We Use

| Hook                                   | Purpose                                                 |
| -------------------------------------- | ------------------------------------------------------- |
| `command.execute.before`               | Parse frontmatter, setup return state, handle overrides |
| `tool.execute.before`                  | Track subtask→parent session mapping                    |
| `tool.execute.after`                   | Capture results, set pending return                     |
| `experimental.chat.messages.transform` | Replace synthetic message with first return             |
| `experimental.text.complete`           | Fire remaining returns after LLM response               |
| `config`                               | Register `/subtask` command                             |

### Hooks We DON'T Use

| Hook                   | Reason                                             |
| ---------------------- | -------------------------------------------------- |
| `event` (session.idle) | Races with message-transform, unpredictable timing |
| Internal DB patching   | Undocumented, fragile, fights OC design            |

---

## State Design

### Principle: Minimal, Session-Scoped, Single-Owner

Each piece of state should:

1. Have ONE hook that sets it
2. Have ONE hook that consumes it
3. Be cleaned up when no longer needed

### Core State Maps

```typescript
// Command tracking
callState: Map<callID, commandName>         // Set in tool.before, consumed in tool.after
sessionMainCommand: Map<sessionID, cmdName>  // Tracks which command started a session

// Return processing
pendingReturns: Map<sessionID, string>       // FIRST return, set in tool.after, consumed in messages.transform
returnState: Map<sessionID, string[]>        // REMAINING returns, set in command.before, consumed in text.complete

// Result capture
pendingResultCapture: Map<subtaskSessionID, {parent, name}> // Set in tool.before, consumed in tool.after
subtaskResults: Map<parentSessionID, Map<name, result>>     // Set in tool.after, resolved in return processing

// Parent tracking
subtaskParentSession: Map<subtaskSessionID, parentSessionID> // Set in tool.before

// Cleanup tracking
executedReturns: Set<sessionID:prompt>       // Dedup
```

### Session Cleanup

On completion of return chain (when returnState is empty and no pending returns):

- Clear all Maps for that sessionID
- Prevent memory growth in long-running OpenCode instances

---

## Execution Flow

```
1. User invokes /mycommand "args"
   │
2. command.execute.before
   ├── Parse frontmatter (return, parallel, model, agent)
   ├── Store returnState[1..n] (remaining returns)
   ├── Apply model/agent overrides to output.parts
   └── Resolve $TURN references in prompt
   │
3. OpenCode executes command (creates subtask if subtask: true)
   │
4. tool.execute.before (for Task tool)
   ├── Register subtaskSession → parentSession mapping
   └── Register result capture if {as:name} present
   │
5. Subtask runs, LLM responds
   │
6. tool.execute.after
   ├── Capture result if pending capture exists
   └── Set pendingReturns[0] = first return
   │
7. experimental.chat.messages.transform
   ├── Find "Summarize the task tool output..." part
   ├── If pendingReturns exists:
   │   ├── If prompt: Replace text with return prompt
   │   └── If /command: Replace text with empty, execute command
   └── Else: Replace with plugin default (generic_return)
   │
8. LLM responds to return prompt (or command executes)
   │
9. experimental.text.complete
   ├── If returnState has more items:
   │   ├── Shift next return
   │   └── Execute (prompt via message injection, or /command)
   └── Else: Chain complete, cleanup session state
```

---

## File Structure (v2)

```
src/
├── index.ts              # Export createPlugin
├── plugin.ts             # Hook registration, plugin entry
├── state.ts              # All state Maps, getters/setters, cleanup
├── hooks/
│   ├── command.ts        # command.execute.before
│   ├── tool.ts           # tool.before + tool.after
│   ├── messages.ts       # messages.transform
│   └── complete.ts       # text.complete
├── features/
│   ├── returns.ts        # Return execution logic
│   ├── results.ts        # $RESULT resolution
│   └── turns.ts          # $TURN resolution
├── parsing/
│   ├── frontmatter.ts    # YAML frontmatter parsing
│   ├── overrides.ts      # {model:...} inline syntax
│   └── commands.ts       # Command detection and parsing
└── config.ts             # Plugin config (generic_return, etc)
```

---

## Next Steps

1. Spec each feature in detail (return-chaining.md, inline-subtask.md, etc.)
2. Validate against OpenCode SDK capabilities
3. Define test cases for each feature
4. Implementation plan with phases
