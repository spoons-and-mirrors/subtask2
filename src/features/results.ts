import { getAllSubtaskResults } from "../core/state";
import { log } from "../utils/logger";

/**
 * Pattern to match $RESULT[name] references
 */
const RESULT_PATTERN = /\$RESULT\[([^\]]+)\]/g;

/**
 * Check if text contains $RESULT[name] references
 */
export function hasResultReferences(text: string): boolean {
  // Reset lastIndex since we're reusing the regex
  RESULT_PATTERN.lastIndex = 0;
  return RESULT_PATTERN.test(text);
}

/**
 * Resolve all $RESULT[name] references in text
 * Replaces each reference with the stored result or a placeholder if not found
 */
export function resolveResultReferences(
  text: string,
  sessionID: string
): string {
  // Reset lastIndex since we're reusing the regex
  RESULT_PATTERN.lastIndex = 0;

  // Check if there are any references first
  if (!RESULT_PATTERN.test(text)) return text;

  const results = getAllSubtaskResults(sessionID);

  // Reset again after test()
  RESULT_PATTERN.lastIndex = 0;

  return text.replace(RESULT_PATTERN, (_match, name) => {
    const result = results?.get(name);
    if (result) {
      log(
        `resolveResultReferences: resolved $RESULT[${name}] (${result.length} chars)`
      );
      return result;
    }
    log(`resolveResultReferences: $RESULT[${name}] not found`);
    return `[Result '${name}' not found]`;
  });
}
