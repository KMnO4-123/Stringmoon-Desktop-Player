/**
 * 应用信息与自动更新状态（打包 / 无痛升级，第三轮收尾新增）。
 *
 * 为什么单独一个 shared 模块：主进程是唯一能访问 electron-updater 的地方，
 * 渲染层只该看到「一个可序列化的状态」与四个动作；把这套形状钉在 shared 里，
 * preload / d.ts / 测试 / 设置页用的是同一份真相。
 */

/** 当前应用版本与运行形态（设置页「关于」区与问题排查用）。 */
export interface AppInfo {
  /** package.json 的 version（安装包升级后应随之变化）。 */
  version: string
  /** 是否运行在打包后的安装形态；开发模式不做自动更新。 */
  packaged: boolean
  /** 数据目录（%APPDATA%\twilight-echo-app）。升级/备份提示里要显示真实路径。 */
  userDataPath: string
  /** 平台，当前只发布 Windows。 */
  platform: string
}

/**
 * 自动更新阶段。命名是「用户看到的状态」，不是 electron-updater 的事件名：
 * - unconfigured：打包版，但没有更新源（env / userData update-feed.json）
 * - disabled-dev：开发模式，不检查更新（不是错误）
 * - up-to-date：检查完成且已是最新
 * - error：检查/下载失败，message 是一句可读原因
 */
export type UpdatePhase =
  | 'idle'
  | 'unconfigured'
  | 'disabled-dev'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'downloaded'
  | 'up-to-date'
  | 'installing'
  | 'error'

/** 更新状态快照；所有字段都必须是可 JSON 序列化的（IPC 边界）。 */
export interface UpdateState {
  phase: UpdatePhase
  /** 当前运行版本；永远有值。 */
  currentVersion: string
  /** 检查到的新版本；无事发生时 null。 */
  latestVersion: string | null
  /** 下载百分比 0-100；未在下载时 null。 */
  percent: number | null
  /** 面向用户的一句状态/原因（中文）；不是堆栈。 */
  message: string | null
  /** 是否配置了更新源；false 时设置页显示配置指引。 */
  feedConfigured: boolean
  /** 打包版才支持；开发模式 false。 */
  supported: boolean
}

/** userData/update-feed.json 的形状（自托管更新源；比改代码简单）。 */
export interface UpdateFeedConfig {
  /** 静态更新目录的 http(s) 地址，例如 https://example.com/stringmoon/releases/。 */
  url: string
  /** 可选：说明用途/备注，只用于界面提示。 */
  note?: string
}
