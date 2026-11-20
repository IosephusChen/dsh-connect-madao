/**
 * 积分到期预警回归测试。
 *
 * 数据形状取自 2026-11-20 实测（GET /snap-manager/v1/statistics/plugin）：
 *   usageTotalPackageCredit / usageBonusPackageCredit 都带
 *   package_credit_expiring_amount = 33.54（同值，同一批）
 *   顶层 end_date = 2026-12-11
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { evaluateExpiry, parseDate, formatAmount, WARN_DAYS, URGENT_DAYS } from '../src/credit-expiry.ts'
import { pickExpiring } from '../src/server.ts'

// 2026-11-16 12:00 本地
const NOW = new Date(2026, 10, 16, 12, 0, 0)

function credit(patch: Record<string, unknown> = {}) {
  return {
    total: 13600,
    used: 5266.76,
    remain: 8333.24,
    expiringAmount: 0,
    ...patch,
  } as any
}

test('没有到期积分时不出提醒', () => {
  const n = evaluateExpiry(credit({ expiringAmount: 0 }), NOW)
  assert.equal(n.level, 'none')
  assert.equal(n.message, '')
})

test('credit 为 null 时不抛错', () => {
  const n = evaluateExpiry(null, NOW)
  assert.equal(n.level, 'none')
})

test('到期日很远时只给 info', () => {
  const n = evaluateExpiry(credit({ expiringAmount: 5000, packageEnd: '2026-12-30' }), NOW)
  assert.equal(n.level, 'info')
  assert.match(n.message, /5,000 积分/)
  assert.match(n.message, /2026-12-30/)
})

test('7 天内升到 warn', () => {
  // 11-16 → 11-21 = 5 天
  const n = evaluateExpiry(credit({ expiringAmount: 3000, packageEnd: '2026-11-21' }), NOW)
  assert.equal(n.level, 'warn')
  assert.equal(n.daysLeft, 5)
})

test('2 天内升到 urgent', () => {
  const n = evaluateExpiry(credit({ expiringAmount: 6663.29, packageEnd: '2026-11-17' }), NOW)
  assert.equal(n.level, 'urgent')
  assert.equal(n.daysLeft, 1)
  assert.match(n.message, /6,663/)
})

test('当天到期也算 urgent', () => {
  const n = evaluateExpiry(credit({ expiringAmount: 100, packageEnd: '2026-11-16' }), NOW)
  assert.equal(n.level, 'urgent')
  assert.equal(n.daysLeft, 0)
})

test('已经过期不崩，显示已到期', () => {
  const n = evaluateExpiry(credit({ expiringAmount: 100, packageEnd: '2026-11-10' }), NOW)
  assert.equal(n.level, 'urgent')
  assert.ok(n.daysLeft != null && n.daysLeft < 0)
  assert.match(n.message, /已到期/)
})

test('不足 1 分的残值不提醒（避免"0 积分要到期"）', () => {
  const n = evaluateExpiry(credit({ expiringAmount: 0.2, packageEnd: '2026-11-18' }), NOW)
  assert.equal(n.level, 'none')
})

test('有到期量但没日期时仍报 info，不静默', () => {
  const n = evaluateExpiry(credit({ expiringAmount: 500 }), NOW)
  assert.equal(n.level, 'info')
  assert.equal(n.daysLeft, null)
  assert.match(n.message, /即将到期/)
})

test('日期格式不合法时退化成「即将到期」而不是算错天数', () => {
  const n = evaluateExpiry(credit({ expiringAmount: 500, packageEnd: '2026-13-45' }), NOW)
  assert.equal(n.daysLeft, null)
  assert.match(n.message, /即将到期/)
})

test('真实数据：33.54 分 / 2026-12-11 在 11-20 应算 21 天', () => {
  const n = evaluateExpiry({ expiringAmount: 33.54, packageEnd: '2026-12-11' }, new Date(2026, 10, 20, 16, 45, 0))
  assert.equal(n.level, 'info')
  assert.equal(n.daysLeft, 21)
  assert.equal(n.dueDate, '2026-12-11')
  assert.match(n.message, /34 积分/)
})

// ── parseDate ──────────────────────────────────────────────

test('parseDate: 纯日期', () => {
  const d = parseDate('2026-12-11')
  assert.equal(d?.getFullYear(), 2026)
  assert.equal(d?.getMonth(), 11)
  assert.equal(d?.getDate(), 11)
})

test('parseDate: 容忍 ISO 时间串', () => {
  assert.ok(parseDate('2026-12-11T15:59:59Z'))
  assert.ok(parseDate('2026-12-11 08:00:00'))
})

test('parseDate: 非法月份/日期返回 null，不让 JS 悄悄进位', () => {
  assert.equal(parseDate('2026-13-01'), null)
  assert.equal(parseDate('2026-12-32'), null)
  assert.equal(parseDate('2026-00-10'), null)
  assert.equal(parseDate('2026-12-00'), null)
})

test('parseDate: 空值返回 null', () => {
  assert.equal(parseDate(''), null)
  assert.equal(parseDate(null), null)
  assert.equal(parseDate(undefined), null)
  assert.equal(parseDate('不是日期'), null)
})

// ── formatAmount ───────────────────────────────────────────

test('formatAmount 四舍五入并加千分位', () => {
  assert.equal(formatAmount(6663.29), '6,663')
  assert.equal(formatAmount(33.54), '34')
  assert.equal(formatAmount(0), '0')
})

test('阈值常量符合约定', () => {
  assert.equal(WARN_DAYS, 7)
  assert.equal(URGENT_DAYS, 2)
})

// ── pickExpiring ───────────────────────────────────────────
// 实测两个汇总指标报的是同一个值，取首个命中即可，累加会翻倍。

test('pickExpiring: 真实报文取 33.54', () => {
  const metrics = [
    { name: 'usageDataChatMessages' },
    { name: 'usageTokenChatMessages' },
    { name: 'usageTotalPackageCredit', package_credit_expiring_amount: 33.54, package_credit_amount: 13600 },
    { name: 'usageBasicPackageCredit', package_credit_amount: 500 },
    { name: 'usageOnDemandPackageCredit', package_credit_amount: 0 },
    { name: 'usageBonusPackageCredit', package_credit_expiring_amount: 33.54, package_credit_amount: 13100 },
  ]
  // 关键：不能是 67.08
  assert.equal(pickExpiring(metrics), 33.54)
})

test('pickExpiring: 只有 bonus 报时也能取到', () => {
  assert.equal(pickExpiring([{ name: 'usageBonusPackageCredit', package_credit_expiring_amount: 12.5 }]), 12.5)
})

test('pickExpiring: 字段缺失返回 0，不抛错', () => {
  assert.equal(pickExpiring([]), 0)
  assert.equal(pickExpiring([{ name: 'usageTotalPackageCredit' }]), 0)
  assert.equal(pickExpiring([{ name: 'usageTotalPackageCredit', package_credit_expiring_amount: null }]), 0)
})

test('pickExpiring: 脏值（负/NaN/字符串）不污染结果', () => {
  assert.equal(pickExpiring([{ name: 'usageTotalPackageCredit', package_credit_expiring_amount: -5 }]), 0)
  assert.equal(pickExpiring([{ name: 'usageTotalPackageCredit', package_credit_expiring_amount: 'abc' }]), 0)
  assert.equal(pickExpiring([{ name: 'usageTotalPackageCredit', package_credit_expiring_amount: '7.5' }]), 7.5)
})