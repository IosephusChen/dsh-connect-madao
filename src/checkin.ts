/**
 * 福利活动（签到）—— 查询、领取、确认。
 *
 * 为什么要单独一个文件：这套逻辑既要被 HTTP 桥接（面板上的按钮）用，
 * 也要能被单元测试直接 import。server.ts 已经有 1100+ 行，再往里塞
 * 260 行签到逻辑只会让它更难维护；而白名单判据是「以后官方上什么新活动
 * 就得跟着改」的地方，单独放一处，改一次就够。
 *
 * 接口是从码道客户端抓出来的（extension.js 里 welfareClaimUrl 拼的是
 * ${policyCenterDomain}/v1/ops/claim，policyCenterDomain 就是网关域名）：
 *
 *   列表    GET  /v1/ops/delivery?channel=IDE
 *   领取    POST /v1/ops/claim    { campaignId, idempotentKey, channel:"IDE" }
 *   确认    POST /v1/ops/confirm  { campaignId }          ← 只认这一个字段
 *
 * 上游是**四态**状态机（权威来源是它自己给的 displayConfig.claimButtonText）：
 *
 *   ELIGIBLE  立即领取   —— 可领
 *   CLAIMED   已领取     —— 积分已到账，但状态还挂着「待确认」
 *   CONFIRMED 已到账     —— 确认完
 *   CONSUMED  已使用     —— 用掉了
 *   ENTRY     立即认证   —— 要去跳外部页面办（报名/认证），不是能代领的
 *
 * 踩过的坑（2026-11-20 本机实测，不是推测）：
 *   1. claim 之后**必须**再 confirm，否则状态永远停在 CLAIMED。
 *   2. confirm 的 body 多带 channel 会 HTTP 400
 *      `{"error_code":"HDN.1000","error_msg":"channel : unknown exception"}`。
 *   3. confirm **不校验**状态机：对已经 CONFIRMED 的活动再 confirm 也会
 *      返回 code=0。所以只能对 status==="CLAIMED" 的调用，别到处乱发。
 *   4. 对已 CLAIMED 的活动重复 claim 返回
 *      `code=40001 "尚未到达权益刷新时间，暂时无法领取"` —— 注意它不是
 *      非 0 就一定是真失败，这句是「今天已经领过了」的正常回执。
 */

import { randomUUID } from 'node:crypto'

import type { MadaoClient } from './client.ts'
import { chatLog } from './protocol/log.ts'

/** 每日签到活动 id。网关里固定是 34（USER_LOGIN / user.login）。 */
export const DAILY_CHECKIN_CAMPAIGN = 34

/**
 * 判断一个活动是不是「登录签到」类，值得自动领取。
 *
 * 白名单优先：只放行明确认识的。宁可漏领一个陌生活动，也不替用户误报一次名。
 *
 * 判据（按可靠程度排序）：
 *   1. type === 'USER_LOGIN'              —— 官方自己就是这么标签的
 *   2. extra.triggerEvent === 'user.login' —— 同上的点分小写写法
 *   3. 标题带「签到」且不带报名/认证/注册/邀请 —— 前两个字段缺失时的兜底
 *
 * 为什么不能只看 claimable + status：如果官方把「点击即报名并发放积分」
 * 做成同一个接口，未报名时也可能返回 ELIGIBLE + claimable=true，那样插件
 * 就等于替用户签了赛事协议。报名/认证/邀请这类一次性动作不该自动化。
 *
 * 已知的非签到类型（STUDENT_CERTIFIED / NEW_USER_REGISTER / INVITE_USER）
 * 会被前三条自然排除，不需要单独黑名单。
 */
export function isCheckinCampaign(it: any): boolean {
  if (!it) return false
  const type = String(it?.type ?? '').toUpperCase()
  const event = String(it?.extra?.triggerEvent ?? '').toLowerCase()
  const title = String(it?.title ?? '')

  if (type === 'USER_LOGIN') return true
  if (event === 'user.login') return true
  return /签到/.test(title) && !/报名|认证|注册|邀请/.test(title)
}

/** 一条活动的精简视图，给面板和日志共用。 */
export interface CampaignView {
  campaignId: number
  title: string
  type: string | null
  triggerEvent: string | null
  triggerMode: string | null
  status: string | null
  claimable: boolean
  pendingAmount: number
  benefitAmount: number
  benefitUnit: string
  expireAt: string | null
}

