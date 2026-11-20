# 更新日志

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## 0.9.2 — 2026-11-20

本版主要来自社区贡献者 **[@vzhentian1-design](https://github.com/vzhentian1-design)** 的
[PR #1](https://github.com/XLNC-L/dsh-connect-madao/pull/1)。该 PR 基于 11-16 的 main，
之后 `server.ts` / `sse.ts` / `lib/index.js` 均已大改，无法直接合并；这里按「只移植协议
增量」的方式重放了他的四项改动，其余部分（含提交进仓库的 `lib/index.js` 构建产物）
未采用，产物由本仓库重新构建生成。原始思路与判据均来自他。

### 新增

- **`POST /v1/ops/confirm`** —— 补上漏掉的协议环节。
  上游是四态状态机 `ELIGIBLE → CLAIMED → CONFIRMED → CONSUMED`：`claim` 之后积分
  虽然已经到账，状态却停在 `CLAIMED`（"已领取"），必须再 `confirm` 一次才变
  `CONFIRMED`（"已到账"）。本仓库之前只做了 `claim`，所以网页端会一直显示「已领取」。
  - `confirm` 的 body **只认 `{campaignId}`**，多带 `channel` 会 `HTTP 400 HDN.1000
    channel : unknown exception`（实测）。
  - `confirm` **不校验状态机**：对已经 `CONFIRMED` 的活动再调用也返回 `code=0`。
    因此只对 `status === "CLAIMED"` 的活动调用，绝不随手乱发。
  - 列表里遇到 `CLAIMED` 时只补 `confirm`，不重复 `claim`。
- **多活动扫描 + `type` / `triggerEvent` 白名单** —— 之前只认死 `campaignId=34`，
  其它签到类活动全部漏领（实测曾见过 `campaignId=40`「Skill创新赛每日签到礼」
  每天 1000 分，是每日签到的十倍）。现在：
  - 判据按可靠程度：`type === 'USER_LOGIN'` → `extra.triggerEvent === 'user.login'`
    → 标题含「签到」且不含「报名 / 认证 / 注册 / 邀请」（前两者缺失时才用标题兜底）。
  - 只领 `triggerMode !== 'AUTO_GRANT'` 且 `claimable === true` 且
    `status === 'ELIGIBLE'` 的活动。
  - **不替用户报名/认证**：报名、学生认证、邀请有礼这类一次性动作一律跳过，
    宁可漏领也不误签。
  - 新增 `POST /diag/checkin/all`（面板上的「领全部」按钮）。
- **积分到期预警** —— 上游在额度接口里给了 `package_credit_expiring_amount`
  （即将到期的数量）和顶层的 `start_date` / `end_date`，之前一个字段都没读，
  用户只能等某天突然发现余额少了一大截。现在读取并算出三档提醒
  （`urgent` ≤ 2 天 / `warn` ≤ 7 天 / `info`），通过 `/diag/account` 的
  `creditExpiry` 字段暴露，面板上额度行下面直接显示。
  - 实测这两个汇总指标报的是**同一个值**（同一批积分），取首个命中即可，
    累加会把 33.54 说成 67.08。
- **`LICENSE`** —— MIT 全文。之前仓库根确实没有；`package.json` 的 `files`
  也一并补上，否则 npm 包里不会带这个文件。

### 未采用（本仓库已自行实现）

- **缓存命中透传**：PR 里的 `pickUsage` 会挑字段重组 usage，覆盖面反而比本仓库
  0.8.x 起的实现更窄 —— 本仓库在 `protocol/sse.ts` 是**整体保留**上游 usage
  （含 `prompt_tokens_details.cached_tokens`），并在 `server.ts` 里读取打日志。
- **自动签到调度器**（`src/checkin-scheduler.ts`）：每分钟轮询、开机补跑、
  每天最多 3 次重试、默认开启。本版**不包含** —— 签到仍只由用户点击触发，
  不替用户自动改账号状态。需要的话建议后续以「默认关闭 + 显式开关」的方式加。

### 内部

- `chatLog` 从 `server.ts` 抽到 `src/protocol/log.ts`（签到模块也要写同一个
  `chat.log`，两处各写一份会互相交错）。
- 签到逻辑独立成 `src/checkin.ts`，纯函数可单测，不绑在 HTTP 层；
  `server.ts` 已 1100+ 行，不再往里塞。
- `src/credit-expiry.ts` 只依赖一个极小的 `ExpiryInput` 接口，不 import `server.ts`。
- 单测 42 → **80**，新增 `tests/checkin-filter.spec.ts`（16 项）与
  `tests/credit-expiry.spec.ts`（22 项）。

## 0.9.1 — 2026-11-19

- 请求体超限返回 413 而不是 400。
- 上下文窗口改为如实上报真实值（系数 2.5 → 1.0），修掉「压缩失败」。

## 0.9.0 — 2026-11-19

- 首个正式发布版本，插件市场上架。