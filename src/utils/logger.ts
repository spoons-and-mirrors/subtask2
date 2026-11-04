import { appendFileSync, mkdirSync, existsSync, writeFileSync } from "fs";

const LOG_DIR = `${process.env.HOME}/.config/opencode/plugin/subtask2/logs`;
const LOG_FILE = `${LOG_DIR}/debug.log`;

// Ensure log directory exists immediately on load as tested
if (!existsSync(LOG_DIR)) {
  try {
    mkdirSync(LOG_DIR, { recursive: true });
  } catch {}
}

export function log(...args: unknown[]): void {
  if (!existsSync(LOG_DIR)) {
    try {
      mkdirSync(LOG_DIR, { recursive: true });
    } catch {}
  }
  const timestamp = new Date().toISOString();
  const message = args
    .map(a => (typeof a === "object" ? JSON.stringify(a, null, 2) : String(a)))
    .join(" ");
  try {
    appendFileSync(LOG_FILE, `[${timestamp}] ${message}\n`);
  } catch {}
}

export function clearLog(): void {
  if (!existsSync(LOG_DIR)) {
    try {
      mkdirSync(LOG_DIR, { recursive: true });
    } catch {}
  }
  try {
    writeFileSync(LOG_FILE, "");
  } catch {}
}
