// Plugin configuration management
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { log } from "./state";

export interface PluginConfig {
  replace_generic: boolean;
  generic_return?: string;
  model_aliases: Record<string, string>; // alias → full model ID
}

const CONFIG_DIR = join(homedir(), ".config", "opencode");
const CONFIG_PATH = join(CONFIG_DIR, "subtask2.jsonc");

const DEFAULT_CONFIG: PluginConfig = {
  replace_generic: true,
  model_aliases: {},
};

let config: PluginConfig | null = null;

// Strip JSONC comments for parsing
const stripComments = (jsonc: string): string => {
  return jsonc
    .replace(/\/\*[\s\S]*?\*\//g, "") // block comments
    .replace(/\/\/.*$/gm, ""); // line comments
};

export const loadConfig = (): PluginConfig => {
  if (config) return config;

  try {
    if (existsSync(CONFIG_PATH)) {
      const raw = readFileSync(CONFIG_PATH, "utf-8");
      const parsed = JSON.parse(stripComments(raw));
      config = { ...DEFAULT_CONFIG, ...parsed };
      log("config loaded", config);
    } else {
      config = { ...DEFAULT_CONFIG };
      log("using default config");
    }
  } catch (err) {
    log("config load error", err);
    config = { ...DEFAULT_CONFIG };
  }

  return config!;
};

export const saveConfig = (newConfig: PluginConfig): void => {
  try {
    if (!existsSync(CONFIG_DIR)) {
      mkdirSync(CONFIG_DIR, { recursive: true });
    }
    writeFileSync(CONFIG_PATH, JSON.stringify(newConfig, null, 2), "utf-8");
    config = newConfig;
    log("config saved");
  } catch (err) {
    log("config save error", err);
  }
};

export const getPluginConfig = (): PluginConfig => {
  return config ?? loadConfig();
};

// Resolve model alias to full model ID
export const resolveModelAlias = (model: string): string => {
  const cfg = getPluginConfig();
  return cfg.model_aliases[model] ?? model;
};
