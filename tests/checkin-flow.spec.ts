/**
 * 领取流程的分支顺序回归测试（用伪 client，不打网络）。
 *
 * 为什么要这个：confirm 这条路径在真实环境里**很难复现** ——
 * 它只在「活动刚好处于 ELIGIBLE」时触发，而一天只有一次机会。
 * 等靠真实环境验证等于靠运气。这里用伪 client 把顺序钉死：
 *
 *   1. AUTO_GRANT            → 跳过，绝不 claim
 *   2. status=CLAIMED        → 只补 confirm，不重复 claim
 *   3. 非签到类（认证/报名） → 跳过，不替用户报名
 *   4. claimable 但非 ELIGIBLE → 跳过
 *   5. ELIGIBLE + 签到类     → claim **然后** confirm（顺序不能反）
 *
 * 第 5 条的顺序是关键：先 claim 再 confirm。反过来 confirm 一个还没
 * 领的活动，因为上游 confirm 不校验状态机（实测 code=0），会静默成功，
 * 把「没领到」伪装成「已到账」。
 *
 * 另外钉死 confirm 的 body 形状：**只有 campaignId**。
 * 多带 channel 会 HTTP 400 HDN.1000（2026-11-20 实测）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { claimAllCheckins, claimCheckin, confirmClaim, queryCheckin, DAILY_CHECKIN_CAMPAIGN } from '../src/checkin.ts'

/** 伪 client：记录所有调用，按预设返回。 */
function fakeClient(items: any[], opts: { claimCode?: number; claimMessage?: string; confirmCode?: number; confirmThrows?: boolean } = {}) {
  const calls: Array<{ kind: 'get' | 'post'; path: string; body?: any }> = []
  const client = {
    async getJson(path: string) {
      calls.push({ kind: 'get', path })
      if (path.startsWith('/v1/ops/delivery')) return { code: 0, data: { items } }
      return {}
    },
    async postJson(path: string, body: any) {
      calls.push({ kind: 'post', path, body })
      if (path === '/v1/ops/confirm') {
        if (opts.confirmThrows) throw new Error('boom')
        return { code: opts.confirmCode ?? 0, message: 'ok', data: { status: 'CONFIRMED', totalAmount: 100 } }
      }
      return { code: opts.claimCode ?? 0, message: opts.claimMessage ?? 'ok', data: { status: 'CLAIMED', totalAmount: 100 } }
    },
  } as any
  return { client, calls }
}

const posts = (calls: any[]) => calls.filter((c) => c.kind === 'post')
const paths = (calls: any[]) => posts(calls).map((c) => c.path)

test('ELIGIBLE 的签到类：先 claim 再 confirm，顺序不能反', async () => {
  const { client, calls } = fakeClient([
    { campaignId: 40, title: 'Skill创新赛每日签到礼', type: 'USER_LOGIN', extra: { triggerEvent: 'user.login', triggerMode: 'MANUAL_CLAIM' }, status: 'ELIGIBLE', claimable: true, benefitAmount: 1000 },
  ])
  const r = await claimAllCheckins(client)

  assert.deepEqual(paths(calls), ['/v1/ops/claim', '/v1/ops/confirm'])
  assert.equal(r.claimed.length, 1)
  assert.equal(r.claimed[0].campaignId, 40)
  assert.equal(r.claimed[0].amount, 100)
  assert.equal(r.claimed[0].confirmed, true)
})

test('claim 的 body 带 idempotentKey + channel；confirm 的 body 只有 campaignId', async () => {
  const { client, calls } = fakeClient([
    { campaignId: 34, title: '每日签到领100积分', type: 'USER_LOGIN', extra: { triggerEvent: 'user.login' }, status: 'ELIGIBLE', claimable: true },
  ])
  await claimAllCheckins(client)

  const [claimCall, confirmCall] = posts(calls)
  assert.equal(claimCall.path, '/v1/ops/claim')
  assert.equal(claimCall.body.campaignId, 34)
  assert.equal(claimCall.body.channel, 'IDE')
  assert.ok(typeof claimCall.body.idempotentKey === 'string' && claimCall.body.idempotentKey.length > 0)

  assert.equal(confirmCall.path, '/v1/ops/confirm')
  // 关键：只有 campaignId。多一个字段就是 400 HDN.1000
  assert.deepEqual(Object.keys(confirmCall.body), ['campaignId'])
  assert.equal(confirmCall.body.campaignId, 34)
})

