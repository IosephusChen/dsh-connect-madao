/**
 * 对话/诊断日志。
 *
 * 只记元数据，不记消息内容。
 *
 * 空响应（`EMPTY_RESPONSE`）这类问题，光看 DSH 的报错完全定位不了：
 * 可能是显示名没还原、max_tokens 太小、或者上游限流。把实际发出去的
 * model / 强度 / 预算记下来，下次一眼就能看出是哪一类。
 *
 * 单独成模块是因为 server.ts 和 checkin.ts 都要写同一个文件 ——
 * 两个文件各自 append 同一个 log 会互相交错，也没法统一格式。
 */

import { appendFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 日志目录：%USERPROFILE%\.dsh-connect-madao */
export function logDir(): string {
  return join(homedir(), '.dsh-connect-madao')
}

export function chatLog(line: string): void {
  try {
    const dir = logDir()
    mkdirSync(dir, { recursive: true })
    appendFileSync(join(dir, 'chat.log'), `${new Date().toISOString()} ${line}\n`, 'utf8')
  } catch {}
}