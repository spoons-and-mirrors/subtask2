import * as fs from "fs";
import * as path from "path";

const LOG_DIR = path.join(process.cwd(), ".logs");
const LOG_FILE = path.join(LOG_DIR, "subtask2.log");
const WRITE_INTERVAL_MS = 100;

let logBuffer: string[] = [];
let writeScheduled = false;
let initialized = false;

function ensureInitialized(): boolean {
  if (initialized) return true;

  try {
    if (!fs.existsSync(LOG_DIR)) {
      fs.mkdirSync(LOG_DIR, { recursive: true });
    }
    fs.writeFileSync(LOG_FILE, "");
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
  } catch {}
}

function scheduleFlush(): void {
  if (!writeScheduled) {
    writeScheduled = true;
    setTimeout(flushLogs, WRITE_INTERVAL_MS);
  }
}

export function log(...args: unknown[]) {
  if (!ensureInitialized()) return;

  const timestamp = formatTimestamp();
  const message = args
    .map(a => (typeof a === "object" ? JSON.stringify(a, null, 2) : String(a)))
    .join(" ");
  logBuffer.push(`[${timestamp}] ${message}\n`);
  scheduleFlush();
}

export function clearLog() {
  if (!ensureInitialized()) return;
  fs.writeFileSync(LOG_FILE, "");
}
