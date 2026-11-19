import { loadCredentials } from './src/credentials.ts'
import { StsProvider } from './src/sts-provider.ts'
import { MadaoClient } from './src/client.ts'

const loaded = await loadCredentials()
const creds = loaded.key.securityToken
  ? { ak: loaded.key.ak, sk: loaded.key.sk, securityToken: loaded.key.securityToken, expiresAt: loaded.key.expiresAt ?? Date.now()+3600_000 }
  : await new StsProvider({ ak: loaded.key.ak, sk: loaded.key.sk }).credentials()
const client = new MadaoClient({ credentials: creds as any })

async function run(label: string, payload: any): Promise<{ ok: boolean; note: string }> {
  try {
    const stream = await client.chatStream(payload)
    const reader = (stream as ReadableStream<Uint8Array>).getReader()
    const dec = new TextDecoder(); let buf = ''
    let text = '', err = '', finish = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buf += dec.decode(value, { stream: true })
      const lines = buf.split('\n'); buf = lines.pop() ?? ''
      for (const line of lines) {
        const t = line.trim(); if (!t.startsWith('data:')) continue
        const d = t.slice(5).trim(); if (!d || d === '[DONE]') continue
        try {
          const ev = JSON.parse(d)
          if (ev.error_code) { err = ev.error_code + ' | ' + String(ev.error_msg ?? '').slice(0, 90); continue }
          const de = ev?.choices?.[0]?.delta ?? {}
          if (de.content) text += de.content
          if (ev?.choices?.[0]?.finish_reason) finish = ev.choices[0].finish_reason
        } catch {}
      }
    }
    if (err) return { ok: false, note: err }
    return { ok: !!text, note: text ? 'content=' + text.length + ' finish=' + finish : '空 finish=' + finish }
  } catch (e: any) {
    return { ok: false, note: String(e?.message ?? e).slice(0, 110) }
  }
}

// 造一个超大请求测试
const bigText = '这是一段用于测试的真实中文内容，用来撑大请求体积。'.repeat(3000)  // ~9万字符
const img = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAHUlEQVQoU2NkYGD4z0AEYBxVSFhQUABhAQAyywQBsMBFwwAAAABJRU5ErkJggg=='
const manyTools = Array.from({ length: 200 }, (_, i) => ({
  type: 'function',
  function: { name: 'tool_' + i, description: '测试工具 ' + i + ' 用于撑大请求', parameters: { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] } },
}))

console.log('=== 分项测试，定位哪个参数导致 invalid ===')
const cases: Array<[string, any]> = [
  ['纯文本大请求', { model: 'deepseek-v4.1-flash-1017', messages: [{ role: 'user', content: bigText }], stream: true, max_tokens: 500 }],
  ['带图片', { model: 'deepseek-v4.1-flash-1017', messages: [{ role: 'user', content: [{ type: 'text', text: '看图' }, { type: 'image_url', image_url: { url: img } }] }], stream: true, max_tokens: 500 }],
  ['带200工具', { model: 'deepseek-v4.1-flash-1017', messages: [{ role: 'user', content: 'hi' }], stream: true, max_tokens: 500, tools: manyTools }],
  ['reasoning_effort=high', { model: 'deepseek-v4.1-flash-1017', messages: [{ role: 'user', content: 'hi' }], stream: true, max_tokens: 500, reasoning_effort: 'high' }],
  ['max_tokens=65536', { model: 'deepseek-v4.1-flash-1017', messages: [{ role: 'user', content: 'hi' }], stream: true, max_tokens: 65536 }],
]
for (const [label, p] of cases) {
  const r = await run(label, p)
  console.log('  ' + (r.ok ? '✓' : '✗') + ' ' + label.padEnd(22) + ' ' + r.note)
  await new Promise(res => setTimeout(res, 2500))
}
