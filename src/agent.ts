// src/agent.ts
// Agent loop: the core of this project is a while loop.
//
// Stream the LLM response, execute any tool calls, add their results to Context,
// and continue until the model stops calling tools or the run is interrupted.

/** Tool definition: name, description, JSON Schema parameters, and execute function. */
export type AgentTool = {
  name: string;
  description: string;
  parameters: object; // JSON Schema
  execute: (args: unknown, signal?: AbortSignal) => Promise<string>;
};

export async function* runAgent(
  model: Model,
  context: Context,
  tools: AgentTool[],
  signal?: AbortSignal,
): AsyncGenerator<AgentEvent> {
  while (true) {
    // 1. Stream the LLM response and collect text and tool calls.
    let text = "";
    const toolCalls: { id: string; name: string; args: unknown }[] = [];

    for await (const ev of stream(model, context, {
      tools: toolDefs,
      signal,
    })) {
    }

    // 2. Add the assistant response to the context.
    context.messages.push(buildAssistantMessage(text, toolCalls));

    // 4. Stop when there are no tool calls.
    if (toolCalls.length === 0) {
      return;
    }

    // 5. Execute tool calls sequentially (pi supports both sequential and parallel modes).
    // This tutorial passes args to execute without validating them against parameters.
    // Production code should validate them first.
    const results: { tool_use_id: string; content: string }[] = [];
    for (const tc of toolCalls) {
    }

    // 7. Add tool results to Context and start the next iteration.
    context.messages.push(buildToolResultMessage(results));
  }
}
