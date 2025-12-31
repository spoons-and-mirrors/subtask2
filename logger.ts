import { appendFileSync, mkdirSync, existsSync, writeFileSync } from "fs";

const LOG_DIR = `${process.env.HOME}/.config/opencode/plugin/subtask2/logs`;
const LOG_FILE = `${LOG_DIR}/debug.log`;

// Ensure log directory exists
if (!existsSync(LOG_DIR)) {
  mkdirSync(LOG_DIR, { recursive: true });
}

export function log(...args: unknown[]) {
  const timestamp = new Date().toISOString();
  const message = args
    .map((a) => (typeof a === "object" ? JSON.stringify(a, null, 2) : String(a)))
    .join(" ");
  appendFileSync(LOG_FILE, `[${timestamp}] ${message}\n`);
}

export function clearLog() {
  writeFileSync(LOG_FILE, "");
}