test('status=CLAIMED 只补 confirm，不重复 claim', async () => {
  const { client, calls } = fakeClient([
    { campaignId: 34, title: '每日签到领100积分', type: 'USER_LOGIN', extra: { triggerEvent: 'user.login' }, status: 'CLAIMED', claimable: false },
  ])
  const r = await claimAllCheckins(client)

  assert.deepEqual(paths(calls), ['/v1/ops/confirm'])
  assert.equal(r.claimed.length, 0)
  assert.match(r.skipped[0].reason, /已补确认/)
})

test('AUTO_GRANT 不领（去 claim 反而错）', async () => {
  const { client, calls } = fakeClient([
    { campaignId: 4, title: '新用户注册送 4000 积分', type: 'NEW_USER_REGISTER', extra: { triggerEvent: 'user.register', triggerMode: 'AUTO_GRANT' }, status: 'ELIGIBLE', claimable: true },
  ])
  const r = await claimAllCheckins(client)
  assert.deepEqual(paths(calls), [])
  assert.equal(r.skipped[0].reason, '自动发放，无需领取')
})

test('学生认证不领 —— 不替用户做认证', async () => {
  const { client, calls } = fakeClient([
    { campaignId: 2, title: '学生认证领积分', type: 'STUDENT_CERTIFIED', extra: { triggerEvent: 'student.certified', triggerMode: 'MANUAL_CLAIM' }, status: 'ELIGIBLE', claimable: true },
  ])
  const r = await claimAllCheckins(client)
  assert.deepEqual(paths(calls), [])
  assert.match(r.skipped[0].reason, /非签到类活动/)
})

test('claimable=false 的签到类不领', async () => {
  const { client, calls } = fakeClient([
    { campaignId: 34, title: '每日签到领100积分', type: 'USER_LOGIN', extra: { triggerEvent: 'user.login' }, status: 'ELIGIBLE', claimable: false },
  ])
  const r = await claimAllCheckins(client)
  assert.deepEqual(paths(calls), [])
  assert.match(r.skipped[0].reason, /当前不可领/)
})

test('CONSUMED 不领，也不补 confirm（否则可能把已用掉的状态改回去）', async () => {
  const { client, calls } = fakeClient([
    { campaignId: 34, title: '每日签到领100积分', type: 'USER_LOGIN', extra: { triggerEvent: 'user.login' }, status: 'CONSUMED', claimable: false },
  ])
  const r = await claimAllCheckins(client)
  assert.deepEqual(paths(calls), [])
  assert.match(r.skipped[0].reason, /CONSUMED/)
})

test('confirm 失败不影响「已领取」的判定（积分 claim 时已到账）', async () => {
  const { client } = fakeClient(
    [{ campaignId: 34, title: '每日签到领100积分', type: 'USER_LOGIN', extra: { triggerEvent: 'user.login' }, status: 'ELIGIBLE', claimable: true }],
    { confirmCode: 500 },
  )
  const r = await claimAllCheckins(client)
  assert.equal(r.claimed.length, 1)
  assert.equal(r.claimed[0].confirmed, false, 'confirm 失败要如实反映')
})

test('confirm 抛错被吞掉，不打断整轮（返回 false）', async () => {
  const { client } = fakeClient([], { confirmThrows: true })
  assert.equal(await confirmClaim(client, 34), false)
})

