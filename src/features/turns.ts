// Turn injection - $TURN[n] resolution
import { log } from "../state";

interface Turn {
  role: "user" | "assistant";
  text: string;
  taskName?: string;
}

// Client reference (set by hooks)
let clientRef: any = null;

export const setClient = (client: any) => {
  clientRef = client;
};

/**
 * Check if text contains $TURN references
 */
export function hasTurnReferences(text: string): boolean {
  return /\$TURN\[/.test(text);
}

/**
 * Resolve $TURN references in text
 */
export async function resolveTurns(
  text: string,
  sessionID: string
): Promise<string> {
  if (!hasTurnReferences(text)) return text;
  if (!clientRef) {
    log("No client reference for turn resolution");
    return text;
  }

  // Fetch session messages
  const messages = await fetchSessionMessages(sessionID);
  const turns = buildTurnsFromMessages(messages);

  return replaceTurnReferences(text, turns);
}

async function fetchSessionMessages(sessionID: string): Promise<any[]> {
  try {
    const result = await clientRef.session.messages({
      path: { id: sessionID },
      query: { limit: 100 },
    });
    return result.data ?? [];
  } catch (e) {
    log("Error fetching messages:", e);
    return [];
  }
}

function buildTurnsFromMessages(messages: any[]): Turn[] {
  const turns: Turn[] = [];

  // Process oldest to newest, then reverse for "most recent first"
  for (const msg of messages) {
    const role = msg.info?.role;

    if (role === "user") {
      const text = extractUserText(msg);
      if (text) turns.push({ role: "user", text });
    } else if (role === "assistant") {
      // Get the last text part (summary)
      const text = extractLastTextPart(msg);
      if (text) turns.push({ role: "assistant", text });

      // Also extract task tool results
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

function extractUserText(msg: any): string | null {
  const parts = msg.parts ?? [];
  for (const p of parts) {
    if (p.type === "text" && !p.ignored && !p.synthetic) {
      return p.text;
    }
  }
  return null;
}

function extractLastTextPart(msg: any): string | null {
  const parts = msg.parts ?? [];
  const textParts = parts.filter((p: any) => p.type === "text" && !p.synthetic);
  if (textParts.length === 0) return null;
  return textParts[textParts.length - 1].text;
}

function extractTaskResults(msg: any): { name: string; result: string }[] {
  const parts = msg.parts ?? [];
  const results: { name: string; result: string }[] = [];

  for (const p of parts) {
    if (p.type === "tool-invocation" && p.tool?.name === "task") {
      const output = p.state?.output;
      if (typeof output === "string") {
        results.push({
          name: p.input?.description ?? "task",
          result: output,
        });
      }
    }
  }

  return results.reverse(); // Most recent first
}

function replaceTurnReferences(text: string, turns: Turn[]): string {
  // $TURN[n] - last n turns
  text = text.replace(/\$TURN\[(\d+)\]/g, (_, n) => {
    const count = parseInt(n, 10);
    // Slice the most recent, then reverse to chronological for display
    return formatTurns(turns.slice(0, count).reverse());
  });

  // $TURN[:n] - specific turn at index n from end
  text = text.replace(/\$TURN\[:(\d+)\]/g, (_, n) => {
    const idx = parseInt(n, 10);
    return idx < turns.length ? formatTurns([turns[idx]]) : "";
  });

  // $TURN[:a:b:c] - multiple specific indices
  text = text.replace(/\$TURN\[:([\d:]+)\]/g, (_, indices) => {
    const idxs = indices.split(":").map((s: string) => parseInt(s, 10));
    const selected = idxs
      .filter((i: number) => i < turns.length)
      .map((i: number) => turns[i]);
    return formatTurns(selected);
  });

  // $TURN[*] - all turns (reversed to chronological)
  text = text.replace(/\$TURN\[\*\]/g, () => formatTurns([...turns].reverse()));

  return text;
}

function formatTurns(turns: Turn[]): string {
  if (turns.length === 0) return "[No turns available]";

  return turns
    .map(t => {
      const label = t.taskName
        ? `--- ASSISTANT (TASK: ${t.taskName}) ---`
        : `--- ${t.role.toUpperCase()} ---`;
      return `${label}\n${t.text}`;
    })
    .join("\n\n");
}
