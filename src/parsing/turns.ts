/**
 * Parsing: $TURN[n] reference extraction and manipulation
 */

// $TURN[n] - last n messages
// $TURN[:n] or $TURN[:n:m:o] - specific messages at indices (1-based from end)

export type TurnReference =
  | { type: "lastN"; match: string; count: number }
  | { type: "specific"; match: string; indices: number[] }
  | { type: "all"; match: string };

/**
 * Extract all $TURN references from a string
 * - $TURN[n] -> last n messages
 * - $TURN[:n] or $TURN[:2:5:8] -> specific indices (1-based from end)
 */
export function extractTurnReferences(text: string): TurnReference[] {
  const refs: TurnReference[] = [];

  // Match $TURN[...] patterns
  const regex = /\$TURN\[([^\]]+)\]/g;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    const inner = match[1];

    if (inner === "*") {
      // All messages: $TURN[*]
      refs.push({ type: "all", match: match[0] });
    } else if (inner.startsWith(":")) {
      // Specific indices: $TURN[:2] or $TURN[:2:5:8]
      const indices = inner
        .split(":")
        .filter(Boolean)
        .map(n => parseInt(n, 10));
      if (indices.length > 0 && indices.every(n => !isNaN(n))) {
        refs.push({ type: "specific", match: match[0], indices });
      }
    } else {
      // Last N: $TURN[5]
      const count = parseInt(inner, 10);
      if (!isNaN(count)) {
        refs.push({ type: "lastN", match: match[0], count });
      }
    }
  }
  return refs;
}

/**
 * Check if text contains any $TURN references
 */
export function hasTurnReferences(text: string): boolean {
  return /\$TURN\[[^\]]+\]/.test(text);
}

/**
 * Replace all $TURN references in text with the provided content map
 */
export function replaceTurnReferences(
  text: string,
  replacements: Map<string, string>
): string {
  let result = text;
  for (const [pattern, replacement] of replacements) {
    result = result.replaceAll(pattern, replacement);
  }
  return result;
}

// Keep old names as aliases for backward compat during transition
export const extractSessionReferences = extractTurnReferences;
export const hasSessionReferences = hasTurnReferences;
export const replaceSessionReferences = replaceTurnReferences;
export type SessionReference = TurnReference;
