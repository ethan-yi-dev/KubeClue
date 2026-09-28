// src/llm.ts


// model configure
// gpt-xx  https://api.openai.com/v1
export type Model = {
    apiKey: string
    model: string
    baseUrl?: string
    maxTokens?: number
}


export type ContentBlock =
    | { type: 'text'; text: string }
    | { type: 'tool_use'; id: string; name: string; input: unknown }
    | { type: 'tool_result'; tool_use_id: string; content: string }


export type Message = {
    role: 'user' | 'assistant'
    content: string | ContentBlock[]
}


// Context
export type Context = {
    systemPrompt?: string
    messages: Message[]
}

// united flow output from llm
export type StreamEvent = 
  | { type: 'text_delta'; delta: string }
  | { type: 'tool_call'; id: string; name: string; args: unknown }
  | { type: 'done'; stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'aborted' }
  | { type: 'error'; error: Error }

// agent imported tool
export type ToolDef = {
    name: string
    description: string
    parameters: object
}
 
}
 
/** OpenAI SSE chunk 的最小类型 */
type OpenAIChunk = {
  choices: Array<{
    delta?: {
      content?: string
      tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }>
    }
    finish_reason?: string
  }>
}
 
/** 解析一行 SSE data，累积 tool_call，返回 text_delta 和 stop_reason */
function handleSSELine(
  data: string,
  toolCallBuffers: Map<number, { id: string; name: string; argsBuf: string }>,
): { textDelta: string | null; stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | null } {
  let chunk: OpenAIChunk
  try { chunk = JSON.parse(data) as OpenAIChunk } catch { return { textDelta: null, stopReason: null } }
 
  const choice = chunk.choices[0]
  if (!choice) return { textDelta: null, stopReason: null }
 
  let textDelta: string | null = null
  let stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | null = null
 
  if (choice.delta?.content) textDelta = choice.delta.content
 
  // tool_call delta：based on index to accumulate partial JSON of name + arguments
  if (choice.delta?.tool_calls) {
    for (const tc of choice.delta.tool_calls) {
      const idx = tc.index ?? 0
      if (!toolCallBuffers.has(idx)) {
        toolCallBuffers.set(idx, { id: tc.id ?? `call_${idx}`, name: '', argsBuf: '' })
      }
      const entry = toolCallBuffers.get(idx)!
      if (tc.id) entry.id = tc.id
      if (tc.function?.name) entry.name = tc.function.name
      if (tc.function?.arguments) entry.argsBuf += tc.function.arguments
    }
  }
 
  // finish_reason 映射：tool_calls → tool_use，length → max_tokens，stop → end_turn（默认值）
  if (choice.finish_reason === 'tool_calls') stopReason = 'tool_use'
  else if (choice.finish_reason === 'length') stopReason = 'max_tokens'
 
  return { textDelta, stopReason }
} 



// ==== stream function ====
 
/**
 * call OpenAI Completions API（streaming），Return a unified event stream.
 *
 * @param model    model configure
 * @param context  context messages[]
 * @param opts     tools + abort signal
 */

export async function* stream(
  model: Model,
  context: Context,
  opts: { tools?: ToolDef[]; signal?: AbortSignal } = {},
): AsyncGenerator<StreamEvent> {
  const url = `${model.baseUrl ?? 'https://api.openai.com/v1'}/chat/completions`
//   Construct the message in the format required by the API.
  const messages = contextToOpenAIMessages(context)
 
  const body: Record<string, unknown> = { model: model.model, stream: true, messages }
  if (model.maxTokens) body.max_tokens = model.maxTokens
  if (opts.tools?.length) {
    body.tools = opts.tools.map(t => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }))
  }
 
  // send request
  let response: Response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${model.apiKey}` },
      body: JSON.stringify(body),
      signal: opts.signal,
    })
  } catch (e) {
    if (opts.signal?.aborted) { yield { type: 'done', stopReason: 'aborted' }; return }
    yield { type: 'error', error: e as Error }; return
  }
 
  if (!response.ok || !response.body) {
    const text = await response.text().catch(() => 'unknown error')
    yield { type: 'error', error: new Error(`API ${response.status}: ${text}`) }; return
  }