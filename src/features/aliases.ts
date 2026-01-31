// Model alias management
import { getPluginConfig, saveConfig } from "../config";
import { log } from "../state";

/**
 * Get all model aliases
 */
export function getAliases(): Record<string, string> {
  return getPluginConfig().model_aliases ?? {};
}

/**
 * Set a model alias
 */
export async function setAlias(alias: string, model: string): Promise<void> {
  const config = getPluginConfig();
  config.model_aliases ??= {};
  config.model_aliases[alias] = model;
  saveConfig(config);
  log("Set alias:", alias, "→", model);
}

/**
 * Delete a model alias
 */
export function deleteAlias(alias: string): boolean {
  const config = getPluginConfig();
  if (!config.model_aliases?.[alias]) return false;
  delete config.model_aliases[alias];
  saveConfig(config);
  log("Deleted alias:", alias);
  return true;
}

/**
 * Format aliases for display
 */
export function formatAliases(): string {
  const aliases = getAliases();
  const entries = Object.entries(aliases);
  if (entries.length === 0) return "No model aliases configured.";

  return entries.map(([alias, model]) => `  ${alias} → ${model}`).join("\n");
}
