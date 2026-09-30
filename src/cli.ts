// src/cli.ts
// Entry point that wires together the LLM, agent, TUI, and tools.
// Session persistence: append new messages to ~/.minipi/session.jsonl after each turn.

import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { pathToFileURL } from 'node:url'
import { runAgent } from './agent.js'
import { Tui } from './tui.js'
import { k8sTools } from './k8s-tools.js'
import type { Model, Context, Message } from './llm.js'

const SESSION_DIR = path.join(os.homedir(), '.minipi')
const SESSION_FILE = path.join(SESSION_DIR, 'session.jsonl')

/** Fixed system prompt. */
const SYSTEM_PROMPT = `You are a read-only Kubernetes SRE check agent for the sre-lab cluster. Use the dedicated check tools when the user asks about cluster health, Services, DNS, or connectivity. Start with the most relevant check, run more checks when needed, and explain the observed evidence in plain language. Distinguish confirmed findings from possible causes. A failing check does not by itself prove a particular root cause. Report the check name and important failures. If kubectl, Bash, Python, or the cluster is unavailable, explain that the result is inconclusive rather than calling the cluster unhealthy. Do not claim to have checked the cluster if tools were unavailable. You cannot modify cluster resources.`

// Track the number of persisted messages so only new ones are appended.
// This is CLI process state; the agent keeps its state in the context.
let persistedCount = 0

async function main() {
  const apiKey = process.env.MINIPI_API_KEY
  if (!apiKey) {
    console.error('Please set the MINIPI_API_KEY environment variable')
    process.exit(1)
  }

  const model: Model = {
    apiKey,
    model: process.env.MINIPI_MODEL ?? 'gpt-4.1-mini',
    baseUrl: process.env.MINIPI_BASE_URL ?? 'https://api.openai.com/v1',
    maxTokens: 4096,
  }

  // Initialize the context with a separate system prompt and saved messages.
  const context: Context = {
    systemPrompt: SYSTEM_PROMPT,
    messages: await loadSession(),
  }

  const tools = k8sTools()
  const tui = new Tui()

  // Each turn: accept input, run the agent, forward events to the TUI, and save the session.
  tui.onPrompt(async (text) => {
    try {
      context.messages.push({ role: 'user', content: text })

      tui.setBusy(true)
      const ctrl = new AbortController()
      tui.onAbort(() => ctrl.abort())  // Point the abort callback to this turn's controller.

      for await (const ev of runAgent(model, context, tools, ctrl.signal)) {
        switch (ev.type) {
          case 'assistant_text': tui.printText(ev.delta); break
          case 'tool_call': tui.printToolCall(ev.name, ev.args); break
          case 'tool_result': tui.printToolResult(ev.name, ev.result); break
          case 'turn_end':
            if (ev.stopReason === 'max_tokens') tui.printText('\n[output truncated by max_tokens]')
            if (ev.stopReason === 'error') tui.printText('\n[error occurred]')
            tui.printTurnEnd()
            break
        }
      }

      await persistSession(context.messages)
    } catch (e) {
      console.error(`\n[error] ${(e as Error).message}`)
    } finally {
      tui.setBusy(false)
    }
  })

  tui.start()

}

/** Load saved messages at startup to resume the conversation (exported for tests). */
export async function loadSession(file: string = SESSION_FILE): Promise<Message[]> {
  try {
    const data = await fs.readFile(file, 'utf-8')
    const lines = data.trim().split('\n').filter(Boolean)
    // Skip malformed lines instead of discarding all history after a partial write.
    const messages = lines.flatMap(line => {
      try { return [JSON.parse(line) as Message] } catch { return [] }
    })
    persistedCount = messages.length  // Do not write loaded messages again.
    return messages
  } catch {
    return []  // Start with an empty session if the file does not exist.
  }
}

/** Append new messages to the session file (exported for tests). */
export async function persistSession(messages: Message[], file: string = SESSION_FILE): Promise<void> {
  await fs.mkdir(path.dirname(file) || '.', { recursive: true })
  const newMessages = messages.slice(persistedCount)
  for (const msg of newMessages) {
    await fs.appendFile(file, JSON.stringify(msg) + '\n', 'utf-8')
  }
  persistedCount = messages.length
}

// Start only when this module is run directly, not when it is imported.
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((e) => {
    console.error(e)
    process.exit(1)
  })
}
