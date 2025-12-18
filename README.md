# @openspoon/subtask2

OpenCode plugin for enhanced subtask control with **return context injection** and **prompt chaining**.

## Features

- **`return`**: Append context to subtask output, ensuring the parent agent receives specific information
- **`chain`**: Queue follow-up user messages that execute sequentially after the subtask completes

## Installation

Add to your `opencode.json`:

```json
{
  "plugins": ["@openspoon/subtask2"]
}
```

## Usage

Add `return` and/or `chain` to your command frontmatter:

### Example: Code Review Command

`.opencode/command/review.md`

```markdown
---
description: subtask2 return and chain prompt example
agent: general
subtask: true
return: You are the agent in charge of assessing the bug review, challenge, verify and validate it, then discard it or implement it.
chain:
  - Let's now rinse and repeat with PR#356, use the task tool to review it for bugs etc... then assess, challenge, validate -> discard or implement.
  - Rinse and repeat, with next PR.
---

Review PR#355 for bugs, security issues, and code style problems.
```

## How It Works

1. When a subtask command with `return` executes, the return prompt is appended to the task output
2. When the subtask completes, each `chain` prompt is sent as a user message
3. Chain prompts execute sequentially
## License

MIT
