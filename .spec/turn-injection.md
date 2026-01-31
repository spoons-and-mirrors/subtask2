# Feature Spec: Turn Injection (`$TURN`)

## Summary

`$TURN[n]` injects conversation turns from the parent session into a command's prompt. This provides context to subtasks about what has been discussed in the main conversation.

---

## Syntax

### Last N Turns

```yaml
---
subtask: true
---
Review the following conversation:

$TURN[5]

Now provide your analysis.
```

### Specific Turn (by index from end)

```
$TURN[:3]   # Just the 3rd message from the end
```

### Multiple Specific Turns

```
$TURN[:2:5:8]   # Messages at indices 2, 5, and 8 from end
```

### All Turns

```
$TURN[*]    # Entire conversation history
```

---

## What is a "Turn"?

### Definition (v2)

A "turn" is the **last meaningful text output from an agent**.

For a simple user→assistant exchange:

- User message = 1 turn
- Assistant response = 1 turn

For an assistant message with Task tool calls:

- Main session's last text part = 1 turn
- Each Task tool's last text part = 1 turn each (ordered most recent first)

### Example

If the LLM sends a message with 3 Task tool calls:

```
$TURN[4] would include:
1. Last Task tool's final text (most recent)
2. Second Task tool's final text
3. First Task tool's final text
4. Main session's summary text
```

**Ordering**: Most recent first, walking backwards through the conversation.

---

## Format

### Output Format

```
--- USER ---
What's the best way to implement auth?

--- ASSISTANT ---
I'd recommend using JWT tokens with...

--- USER ---
Can you show me an example?

--- ASSISTANT ---
Here's an example implementation...
```

### Task Tool Results in Format

```
--- ASSISTANT (TASK: research-auth) ---
I found that JWT tokens are commonly used...

--- ASSISTANT ---
Based on my research, here's my recommendation...
```

---

## Resolution

### Where Resolution Happens

1. In `command.execute.before` for command prompts
2. Before return prompt is sent
3. In inline subtask prompt processing

### Resolution Function

```typescript
async function resolveTurns(
  text: string,
  sessionID: string,
  client: Client
): Promise<string> {
  if (!hasTurnReferences(text)) return text;

  // Fetch messages from session
  const messages = await client.session.messages({
    sessionID,
    limit: 100, // Reasonable limit
  });

  // Parse and build turns array
  const turns = buildTurnsFromMessages(messages);

  // Replace $TURN references
  return replaceTurnReferences(text, turns);
}
```

---

## Building Turns from Messages

### Algorithm

```typescript
function buildTurnsFromMessages(messages: Message[]): Turn[] {
  const turns: Turn[] = [];

  for (const msg of messages.reverse()) {
    // Oldest to newest
    if (msg.role === "user") {
      // Get the main text content (ignore synthetic)
      const text = extractUserText(msg);
      if (text) turns.push({ role: "user", text });
    } else if (msg.role === "assistant") {
      // Get last text part
      const mainText = extractLastTextPart(msg);
      if (mainText) turns.push({ role: "assistant", text: mainText });

      // Process any Task tool results
      const taskResults = extractTaskResults(msg);
      for (const task of taskResults) {
        turns.push({
          role: "assistant",
          text: task.result,
          taskName: task.name,
        });
      }
    }
  }

  return turns.reverse(); // Most recent first
}
```

### Extracting Last Text Part

```typescript
function extractLastTextPart(msg: AssistantMessage): string | null {
  const textParts = msg.parts.filter(p => p.type === "text" && !p.synthetic);
  if (textParts.length === 0) return null;
  return textParts[textParts.length - 1].text;
}
```

---

## $TURN Patterns

### Pattern: `$TURN[n]`

Get last n turns:

```typescript
const pattern = /\$TURN\[(\d+)\]/g;
// $TURN[5] → n = 5 → last 5 turns
```

### Pattern: `$TURN[:n]`

Get specific turn at index n from end:

```typescript
const pattern = /\$TURN\[:(\d+)\]/g;
// $TURN[:3] → index 3 from end → one turn
```

### Pattern: `$TURN[:a:b:c]`

Get multiple specific turns:

```typescript
const pattern = /\$TURN\[:([\d:]+)\]/g;
// $TURN[:2:5:8] → indices 2, 5, 8 from end
```

### Pattern: `$TURN[*]`

Get all turns:

```typescript
const pattern = /\$TURN\[\*\]/g;
// All available turns
```

---

## Edge Cases

### Not Enough Turns

```
$TURN[10]  # But only 3 turns exist
```

Return all available turns (3 in this case).

### Empty Conversation

```
$TURN[5]  # No previous turns
```

Return empty string or placeholder text.

### In Nested Subtask

```
$TURN[5]  # In a subtask's subtask
```

Should reference the immediate parent session's turns.

### Synthetic Messages

Filter out messages where all parts are `synthetic: true`.

---

## Session Context

### Which Session's Turns?

- For command invocation: The session where command was called
- For subtask prompt: The parent session (not the subtask session)
- $TURN always looks "up" to the context the user sees

### Session ID Source

In `command.execute.before`:

```typescript
const sessionID = input.sessionID;
// This is the session where the command was invoked
// For subtasks, this is the parent session
```

---

## Performance Considerations

### Message Limit

Don't fetch unlimited messages:

```typescript
const messages = await client.session.messages({
  sessionID,
  limit: Math.min(n * 2, 100), // Reasonable upper bound
});
```

### Caching

Consider caching resolved turns if same session is used multiple times.

---

## Test Cases

1. **Basic**: `$TURN[3]` → Last 3 turns formatted
2. **Specific**: `$TURN[:2]` → Just turn at index 2
3. **Multiple**: `$TURN[:1:3:5]` → Turns at 1, 3, 5
4. **All**: `$TURN[*]` → Full history
5. **Not enough**: `$TURN[100]` → All available
6. **Empty**: First message, no turns → Empty/placeholder
7. **With tasks**: Assistant with Task tools → Includes task results
8. **Formatting**: Proper `--- USER ---` / `--- ASSISTANT ---` markers

---

## Implementation Checklist

- [ ] Detect $TURN patterns in text
- [ ] Fetch session messages via SDK
- [ ] Build turns array from messages
- [ ] Handle Task tool results in turns
- [ ] Implement pattern replacement
- [ ] Handle edge cases (not enough, empty)
- [ ] Format output with role markers
- [ ] Apply in command.before and return processing
