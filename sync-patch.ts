/**
 * 用网关真实数据重新生成 cordis.patch.yml。
 *
 * 为什么需要这个脚本：
 *
 *   `cordis.patch.yml` 必须随 npm 包发布（DSH 首次安装要靠它加载 bundle），
 *   但它是**网关数据的快照**。插件启动时会用实时数据覆盖它（syncPatch），
 *   可一旦下一次 `pnpm add` 装新版本，npm 又会用包里那份覆盖回去。
 *
 *   如果包里那份是旧的，就会复现这个 bug：
 *     码道新增了思考档位 → 包里的 yml 还写着 reasoningEfforts: false
 *     → DSH 报 UNSUPPORTED_REASONING_EFFORT: does not support reasoning_effort "high"
 *
 * 所以**每次发版前必须跑一次**：
 *
 *   node --experimental-strip-types sync-patch.ts
 *
 * 已接进 npm scripts 的 prepack，`npm pack` / `npm publish` 会自动执行。
 */

import { writeFileSync, readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { loadCredentials } from './src/credentials.ts'
import { StsProvider } from './src/sts-provider.ts'
import { MadaoClient } from './src/client.ts'
import { discoverModels } from './src/models.ts'
import { renderPatch } from './src/host-patch.ts'

const here = dirname(fileURLToPath(import.meta.url))
const target = join(here, 'cordis.patch.yml')

async function main() {
  const loaded = await loadCredentials()
  const key = loaded.key
  const creds = key.securityToken
    ? { ak: key.ak, sk: key.sk, securityToken: key.securityToken, expiresAt: key.expiresAt ?? Date.now() + 3600_000 }
    : await new StsProvider({ ak: key.ak, sk: key.sk }).credentials()

  const client = new MadaoClient({ credentials: creds as any })
  const found = await discoverModels(client)

  const next = renderPatch(found.models)
  const prev = existsSync(target) ? readFileSync(target, 'utf8') : ''

  if (prev === next) {
    console.log(`✓ cordis.patch.yml 已是最新（${found.models.length} 个模型，来源 ${found.source}）`)
    return
  }

  writeFileSync(target, next, 'utf8')
  console.log(`✓ cordis.patch.yml 已更新（${found.models.length} 个模型，来源 ${found.source}）`)

  // 打印有档位的模型，方便核对
  const withEffort = found.models.filter((m) => m.strengths.length > 0)
  if (withEffort.length) {
    console.log('  带思考档位的模型：')
    for (const m of withEffort) console.log(`    ${m.id.padEnd(26)} ${m.strengths.join(' / ')}`)
  }
}

main().catch((e) => {
  console.error(`✗ 同步失败：${String((e as Error)?.message ?? e)}`)
  console.error('  凭据不可用时无法自动同步，请手动确认 cordis.patch.yml 是否过期。')
  process.exit(1)
})
