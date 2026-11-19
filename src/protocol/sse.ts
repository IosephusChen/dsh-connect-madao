/**
 * SSE 翻译层：把码道上游的事件流转成 OpenAI 的 `data: {...}` chunk 序列。
 *
 * 上游实测是 ai-sdk 风格，事件名包含：
 *   text-delta / reasoning / message.part.updated / message.updated / session.idle
 *
 * 但码道在 OpenAI 兼容路径上实际返回的是 `data: {...}` 的 choices 增量，
 * 因此这里做「宽容解析」：优先识别 OpenAI 形状，其次识别 ai-sdk 形状。
 */

/**
 * 上游用量信息。
 *
 * **必须整体保留，不能只挑三个数字。**
 *
 * 踩过的坑：早期只提取 prompt/completion/total 三个字段，把
 * `prompt_tokens_details.cached_tokens` 和
 * `completion_tokens_details.reasoning_tokens` 整个丢掉了。
 * 结果 DSH 的 Token 用量面板永远显示「缓存命中 0%、缓存读取 0」，
 * 而实际上网关是**有前缀缓存**的 —— 实测同一个 1834 token 的请求，
 * 其中 1024 来自缓存（约 56%），只是这个数字没被转发上去。
 *
 * 缓存不仅影响显示，通常还影响计费（cached 部分按折扣价），
 * 所以这四个字段一个都不能少。
 */
export interface UsageInfo {
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
  /** 例：{ cached_tokens: 1024 } */
  prompt_tokens_details?: Record<string, unknown>
  /** 例：{ reasoning_tokens: 55 } */
  completion_tokens_details?: Record<string, unknown>
  /** 兼容其他实现可能用的平铺字段名 */
  [key: string]: unknown
}

export interface OpenAIDelta {
  role?: string
  content?: string
  reasoning_content?: string
  /**
   * 工具调用增量。上游按 index 分片下发，arguments 逐片累积，
   * 这里原样透传，由客户端（DSH）自己合并。
   *
   * 丢了它就等于丢了模型的全部实际操作意图 —— 表现是
   * `finish_reason: "tool_calls"` 但 content 为空，上层只看到
   * "有思考、没内容"，于是判定异常并中断。
   */
  tool_calls?: unknown[]
}

export interface OpenAIChunk {
  id: string
  object: 'chat.completion.chunk'
  created: number
  model: string
  choices: Array<{
    index: number
    delta: OpenAIDelta
    finish_reason: string | null
  }>
  usage?: UsageInfo
}

export function makeChunk(
  id: string,
  model: string,
  delta: OpenAIDelta,
  finishReason: string | null = null,
): OpenAIChunk {
  return {
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  }
}