export function viewOf(it: any): CampaignView {
  return {
    campaignId: Number(it?.campaignId),
    title: String(it?.title ?? `campaign=${it?.campaignId}`),
    type: it?.type ?? null,
    triggerEvent: it?.extra?.triggerEvent ?? null,
    triggerMode: it?.extra?.triggerMode ?? null,
    status: it?.status ?? null,
    claimable: it?.claimable === true,
    pendingAmount: Number(it?.pendingTotalAmount ?? 0),
    benefitAmount: Number(it?.benefitAmount ?? 0),
    benefitUnit: String(it?.benefitUnit ?? 'CREDIT'),
    expireAt: it?.expireAt ?? null,
  }
}

/** 拉一次活动列表。失败会抛，调用方自己兜。 */
export async function fetchCampaigns(client: MadaoClient): Promise<any[]> {
  const d = (await client.getJson('/v1/ops/delivery?channel=IDE')) as any
  const items = d?.data?.items
  return Array.isArray(items) ? items : []
}

/**
 * 只查询签到状态，不领取。
 *
 * 返回结构对 0.9.1 的 `/diag/checkin` 是**超集**：老的 available / status /
 * claimable / pendingAmount / unit / expireAt 全在（Panel.tsx 只读这几个），
 * 新增 campaigns 数组给「多活动」用。
 */
export interface CheckinState {
  ok: boolean
  available: boolean
  claimed?: boolean
  campaignId?: number
  title?: string
  status?: string | null
  claimable?: boolean
  pendingAmount?: number
  unit?: string
  expireAt?: string | null
  amount?: number
  claimedAt?: string | null
  reason?: string
  /** 全部活动的当前状态（含非签到类），面板能显示为什么跳过 */
  campaigns?: CampaignView[]
}

export async function queryCheckin(client: MadaoClient): Promise<CheckinState> {
  const items = await fetchCampaigns(client)
  const campaigns = items.map(viewOf)
  const daily = items.find((x) => Number(x?.campaignId) === DAILY_CHECKIN_CAMPAIGN)
  if (!daily) {
    return {
      ok: true,
      available: false,
      reason: '网关的福利列表里没有每日签到活动（campaignId=34）',
      campaigns,
    }
  }
  const v = viewOf(daily)
  return {
    ok: true,
    available: true,
    campaignId: v.campaignId,
    title: v.title,
    status: v.status,
    claimable: v.claimable,
    pendingAmount: v.pendingAmount,
    unit: v.benefitUnit,
    expireAt: v.expireAt,
    campaigns,
  }
}

/**
 * 领取当日签到（只领 34 这一条）。
 *
 * 当天已领过时返回 claimed=false 且带 reason，不抛错。
 * 保留这个单活动入口是因为面板上那个按钮的语义就是「签今天的到」，
 * 不该顺手把一堆活动全点一遍。
 */
export async function claimCheckin(client: MadaoClient): Promise<CheckinState> {
  const state = await queryCheckin(client)
  if (!state.available) return state
  if (!state.claimable || state.status !== 'ELIGIBLE') {
    // 说明为什么不能领 —— 光说「当前不可领取」会被误读成「没签过」。
    // 上游四态里后三者都表示今天已经领到了（CONSUMED = 当天已用掉）。
    const why =
      state.status === 'CONSUMED'
        ? '今日已领取（积分已用完）'
        : state.status === 'CONFIRMED'
          ? '今日已领取（已到账）'
          : state.status === 'CLAIMED'
            ? '今日已领取（待确认，已自动补 confirm）'
            : '当前不可领取'
    return { ...state, claimed: false, reason: `${why}（status=${state.status ?? 'null'}）` }
  }
  const r = (await client.postJson('/v1/ops/claim', {
    campaignId: DAILY_CHECKIN_CAMPAIGN,
    idempotentKey: randomUUID(),
    channel: 'IDE',
  })) as any
  const claimed = r?.code === 0
  chatLog(
    `checkin ${claimed ? 'OK' : 'FAIL'} campaign=${DAILY_CHECKIN_CAMPAIGN} ` +
      `${JSON.stringify(r?.data ?? r).slice(0, 200)}`,
  )
  // claim 成功之后必须补 confirm，否则状态停在 CLAIMED（见文件头第 1 条坑）
  if (claimed) await confirmClaim(client, DAILY_CHECKIN_CAMPAIGN)
  return {
    ...state,
    claimed,
    status: r?.data?.status ?? (claimed ? 'CLAIMED' : state.status),
    amount: r?.data?.totalAmount ?? state.pendingAmount,
    claimedAt: r?.data?.claimedAt ?? null,
    ...(claimed ? {} : { reason: String(r?.message ?? '领取失败') }),
  }
}

