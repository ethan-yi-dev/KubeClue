// src/agent.ts
// Agent loop: the core of this project is a while loop.
//
// Stream the LLM response, execute any tool calls, add their results to Context,
// and continue until the model stops calling tools or the run is interrupted.

// Import stream directly so readers can easily spot the LLM interaction.
// pi injects a StreamFn to support swapping backends; this tutorial omits that abstraction.

import {
  stream,
  buildAssistantMessage,
  buildToolResultMessage,
  type Model,
  type Context,
} from "./llm.js";

/** Tool definition: name, description, JSON Schema parameters, and execute function. */
export type AgentTool = {
  name: string;
  description: string;
  parameters: object; // JSON Schema
  execute: (args: unknown, signal?: AbortSignal) => Promise<string>;
};

/** Events emitted by the agent for the UI to consume. */
export type AgentEvent =
  | { type: "assistant_text"; delta: string }
  | { type: "tool_call"; id: string; name: string; args: unknown }
  | { type: "tool_result"; id: string; name: string; result: string }
  | {
      type: "turn_end";
      stopReason: "end_turn" | "max_tokens" | "aborted" | "error";
    };

/** Compact older messages when the conversation reaches this count. */
const COMPACT_THRESHOLD = 50;
/** Number of recent messages to keep after compaction. */
const KEEP_RECENT = 20;

/**
 * Ask the LLM to summarize older messages and replace them with the summary.
 * This demonstrates how an agent manages a limited context window.
 * Unlike pi's full implementation, this tutorial uses message count as a simple
 * approximation instead of estimating tokens or finding turn boundaries.
 */
async function compactContext(
  model: Model,
  context: Context,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) return; // Do not replace context with an empty summary after an abort.
  if (context.messages.length < COMPACT_THRESHOLD) return;

  const oldMessages = context.messages.slice(0, -KEEP_RECENT);
  const recentMessages = context.messages.slice(-KEEP_RECENT);

  // Serialize older messages as plain text for the LLM to summarize.
  const conversationText = oldMessages
    .map(
      (m) =>
        `${m.role}: ${typeof m.content === "string" ? m.content : JSON.stringify(m.content)}`,
    )
    .join("\n");

  // Request a summary without exposing tools to the model.
  const summaryContext: Context = {
    systemPrompt:
      "Summarize the following conversation as concise context. Preserve key decisions, completed work, and pending tasks.",
    messages: [{ role: "user", content: conversationText }],
  };

  let summary = "";
  let failed = false;
  for await (const ev of stream(model, summaryContext, { signal })) {
    if (ev.type === "text_delta") summary += ev.delta;
    else if (
      ev.type === "error" ||
      (ev.type === "done" && ev.stopReason === "aborted")
    ) {
      failed = true;
      break;
    }
  }

  // Keep the original messages if summarization fails or returns no text.
  if (failed || !summary) return;

  // Replace older messages with the summary and keep recent messages.
  context.messages = [
    { role: "user", content: `[context summary]\n${summary}` },
    ...recentMessages,
  ];
}

/**
 * Run the agent loop until the model stops calling tools. There is no max_steps limit.
 * pi also has no hardcoded step limit, but provides a shouldStopAfterTurn callback,
 * which this tutorial omits.
 *
 * @param model    Model configuration.
 * @param context  Conversation context (mutated in place).
 * @param tools    Tool registry.
 * @param signal   Abort signal.
 */

export async function* runAgent(
  model: Model,
  context: Context,
  tools: AgentTool[],
  signal?: AbortSignal,
): AsyncGenerator<AgentEvent> {
  const toolMap = new Map(tools.map((t) => [t.name, t]));
  const toolDefs = tools.map((t) => ({
    name: t.name,
    description: t.description,
    parameters: t.parameters,
  }));

  while (true) {
    // 0. Compact older messages before the next model request.
    await compactContext(model, context, signal);

    // 1. Stream the LLM response and collect text and tool calls.
    let text = "";
    let stopReason: "end_turn" | "tool_use" | "max_tokens" | "aborted" =
      "end_turn";
    const toolCalls: { id: string; name: string; args: unknown }[] = [];

    for await (const ev of stream(model, context, {
      tools: toolDefs,
      signal,
    })) {
      if (ev.type === "text_delta") {
        text += ev.delta;
        yield { type: "assistant_text", delta: ev.delta };
      } else if (ev.type === "tool_call") {
        toolCalls.push({ id: ev.id, name: ev.name, args: ev.args });
        yield { type: "tool_call", id: ev.id, name: ev.name, args: ev.args };
      } else if (ev.type === "done") {
        stopReason = ev.stopReason;
        if (ev.stopReason === "aborted") {
          // Drop tool calls on abort to avoid unmatched calls when the session resumes.
          context.messages.push(buildAssistantMessage(text, []));
          yield { type: "turn_end", stopReason: "aborted" };
          return;
        }
      } else if (ev.type === "error") {
        context.messages.push(buildAssistantMessage(text, []));
        yield {
          type: "assistant_text",
          delta: `\n[error] ${ev.error.message}`,
        };
        yield { type: "turn_end", stopReason: "error" };
        return;
      }
    }

    // 2. Add the assistant response to the context.
    context.messages.push(buildAssistantMessage(text, toolCalls));

    // 3. On truncation, do not execute potentially incomplete tool calls.
    // Return errors in the context so the model can retry.
    if (stopReason === "max_tokens" && toolCalls.length > 0) {
      const results = toolCalls.map((tc) => ({
        tool_use_id: tc.id,
        content: `error: output truncated by max_tokens, tool "${tc.name}" args may be incomplete.`,
      }));
      context.messages.push(buildToolResultMessage(results));
      for (let i = 0; i < toolCalls.length; i++) {
        yield {
          type: "tool_result",
          id: toolCalls[i].id,
          name: toolCalls[i].name,
          result: results[i].content,
        };
      }
      continue;
    }

    // 4. Stop when there are no tool calls.
    const reason = stopReason === "tool_use" ? "end_turn" : stopReason;
    if (toolCalls.length === 0) {
      yield { type: "turn_end", stopReason: reason };
      return;
    }

    // 5. Execute tool calls sequentially (pi supports both sequential and parallel modes).
    // This tutorial passes args to execute without validating them against parameters.
    // Production code should validate them first.
    const results: { tool_use_id: string; content: string }[] = [];
    for (const tc of toolCalls) {
      const tool = toolMap.get(tc.name);
      let result: string;
      if (!tool) {
        result = `error: tool "${tc.name}" not found`;
      } else {
        try {
          result = await tool.execute(tc.args, signal);
        } catch (e) {
          result = `error: ${(e as Error).message}`;
        }
      }
      results.push({ tool_use_id: tc.id, content: result });
      yield { type: "tool_result", id: tc.id, name: tc.name, result };
      if (signal?.aborted) break;
    }

    // 6. Add error results for calls skipped after an abort so every call has a result.
    for (const tc of toolCalls.slice(results.length)) {
      results.push({ tool_use_id: tc.id, content: "error: aborted" });
      yield {
        type: "tool_result",
        id: tc.id,
        name: tc.name,
        result: "error: aborted",
      };
    }

    // 7. Add tool results to Context and start the next iteration.
    context.messages.push(buildToolResultMessage(results));
  }
}