export function sseLine(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`
}

export const SSE_DONE = 'data: [DONE]\n\n'

export interface ParsedEvent {
  /** 已提取的文本增量 */
  text?: string
  /** 已提取的推理增量 */
  reasoning?: string
  /** 工具调用增量（原样透传） */
  toolCalls?: unknown[]
  /** 结束原因 */
  finish?: string
  /** 用量 */
  usage?: UsageInfo
  /** 是否收到结束信号 */
  done?: boolean
  /**
   * 上游明确报错。
   *
   * 码道网关的错误**不是** OpenAI 的 `{error:{...}}` 形状，而是塞在
   * 一条看起来像结束帧的数据里：
   *
   *   {"text":"[DONE]","error_code":"InferHub.ModelArts.81001.400",
   *    "error_msg":"the content of image_url.url field is unsafe"}
   *
   * 早期解析层只认 `[DONE]`，把这条当成正常结束 —— 于是上层看到的是
   * "有完成信号但没内容"，最终报 EMPTY_RESPONSE，完全看不出是内容审核拦了。
   */
  error?: { code: string; message: string }
  /** 原始对象，供调试 */
  raw?: unknown
}

/**
 * 解析一条 SSE 事件（已去掉 `data: ` 前缀的 JSON 文本）。
 * 不认识的形状返回空对象，调用方应跳过。
 */
export function parseUpstreamEvent(data: string): ParsedEvent {
  const trimmed = data.trim()
  if (!trimmed) return {}
  if (trimmed === '[DONE]') return { done: true }

  let obj: any
  try {
    obj = JSON.parse(trimmed)
  } catch {
    return {}
  }

  const out: ParsedEvent = { raw: obj }
  // ── 网关自己的错误帧 ─────────────────────────────────────
  // 形状：{"text":"[DONE]","error_code":"...","error_msg":"..."}
  // 必须先于 OpenAI 形状判断：这种帧没有 choices，但带 text:"[DONE]"，
  // 若按结束处理就会把真实错误吞掉，上层只看到空响应。
  if (typeof obj.error_code === 'string' && obj.error_code) {
    return {
      raw: obj,
      error: { code: obj.error_code, message: String(obj.error_msg ?? obj.error_message ?? '') },
      done: true,
    }
  }
  if (obj.error && typeof obj.error === 'object' && !Array.isArray(obj.choices)) {
    return {
      raw: obj,
      error: { code: String(obj.error.code ?? obj.error.type ?? 'upstream_error'), message: String(obj.error.message ?? '') },
      done: true,
    }
  }


  // ── OpenAI 形状 ──────────────────────────────────────────
  if (Array.isArray(obj.choices)) {
    const out: ParsedEvent = { raw: obj }

    // usage 可能出现在 choices:[] 的独立帧里（码道就是这样发的）
    if (obj.usage) {
      // 整体保留，含 prompt_tokens_details.cached_tokens 等
      // —— 只挑三个数字会让上层永远看到「缓存 0%」
      out.usage = { ...obj.usage }
    }

    const ch = obj.choices[0]
    if (!ch) return out

    const d = ch.delta ?? ch.message ?? {}
    if (typeof d.content === 'string' && d.content) out.text = d.content
    if (typeof d.reasoning_content === 'string' && d.reasoning_content) {
      out.reasoning = d.reasoning_content
    }
    if (typeof d.reasoning === 'string' && d.reasoning) out.reasoning = d.reasoning
    // 工具调用必须原样带出去，否则调用意图整体丢失
    if (Array.isArray(d.tool_calls) && d.tool_calls.length > 0) out.toolCalls = d.tool_calls
    if (ch.finish_reason) out.finish = String(ch.finish_reason)
    return out
  }

  // ── ai-sdk 形状 ──────────────────────────────────────────
  const type = typeof obj.type === 'string' ? obj.type : ''

  if (type === 'text-delta' || type === 'text_delta') {
    out.text = obj.delta ?? obj.textDelta ?? obj.text ?? ''
    return out
  }
  if (type === 'reasoning' || type === 'reasoning-delta') {
    out.reasoning = obj.delta ?? obj.textDelta ?? obj.text ?? ''
    return out
  }
  if (type === 'finish' || type === 'finish-step') {
    out.finish = obj.finishReason ?? obj.finish_reason ?? 'stop'
    if (obj.usage) {
      // 同样整体保留：这里即便字段名是驼峰，也要把 details 带出去
      out.usage = {
        ...obj.usage,
        prompt_tokens: obj.usage.promptTokens ?? obj.usage.prompt_tokens ?? 0,
        completion_tokens: obj.usage.completionTokens ?? obj.usage.completion_tokens ?? 0,
        total_tokens: obj.usage.totalTokens ?? obj.usage.total_tokens ?? 0,
      }
    }
    return out
  }
  if (type === 'error') {
    out.finish = 'error'
    return out
  }
  if (type === 'message.part.updated') {
    const part = obj.part ?? obj.properties?.part ?? {}
    if (part.type === 'text' && typeof part.text === 'string') out.text = part.text
    if (part.type === 'reasoning' && typeof part.text === 'string') out.reasoning = part.text
    return out
  }

  return out
}

