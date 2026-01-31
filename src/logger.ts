import * as fs from "fs";
import * as path from "path";

// =============================================================================
// File logger for debugging subtask2 plugin
// Active when OPENCODE_SUBTASK2_LOG=1 or OPENCODE_SUBTASK2_LOG=true
// =============================================================================

const LOG_DIR = path.join(process.cwd(), ".logs");
const LOG_FILE = path.join(LOG_DIR, "subtask2.log");
const WRITE_INTERVAL_MS = 100;

let logBuffer: string[] = [];
let writeScheduled = false;
let initialized = false;

function isLoggingEnabled(): boolean {
  const val = process.env.OPENCODE_SUBTASK2_LOG;
  return val === "1" || val === "true";
}

function ensureInitialized(): boolean {
  if (initialized) return true;
  if (!isLoggingEnabled()) return false;

  try {
    if (!fs.existsSync(LOG_DIR)) {
      fs.mkdirSync(LOG_DIR, { recursive: true });
    }
    // Clear log file on init
    fs.writeFileSync(
      LOG_FILE,
      `[${formatTimestamp()}] subtask2 logger initialized\n`
    );
    initialized = true;
    return true;
  } catch {
    return false;
  }
}

function formatTimestamp(): string {
  return new Date().toISOString();
}

async function flushLogs(): Promise<void> {
  if (logBuffer.length === 0) {
    writeScheduled = false;
    return;
  }

  const toWrite = logBuffer.join("");
  logBuffer = [];
  writeScheduled = false;

  try {
    await fs.promises.appendFile(LOG_FILE, toWrite);
  } catch {
    // Silently fail
  }
}

function scheduleFlush(): void {
  if (!writeScheduled) {
    writeScheduled = true;
    setTimeout(flushLogs, WRITE_INTERVAL_MS);
  }
}

// Simple log function matching the old interface: log(...args)
export function log(...args: unknown[]): void {
  if (!ensureInitialized()) return;

  const timestamp = formatTimestamp();
  const message = args
    .map(arg =>
      typeof arg === "object" ? JSON.stringify(arg, null, 0) : String(arg)
    )
    .join(" ");

  const logLine = `[${timestamp}] [subtask2] ${message}\n`;

  logBuffer.push(logLine);
  scheduleFlush();
}

// Expose flush for graceful shutdown if needed
log.flush = flushLogs;
