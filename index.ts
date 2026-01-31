/**
 * Subtask2 Plugin - Main Entry Point
 *
 * A powerful orchestration system for OpenCode commands that enables:
 * - Queue-up prompts/commands/subagents with arguments
 * - Parallelize execution where desired
 * - Pass session context to subagents
 * - Steer agentic flow from start to finish
 */

import { createPlugin } from "./src/plugin";

export default createPlugin;
