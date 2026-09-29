// src/tui.ts
// Minimal terminal UI: single-line input, streaming output, and Ctrl+C interruption.
// No differential renderer, component tree, or Markdown rendering.
// Those belong in a terminal UI framework, not in the core of this agent tutorial.
 
import * as readline from 'readline'
 
export class Tui {
  private rl: readline.Interface | null = null
  private onPromptCb: ((text: string) => void) | null = null
  private onAbortCb: (() => void) | null = null
  private aborted = false
  private busy = false  // True while the agent is running; prevents concurrent input.
 
  /** Register a prompt callback. */
  onPrompt(cb: (text: string) => void): void {
    this.onPromptCb = cb
  }
 
  /** Register a Ctrl+C callback. */
  onAbort(cb: () => void): void {
    this.onAbortCb = cb
  }
 
  /** Start the TUI and begin reading input. */
  start(): void {
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    })
    process.stdin.on('keypress', (_ch: string, key: { ctrl?: boolean; name?: string } | undefined) => {
      // Handle Ctrl+C only while the agent is running; otherwise let readline handle it.
      if (this.busy && key?.ctrl && key?.name === 'c' && !this.aborted) {
        this.aborted = true
        this.onAbortCb?.()
      }
    })
 
    this.prompt()
  }
  private prompt(): void {
    if (!this.rl) return
    if (this.busy) return  // Do not show a prompt while the agent is running.
    this.aborted = false
    this.rl.question('> ', (answer) => {
      const text = answer.trim()
      if (text) {
        this.onPromptCb?.(text)
        // Wait for setBusy(false) before showing the next prompt.
      } else {
        this.prompt()  // Prompt again on empty input without invoking the callback.
      }
    })
  }
 
  /** Mark the agent as running to prevent new input. */
  setBusy(busy: boolean): void {
    this.busy = busy
    if (!busy) this.prompt()  // Resume input when the agent finishes.
  }
 
  /** Print a streamed assistant text delta. */
  printText(delta: string): void {
    process.stdout.write(delta)
  }
 
  /** Print a tool call. */
  printToolCall(name: string, args: unknown): void {
    process.stdout.write(`\n[tool: ${name}] ${JSON.stringify(args)}\n`)
  }
 
  /** Print a tool result. */
  printToolResult(name: string, result: string): void {
    process.stdout.write(`[result: ${name}] ${result}\n`)
  }
 
  /** End the turn with a newline. */
  printTurnEnd(): void {
    process.stdout.write('\n')
  }
 
  /** Stop the TUI and clean up listeners. */
  stop(): void {
    this.rl?.close()
    this.rl = null
    process.stdin.removeAllListeners('keypress')
  }
}
