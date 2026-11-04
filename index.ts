/**
 * Subtask2 Plugin - Main Entry Point
 *
 * Hybrid OpenCode V1 + V2 architecture:
 * - V2 entry point via Plugin.define (setup)
 * - V1 server function for backward compatibility
 */

import { plugin as pluginV2 } from "./src/v2/setup.js";
import { server as serverV1 } from "./src/v1/server.js";

export default {
  ...pluginV2,
  server: serverV1,
};

export { serverV1 as createPlugin };
