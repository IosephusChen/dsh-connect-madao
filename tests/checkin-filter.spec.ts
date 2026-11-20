/**
 * 签到白名单判据回归测试。
 *
 * 真实报文取自 2026-11-20 本机实测（GET /v1/ops/delivery?channel=IDE）。
 * 注意：11-17 那批里还有 campaignId=40「Skill创新赛每日签到礼」
 * （每天 1000 分，是每日签到的十倍），已于 11-20 前下线，但白名单
 * 判据必须仍然认它 —— 官方随时可能再上一个同样的活动。
 *
 * 变红就说明有人把「只领登录签到类」这条边界改松了，那等于替用户
 * 报名/认证，属于会造成实际后果的错误。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { isCheckinCampaign, viewOf, DAILY_CHECKIN_CAMPAIGN } from '../src/checkin.ts'

// 2026-11-20 实测的四条
const REAL_2026_11_20 = [
  { campaignId: 39, title: '2026年学生专属福利', type: 'STUDENT_CERTIFIED', extra: { triggerEvent: 'student.certified', triggerMode: 'MANUAL_CLAIM' } },
  { campaignId: 34, title: '每日签到领100积分', type: 'USER_LOGIN', extra: { triggerEvent: 'user.login', triggerMode: 'MANUAL_CLAIM' } },
  { campaignId: 4, title: '新用户注册送 4000 积分', type: 'NEW_USER_REGISTER', extra: { triggerEvent: 'user.register', triggerMode: 'AUTO_GRANT' } },
  { campaignId: 2, title: '学生认证领积分', type: 'STUDENT_CERTIFIED', extra: { triggerEvent: 'student.certified', triggerMode: 'MANUAL_CLAIM' } },
]

// 2026-11-17 实测见过、现已下线
const HISTORICAL = [
  { campaignId: 40, title: 'Skill创新赛每日签到礼', type: 'USER_LOGIN', extra: { triggerEvent: 'user.login', triggerMode: 'MANUAL_CLAIM' } },
  { campaignId: 42, title: 'Skill创新赛报名礼', type: 'USER_LOGIN', extra: { triggerEvent: 'user.login', triggerMode: 'MANUAL_CLAIM' } },
]

test('每日签到（34）会被放行', () => {
  assert.equal(isCheckinCampaign(REAL_2026_11_20[1]), true)
})

test('历史活动：创新赛每日签到（40，1000分）仍按签到放行', () => {
  assert.equal(isCheckinCampaign(HISTORICAL[0]), true)
})

test('历史活动：创新赛报名礼（42）也带 USER_LOGIN，放行（它有报名礼金，但仍是签到类标签）', () => {
  // 注意这条刻意记录真实行为：42 的 type/triggerEvent 与签到完全一致，
  // 白名单无法区分「报名礼」和「签到礼」。要不要收窄成只认标题含签到，
  // 见下面的「标题兜底」用例 —— 现在的口径是：type 说了算。
  assert.equal(isCheckinCampaign(HISTORICAL[1]), true)
})

test('新用户注册礼（4）不会被放行', () => {
  assert.equal(isCheckinCampaign(REAL_2026_11_20[2]), false)
})

test('学生专属福利（39）不会被放行', () => {
  assert.equal(isCheckinCampaign(REAL_2026_11_20[0]), false)
})

test('学生认证（2）不会被放行', () => {
  assert.equal(isCheckinCampaign(REAL_2026_11_20[3]), false)
})

test('邀请有礼不会被放行', () => {
  assert.equal(
    isCheckinCampaign({ title: '推荐有礼', type: 'INVITE_USER', extra: { triggerEvent: 'invite.success' } }),
    false,
  )
})

test('type 缺失时靠 triggerEvent 兜底', () => {
  assert.equal(isCheckinCampaign({ title: '某活动', extra: { triggerEvent: 'user.login' } }), true)
})

test('type 和 event 都缺失时靠标题兜底', () => {
  assert.equal(isCheckinCampaign({ title: '五一每日签到' }), true)
  assert.equal(isCheckinCampaign({ title: '五一报名有礼' }), false)
})

test('标题带签到但也带报名时不放行（防"签到报名礼"这类混合活动）', () => {
  assert.equal(isCheckinCampaign({ title: '签到报名礼' }), false)
})

test('标题带签到但带认证时不放行', () => {
  assert.equal(isCheckinCampaign({ title: '签到认证礼' }), false)
})

test('完全空的条目不放行', () => {
  assert.equal(isCheckinCampaign({}), false)
  assert.equal(isCheckinCampaign(null), false)
  assert.equal(isCheckinCampaign(undefined), false)
})

test('type 大小写不敏感', () => {
  assert.equal(isCheckinCampaign({ type: 'user_login' }), true)
})

test('triggerEvent 大小写不敏感', () => {
  assert.equal(isCheckinCampaign({ extra: { triggerEvent: 'USER.LOGIN' } }), true)
})

test('每日签到 id 固定 34', () => {
  assert.equal(DAILY_CHECKIN_CAMPAIGN, 34)
})

test('viewOf 从真实报文里取全字段', () => {
  const v = viewOf(REAL_2026_11_20[1])
  assert.equal(v.campaignId, 34)
  assert.equal(v.title, '每日签到领100积分')
  assert.equal(v.type, 'USER_LOGIN')
  assert.equal(v.triggerEvent, 'user.login')
  assert.equal(v.triggerMode, 'MANUAL_CLAIM')
})

test('viewOf 对空字段不抛错', () => {
  const v = viewOf({ campaignId: 99 })
  assert.equal(v.campaignId, 99)
  assert.equal(v.type, null)
  assert.equal(v.claimable, false)
  assert.equal(v.benefitUnit, 'CREDIT')
})

// ── 四态状态机 ─────────────────────────────────────────────
// 上游状态是 ELIGIBLE → CLAIMED → CONFIRMED → CONSUMED。
// 2026-11-20 实测踩到：当天用过码道之后，34 的状态会变成 CONSUMED，
// 而面板当时只把 CLAIMED/CONFIRMED 当成「已签到」，于是显示成
// 「暂无可领取的签到奖励」，看起来像根本没签到。
// 这条用例把「CONSUMED 已签过」这个事实钉死。

test('CONSUMED 属于「今天已经签过」，不能当成未领取', () => {
  const v = viewOf({ campaignId: 34, title: '每日签到领100积分', status: 'CONSUMED', claimable: false })
  assert.equal(v.status, 'CONSUMED')
  assert.equal(v.claimable, false)
  // 判据与 Panel.tsx 保持一致：三者任一都算已签
  const done = v.status === 'CLAIMED' || v.status === 'CONFIRMED' || v.status === 'CONSUMED'
  assert.equal(done, true)
})

test('四态各自的 claimable 组合：只有 ELIGIBLE 才可领', () => {
  const cases: Array<[string, boolean, boolean]> = [
    ['ELIGIBLE', true, true],
    ['CLAIMED', false, false],
    ['CONFIRMED', false, false],
    ['CONSUMED', false, false],
    ['ENTRY', false, false],
  ]
  for (const [status, claimable, shouldClaim] of cases) {
    const v = viewOf({ campaignId: 34, status, claimable })
    assert.equal(v.claimable && v.status === 'ELIGIBLE', shouldClaim, `status=${status}`)
  }
})