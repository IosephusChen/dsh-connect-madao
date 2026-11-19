/**
 * 协议适配层回归测试。
 *
 * 这里每一条都对应一个**真实踩过的 bug**，不是想象出来的边界。
 * 变红就说明某次改动把已修好的问题又改回去了。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { hasUnsupportedContent, normalizeContent } from '../src/protocol/body.ts'
import { parseUpstreamEvent } from '../src/protocol/sse.ts'

// ── normalizeContent：图片必须保留 ─────────────────────────────
// 踩过的坑：原实现对非 text part 一律丢成空串，导致图片永远发不出去。
// 实测网关要的是标准 OpenAI image_url（用 8×8 纯蓝 PNG 验证过）。

test('normalizeContent: 纯文本数组折叠成字符串', () => {
  const got = normalizeContent([
    { type: 'text', text: '你好' },
    { type: 'text', text: '，世界' },
  ])
  assert.equal(got, '你好，世界')
})

test('normalizeContent: 字符串原样返回', () => {
  assert.equal(normalizeContent('直接给字符串'), '直接给字符串')
})

test('normalizeContent: 保留 image_url，不能丢', () => {
  const url = 'data:image/png;base64,iVBORw0KGgo='
  const got = normalizeContent([
    { type: 'text', text: '这是什么颜色' },
    { type: 'image_url', image_url: { url } },
  ])
  assert.ok(Array.isArray(got), '有图时应返回数组而不是字符串')
  const parts = got as any[]
  assert.equal(parts.length, 2)
  assert.equal(parts[0].type, 'text')
  assert.equal(parts[1].type, 'image_url')
  assert.equal(parts[1].image_url.url, url)
})

test('normalizeContent: image_url 里的额外字段被裁掉，只留 url', () => {
  const got = normalizeContent([
    { type: 'image_url', image_url: { url: 'data:image/png;base64,AA', detail: 'high' } },
  ]) as any[]
  assert.deepEqual(got[0].image_url, { url: 'data:image/png;base64,AA' })
})

test('normalizeContent: 未知 part 丢弃', () => {
  const got = normalizeContent([
    { type: 'text', text: 'hi' },
    { type: 'audio_url', url: 'x' },
  ])
  // 只剩 text，所以折叠成字符串
  assert.equal(got, 'hi')
})

test('normalizeContent: 空数组返回空字符串', () => {
  assert.equal(normalizeContent([]), '')
})

// ── 单个 part 对象：不能静默丢弃 ──────────────────────────────
// 踩过的坑：DSH 会产出 content 为单个对象的 assistant 消息（日志显示 assistant:object），
// 早期实现走 `if (!Array.isArray(content)) return ''`，把整段内容清空。
// 实测 content:null 原样发给网关会让它返回空响应（有 usage 但无内容），
// 而 content:"" 正常 —— 所以 null→"" 是对的，但 object 必须解析出来。

test('normalizeContent: null 转成空字符串（不能透传 null）', () => {
  assert.equal(normalizeContent(null), '')
  assert.equal(normalizeContent(undefined), '')
})

test('normalizeContent: 单个 text part 对象要提取文本', () => {
  const got = normalizeContent({ type: 'text', text: '对象形式的文本' })
  assert.equal(got, '对象形式的文本')
})

test('normalizeContent: 单个 image_url part 对象要保留', () => {
  const got = normalizeContent({ type: 'image_url', image_url: { url: 'data:image/png;base64,BB' } })
  assert.ok(Array.isArray(got))
  assert.equal((got as any[])[0].type, 'image_url')
})

test('normalizeContent: 不认识的 object 序列化兜底，不丢内容', () => {
  const got = normalizeContent({ foo: 'bar' })
  assert.equal(typeof got, 'string')
  assert.ok((got as string).includes('foo'))
})

// ── hasUnsupportedContent：只拒绝网关不认的类型 ────────────────

test('hasUnsupportedContent: text 与 image_url 都算支持', () => {
  const msgs: any = [
    {
      role: 'user',
      content: [
        { type: 'text', text: 'hi' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AA' } },
      ],
    },
  ]
  assert.equal(hasUnsupportedContent(msgs), null)
})

test('hasUnsupportedContent: 音频要报出来', () => {
  const msgs: any = [{ role: 'user', content: [{ type: 'audio_url', url: 'x' }] }]
  assert.equal(hasUnsupportedContent(msgs), 'audio_url')
})

test('hasUnsupportedContent: 纯字符串 content 不报', () => {
  const msgs: any = [{ role: 'user', content: '普通文本' }]
  assert.equal(hasUnsupportedContent(msgs), null)
})

// ── parseUpstreamEvent：tool_calls 必须透传 ────────────────────
// 踩过的坑：解析层没有 tool_calls 字段，工具调用帧整个丢失，
// 表现成「finish_reason=tool_calls 但 content 为空」，客户端判异常并中断。

test('parseUpstreamEvent: 提取 tool_calls 首帧（id + name）', () => {
  const ev = parseUpstreamEvent(
    JSON.stringify({
      choices: [
        {
          delta: {
            tool_calls: [
              { id: 'call_abc', type: 'function', index: 0, function: { name: 'get_weather', arguments: '' } },
            ],
          },
          finish_reason: null,
        },
      ],
    }),
  )
  assert.ok(ev.toolCalls, 'tool_calls 必须被提取出来')
  const tc = (ev.toolCalls as any[])[0]
  assert.equal(tc.id, 'call_abc')
  assert.equal(tc.function.name, 'get_weather')
})

test('parseUpstreamEvent: 提取 tool_calls 参数分片', () => {
  const ev = parseUpstreamEvent(
    JSON.stringify({
      choices: [
        { delta: { tool_calls: [{ index: 0, function: { arguments: '{"city": "北京"}' } }] }, finish_reason: null },
      ],
    }),
  )
  assert.ok(ev.toolCalls)
  assert.equal((ev.toolCalls as any[])[0].function.arguments, '{"city": "北京"}')
})

test('parseUpstreamEvent: finish_reason=tool_calls 被保留', () => {
  const ev = parseUpstreamEvent(
    JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
  )
  assert.equal(ev.finish, 'tool_calls')
})

test('parseUpstreamEvent: 普通文本帧仍正常', () => {
  const ev = parseUpstreamEvent(
    JSON.stringify({ choices: [{ delta: { content: 'hello' }, finish_reason: null }] }),
  )
  assert.equal(ev.text, 'hello')
})

test('parseUpstreamEvent: reasoning_content 被提取', () => {
  const ev = parseUpstreamEvent(
    JSON.stringify({ choices: [{ delta: { reasoning_content: '想一想' }, finish_reason: null }] }),
  )
  assert.equal(ev.reasoning, '想一想')
})

test('parseUpstreamEvent: [DONE] 标记为结束', () => {
  const ev = parseUpstreamEvent('[DONE]')
  assert.equal(ev.done, true)
})

test('parseUpstreamEvent: choices:[] 的独立 usage 帧', () => {
  const ev = parseUpstreamEvent(
    JSON.stringify({
      choices: [],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }),
  )
  assert.deepEqual(ev.usage, { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 })
})

test('parseUpstreamEvent: 非法 JSON 不抛错', () => {
  const ev = parseUpstreamEvent('{不是 json')
  assert.deepEqual(ev, {})
})

// ── 网关错误帧必须被识别 ─────────────────────────────────────
// 踩过的坑：码道的错误不是 OpenAI 的 {error:{...}}，而是塞在一条看似结束的帧里：
//   {"text":"[DONE]","error_code":"InferHub.ModelArts.81001.400",
//    "error_msg":"the content of image_url.url field is unsafe"}
// 早期只认 [DONE]，把真实错误当正常结束吞掉，上层只看到 EMPTY_RESPONSE。

test('parseUpstreamEvent: 识别网关的 error_code 帧', () => {
  const ev = parseUpstreamEvent(
    JSON.stringify({
      text: '[DONE]',
      error_code: 'InferHub.ModelArts.81001.400',
      error_msg: 'the content of image_url.url field is unsafe',
    }),
  )
  assert.ok(ev.error, '必须提取出 error')
  assert.equal(ev.error!.code, 'InferHub.ModelArts.81001.400')
  assert.equal(ev.error!.message, 'the content of image_url.url field is unsafe')
  assert.equal(ev.done, true)
})

test('parseUpstreamEvent: 识别 OpenAI 形状的 error 帧', () => {
  const ev = parseUpstreamEvent(
    JSON.stringify({ error: { code: 'rate_limit', message: 'too many requests' } }),
  )
  assert.ok(ev.error)
  assert.equal(ev.error!.code, 'rate_limit')
  assert.equal(ev.error!.message, 'too many requests')
})

test('parseUpstreamEvent: 正常帧不应被误判成错误', () => {
  const ev = parseUpstreamEvent(
    JSON.stringify({ choices: [{ delta: { content: 'hello' }, finish_reason: null }] }),
  )
  assert.equal(ev.error, undefined)
  assert.equal(ev.text, 'hello')
})
