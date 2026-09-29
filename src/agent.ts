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
      }
    }

    // 2. Add the assistant response to the context.
    context.messages.push(buildAssistantMessage(text, toolCalls));

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
    }

    // 7. Add tool results to Context and start the next iteration.
    context.messages.push(buildToolResultMessage(results));
  }
}
