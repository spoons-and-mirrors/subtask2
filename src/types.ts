export interface LoopConfig {
  max: number; // Max iterations
  until: string; // Completion condition
}

export interface ParallelCommand {
  command: string;
  arguments?: string;
  prompt?: string;
  model?: string; // Override model: "provider/model-id"
  agent?: string;
  loop?: LoopConfig; // Retry until completion
  as?: string; // Named result identifier for $RESULT[name] references
  inline?: boolean;
}

export interface CommandConfig {
  return: string[];
  parallel: ParallelCommand[];
  agent?: string;
  description?: string;
  template?: string;
  loop?: LoopConfig;
  model?: string;
  auto?: boolean; // subtask2: auto mode - LLM generates workflow dynamically
}

export interface Subtask2Config {
  replace_generic: boolean;
  generic_return?: string;
  logging?: boolean;
}

export interface SubtaskPart {
  type: "subtask";
  agent: string;
  model?: { providerID: string; modelID: string };
  description: string;
  command: string;
  prompt: string;
  as?: string; // Named result identifier for $RESULT[name] references
}
