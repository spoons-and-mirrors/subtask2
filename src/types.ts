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

export interface SessionPromptEvent {
  readonly sessionID: string;
  prompt: {
    text: string;
    files?: unknown[];
    agents?: unknown[];
    skills?: unknown[];
  };
  metadata?: Record<string, unknown>;
  delivery?: string;
}

export interface SessionContextEvent {
  readonly sessionID: string;
  messages: Array<{
    role: string;
    content: Array<{ type: string; text?: string; [key: string]: any }>;
    [key: string]: any;
  }>;
  system: Array<{ type: string; text: string }>;
  [key: string]: any;
}