test('claim 返回非 0 时记为跳过，且带 code 便于排查', async () => {
  const { client } = fakeClient(
    [{ campaignId: 34, title: '每日签到领100积分', type: 'USER_LOGIN', extra: { triggerEvent: 'user.login' }, status: 'ELIGIBLE', claimable: true }],
    // 真实回执：2026-11-20 实测对已 CLAIMED 的活动再 claim 会拿这个
    { claimCode: 40001, claimMessage: '尚未到达权益刷新时间，暂时无法领取' },
  )
  const r = await claimAllCheckins(client)
  assert.equal(r.claimed.length, 0)
  assert.match(r.skipped[0].reason, /code=40001/)
  // 上游的 message 要原样带出来，否则用户只知道"失败"不知道为什么
  assert.match(r.skipped[0].reason, /尚未到达权益刷新时间/)
})

test('混合列表：一次遍历里每个活动走各自正确的分支', async () => {
  const { client, calls } = fakeClient([
    { campaignId: 39, title: '2026年学生专属福利', type: 'STUDENT_CERTIFIED', extra: { triggerEvent: 'student.certified' }, status: 'CONFIRMED', claimable: false },
    { campaignId: 34, title: '每日签到领100积分', type: 'USER_LOGIN', extra: { triggerEvent: 'user.login' }, status: 'ELIGIBLE', claimable: true },
    { campaignId: 4, title: '新用户注册送 4000 积分', type: 'NEW_USER_REGISTER', extra: { triggerMode: 'AUTO_GRANT' }, status: 'CONSUMED', claimable: false },
    { campaignId: 2, title: '学生认证领积分', type: 'STUDENT_CERTIFIED', extra: { triggerEvent: 'student.certified' }, status: 'CONFIRMED', claimable: false },
  ])
  const r = await claimAllCheckins(client)

  // 只有 34 该被处理：claim + confirm
  assert.deepEqual(paths(calls), ['/v1/ops/claim', '/v1/ops/confirm'])
  assert.equal(r.claimed.length, 1)
  assert.equal(r.claimed[0].campaignId, 34)
  assert.equal(r.skipped.length, 3)
})

test('claimCheckin：ELIGIBLE 时 claim 后自动 confirm', async () => {
  const { client, calls } = fakeClient([
    { campaignId: 34, title: '每日签到领100积分', type: 'USER_LOGIN', extra: { triggerEvent: 'user.login' }, status: 'ELIGIBLE', claimable: true },
  ])
  const r = await claimCheckin(client)
  assert.equal(r.claimed, true)
  assert.deepEqual(paths(calls), ['/v1/ops/claim', '/v1/ops/confirm'])
})

test('claimCheckin：CONSUMED 时措辞说明「今日已领取」，不误导成没签', async () => {
  const { client } = fakeClient([
    { campaignId: 34, title: '每日签到领100积分', type: 'USER_LOGIN', extra: { triggerEvent: 'user.login' }, status: 'CONSUMED', claimable: false },
  ])
  const r = await claimCheckin(client)
  assert.equal(r.claimed, false)
  assert.match(r.reason, /今日已领取/)
  assert.match(r.reason, /CONSUMED/)
})

test('claimCheckin：列表里没有 34 时返回 available=false', async () => {
  const { client } = fakeClient([{ campaignId: 99, title: '别的活动', type: 'X', status: 'ELIGIBLE', claimable: true }])
  const r = await claimCheckin(client)
  assert.equal(r.available, false)
  assert.match(r.reason, /campaignId=34/)
})

test('queryCheckin 返回结构是 0.9.1 的超集（面板依赖的字段一个都不能少）', async () => {
  const { client } = fakeClient([
    { campaignId: 34, title: '每日签到领100积分', type: 'USER_LOGIN', extra: { triggerEvent: 'user.login' }, status: 'ELIGIBLE', claimable: true, pendingTotalAmount: 100, benefitUnit: 'CREDIT' },
  ])
  const s = await queryCheckin(client)
  // 面板 Panel.tsx 只读这几个老字段，少一个就白屏/显示错
  for (const k of ['ok', 'available', 'campaignId', 'title', 'status', 'claimable', 'pendingAmount', 'unit', 'expireAt']) {
    assert.ok(k in s, `缺少面板依赖的字段 ${k}`)
  }
  assert.equal(s.campaignId, DAILY_CHECKIN_CAMPAIGN)
  assert.ok(Array.isArray(s.campaigns), 'campaigns 数组必须存在')
})