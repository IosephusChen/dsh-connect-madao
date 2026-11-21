/**
 * dsh-connect-madao 的类型声明。
 *
 * 宿主侧入口启动本地桥接服务，并通过 DSH ConfigEditor 将模型清单
 * 合并到现有渠道配置。这里的类型只描述插件自身的导出面。
 */

/** Host 侧的 Cordis 上下文，需要 configEditor 和 effect。 */
export interface PluginContext {
  effect: (execute: () => () => void | Promise<void>, label?: string) => unknown
  readonly [key: string]: unknown
}

export interface MadaoConfig {
  /** 置为 false 时不启动桥接服务 */
  enabled?: boolean
  /** 桥接监听端口，默认 8765 */
  port?: number
  /** 覆盖默认网关地址 */
  gateway?: string
  /** 直接内联永久 AK（否则读 ~/.dsh-connect-madao/credentials.json） */
  ak?: string
  /** 直接内联永久 SK */
  sk?: string
  /** 启动时是否从网关刷新目录；false 使用兜底目录，仍合并到 DSH 渠道配置 */
  autoSyncModels?: boolean
}

/** provider 在 DSH 里的渠道键。 */
export declare const PROVIDER: 'madao'

export declare const name: 'dsh-connect-madao'

/** 依赖 DSH ConfigEditor 服务。 */
export declare const inject: string[]

/** 凭证文件默认位置：~/.dsh-connect-madao/credentials.json */
export declare const DEFAULT_CRED_PATH: string

export declare function apply(ctx: PluginContext, config?: MadaoConfig): void

export interface ModelInfo {
  id: string
  name: string
  context: number
  maxOutput: number
  /** 计费倍率，如 "0.18x" */
  ratio?: string
  /** 网关是否开放图片输入 */
  supportsImages: boolean
  /** 可选思考强度，如 ["high","max"]；空数组表示不支持 */
  strengths: string[]
  defaultStrength?: string
  description?: string
}

export declare const meta: {
  PROVIDER: typeof PROVIDER
  DEFAULT_CRED_PATH: string
  /** 兜底模型清单（网关不可达时使用） */
  models: ModelInfo[]
}