/**
 * 把「已领未确认」推进到「已到账」。
 *
 * confirm 的 body **只认 campaignId**，多带 channel 会 400 HDN.1000（实测）。
 *
 * 失败不抛错：claim 时积分就已经到账了，confirm 只是推进状态，失败也
 * 不丢积分。只记日志，让下一轮看到 status===CLAIMED 时再补一次。
 */
export async function confirmClaim(client: MadaoClient, campaignId: number): Promise<boolean> {
  try {
    const r = (await client.postJson('/v1/ops/confirm', { campaignId })) as any
    const ok = r?.code === 0
    chatLog(`confirm ${ok ? 'OK' : 'FAIL'} campaign=${campaignId} ${JSON.stringify(r?.data ?? r).slice(0, 160)}`)
    return ok
  } catch (e) {
    chatLog(`confirm ERROR campaign=${campaignId} ${String((e as Error)?.message ?? e).slice(0, 160)}`)
    return false
  }
}

export interface ClaimAllResult {
  ok: boolean
  claimed: Array<{ campaignId: number; title: string; amount: number; confirmed: boolean }>
  skipped: Array<{ campaignId: number; title: string; reason: string }>
  campaigns: CampaignView[]
}

/**
 * 领取**所有**当前可领的签到类活动。
 *
 * 为什么需要它：码道的福利不只是「每日签到领 100 积分」（campaignId=34），
 * 还有按活动上线的限时签到礼 —— 2026-11-17 实测见过 campaignId=40
 * 「Skill创新赛每日签到礼」每天 1000 积分，额度是每日签到的十倍。
 * 只盯 34 的话，大头那个天天漏。（该活动已于 11-20 前下线，但机制仍在。）
 *
 * 处理顺序刻意如此：
 *   1. AUTO_GRANT 跳过 —— 自动发放的，去 claim 反而错
 *   2. status===CLAIMED 只补 confirm，不重复 claim
 *   3. 白名单（isCheckinCampaign）之外的跳过 —— 不替用户报名/认证
 *   4. 必须 claimable 且 status===ELIGIBLE 才 claim
 *   5. claim 成功后立刻 confirm
 */
export async function claimAllCheckins(client: MadaoClient): Promise<ClaimAllResult> {
  const items = await fetchCampaigns(client)
  const campaigns = items.map(viewOf)
  const claimed: ClaimAllResult['claimed'] = []
  const skipped: ClaimAllResult['skipped'] = []

  for (const it of items) {
    const id = Number(it?.campaignId)
    const title = String(it?.title ?? `campaign=${id}`)
    const mode = it?.extra?.triggerMode
    if (!Number.isFinite(id)) continue

    if (mode === 'AUTO_GRANT') {
      skipped.push({ campaignId: id, title, reason: '自动发放，无需领取' })
      continue
    }

    // 「已领未确认」的补一次 confirm —— 上一轮 claim 成功但 confirm 没跑通，
    // 或者用户自己手动领过。这类不需要重新 claim，只推进状态。
    if (it?.status === 'CLAIMED') {
      const done = await confirmClaim(client, id)
      skipped.push({
        campaignId: id,
        title,
        reason: done ? '已补确认（此前已领未确认）' : '补确认失败，下轮再试',
      })
      continue
    }

    if (!isCheckinCampaign(it)) {
      skipped.push({
        campaignId: id,
        title,
        reason: `非签到类活动，跳过自动领取（type=${it?.type ?? '-'}, event=${it?.extra?.triggerEvent ?? '-'}）`,
      })
      continue
    }

    if (!it?.claimable || it?.status !== 'ELIGIBLE') {
      skipped.push({
        campaignId: id,
        title,
        reason: `当前不可领（status=${it?.status ?? 'null'}, claimable=${it?.claimable}）`,
      })
      continue
    }

    try {
      const r = (await client.postJson('/v1/ops/claim', {
        campaignId: id,
        idempotentKey: randomUUID(),
        channel: 'IDE',
      })) as any
      const ok = r?.code === 0
      chatLog(`claimAll ${ok ? 'OK' : 'FAIL'} campaign=${id} ${JSON.stringify(r?.data ?? r).slice(0, 160)}`)
      if (ok) {
        const confirmed = await confirmClaim(client, id)
        claimed.push({
          campaignId: id,
          title,
          amount: Number(r?.data?.totalAmount ?? it?.pendingTotalAmount ?? it?.benefitAmount ?? 0),
          confirmed,
        })
      } else {
        skipped.push({
          campaignId: id,
          title,
          reason: `${String(r?.message ?? '领取失败')}（code=${r?.code ?? '-'}）`,
        })
      }
    } catch (e) {
      skipped.push({ campaignId: id, title, reason: String((e as Error)?.message ?? e) })
    }
  }

  return { ok: true, claimed, skipped, campaigns }
}