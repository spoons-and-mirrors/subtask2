// Command detection and parsing

import { parseOverrides, type ParsedOverrides } from "./overrides";

// Check if string is a command (starts with /)
export const isCommand = (text: string): boolean => {
  return text.trim().startsWith("/");
};

interface ParsedCommand {
  name: string;
  args: string;
}

// Parse command string into name + args
export const parseCommand = (text: string): ParsedCommand | null => {
  const trimmed = text.trim();

  if (!trimmed.startsWith("/")) return null;

  // Find command name (everything up to first space or end)
  const spaceIdx = trimmed.indexOf(" ");

  if (spaceIdx === -1) {
    // Just command, no args: "/mycommand"
    return { name: trimmed.slice(1), args: "" };
  }

  // Command with args: "/mycommand args here"
  return {
    name: trimmed.slice(1, spaceIdx),
    args: trimmed.slice(spaceIdx + 1).trim(),
  };
};

interface ParsedCommandWithOverrides {
  name: string;
  args: string;
  overrides: ParsedOverrides;
}

// Parse command with inline overrides
// "/mycommand {model:x} args" → { name, args, overrides }
export const parseCommandWithOverrides = (
  text: string
): ParsedCommandWithOverrides | null => {
  const parsed = parseCommand(text);
  if (!parsed) return null;

  // Check if args contain overrides
  const overrides = parseOverrides(parsed.args);

  return {
    name: parsed.name,
    args: overrides.remainder,
    overrides,
  };
};

// Extract just the command name from a command string
export const extractCommandName = (text: string): string | null => {
  const parsed = parseCommand(text);
  return parsed?.name ?? null;
};

// Check if text is a /subtask command
export const isSubtaskCommand = (text: string): boolean => {
  const name = extractCommandName(text);
  return name === "subtask";
};

// Parse /subtask command arguments
// Returns the parsed overrides and prompt text
export const parseSubtaskArgs = (
  args: string
): { overrides: ParsedOverrides; prompt: string } => {
  const overrides = parseOverrides(args);
  return {
    overrides,
    prompt: overrides.remainder,
  };
};

// Parse pipe-separated arguments for parallel commands
// "main args || pipe1 || pipe2" → ["main args", "pipe1", "pipe2"]
export const parsePipeArgs = (text: string): string[] => {
  return text.split(/\s*\|\|\s*/).map(s => s.trim());
};

// Check if command has pipe args
export const hasPipeArgs = (text: string): boolean => {
  return text.includes("||");
};
