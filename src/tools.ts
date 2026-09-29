// src/tools.ts
// Four built-in tools: read, write, and edit files, and run commands.
// Each tool is a pure function: async (args) => string, with no agent state.
// Note: this tutorial does not validate args. Production agents should validate
// them against parameters before calling execute.

import { promises as fs } from "node:fs";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import * as path from "node:path";
import * as os from "node:os";
import type { AgentTool } from "./agent.js";

const execAsync = promisify(exec);

/** Maximum tool output length in lines; longer output is truncated from the front. */
const MAX_OUTPUT_LINES = 200;

let truncateCounter = 0;

/**
 * Keep only the last maxLines lines and save the full output to a temporary file.
 * The end is prioritized because error messages usually appear there.
 */
async function truncateOutput(
  content: string,
  maxLines = MAX_OUTPUT_LINES,
): Promise<string> {
  const lines = content.split("\n");
  if (lines.length <= maxLines) return content;
  const kept = lines.slice(-maxLines).join("\n");
  const tmpPath = path.join(
    os.tmpdir(),
    `minipi-output-${process.pid}-${truncateCounter++}.txt`,
  );
  await fs.writeFile(tmpPath, content, "utf-8");
  return `[output truncated: showing last ${maxLines} of ${lines.length} lines. full output: ${tmpPath}]\n${kept}`;
}

/** read_file: return file contents, truncating long output to its last lines. */
const readFile: AgentTool = {
  name: "read_file",
  description: "Read a file. Argument: path (file path). Large files are truncated to the last 200 lines.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path of the file to read" },
    },
    required: ["path"],
  },
  execute: async (args) => {
    const { path: filePath } = args as { path: string };
    const content = await fs.readFile(filePath, "utf-8");
    return await truncateOutput(content);
  },
};

/** write_file: write a file, overwriting any existing contents. */
const writeFile: AgentTool = {
  name: "write_file",
  description: "Write a file, overwriting it if it exists. Arguments: path and content.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path of the file to write" },
      content: { type: "string", description: "File contents" },
    },
    required: ["path", "content"],
  },
  execute: async (args) => {
    const { path: filePath, content } = args as {
      path: string;
      content: string;
    };
    await fs.mkdir(path.dirname(filePath) || ".", { recursive: true });
    await fs.writeFile(filePath, content, "utf-8");
    return `wrote ${filePath} (${content.length} chars)`;
  },
};

/** edit: replace one exact, unique string match. */
const edit: AgentTool = {
  name: "edit",
  description:
    "Edit a file by replacing one exact string match. Arguments: path, old_string, and new_string. old_string must match exactly once.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path" },
      old_string: {
        type: "string",
        description: "Text to replace (must match exactly once)",
      },
      new_string: { type: "string", description: "Replacement text" },
    },
    required: ["path", "old_string", "new_string"],
  },
  execute: async (args) => {
    const {
      path: filePath,
      old_string,
      new_string,
    } = args as { path: string; old_string: string; new_string: string };
    const content = await fs.readFile(filePath, "utf-8");
    const count = content.split(old_string).length - 1;
    if (count === 0) throw new Error(`old_string not found in ${filePath}`);
    if (count > 1)
      throw new Error(
        `old_string matches ${count} places in ${filePath}, must be unique`,
      );
    // Use a function so String.replace does not interpret $ tokens in new_string.
    const newContent = content.replace(old_string, () => new_string);
    await fs.writeFile(filePath, newContent, "utf-8");
    return `edited ${filePath}: replaced ${old_string.length} chars`;
  },
};

/** run_bash: run a shell command, truncating long output to its last lines. */
const runBash: AgentTool = {
  name: "run_bash",
  description:
    "Run a shell command. Argument: command. Return stdout and stderr, truncated to the last 200 lines if needed.",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "Shell command to run" },
    },
    required: ["command"],
  },
  execute: async (args, signal) => {
    const { command } = args as { command: string };
    try {
      const { stdout, stderr } = await execAsync(command, {
        maxBuffer: 1024 * 1024,
        timeout: 30000,
        signal,
      });
      const output = stderr ? `[stderr] ${stderr}\n[stdout] ${stdout}` : stdout;
      return await truncateOutput(output);
    } catch (e: unknown) {
      if (signal?.aborted) return "aborted";
      const err = e as NodeJS.ErrnoException & {
        code?: number;
        stdout?: string;
        stderr?: string;
      };
      return `[exit ${err.code}] ${err.stderr ?? ""}${err.stdout ?? ""}`;
    }
  },
};

/** Return all built-in tools. */
export function builtinTools(): AgentTool[] {
  return [readFile, writeFile, edit, runBash];
}
