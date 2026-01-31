// Result capture and resolution
import { getSubtaskResults, log } from "../state";

/**
 * Check if text contains $RESULT references
 */
export function hasResultReferences(text: string): boolean {
  return /\$RESULT\[/.test(text);
}

/**
 * Resolve $RESULT[name] references in text
 */
export function resolveResults(text: string, sessionID: string): string {
  if (!hasResultReferences(text)) return text;

  const results = getSubtaskResults(sessionID);

  return text.replace(/\$RESULT\[([^\]]+)\]/g, (match, name) => {
    const value = results?.get(name);
    if (value) {
      log("Resolved $RESULT[" + name + "]");
      return value;
    }
    log("Result not found:", name);
    return `[Result '${name}' not found]`;
  });
}
