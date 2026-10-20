/** Application library-directory state, separate from the frozen audio-engine protocol. */

/**
 * 曲库目录集合（主进程持久化）。
 *
 * `directories` 是**生效**的目录列表：用户明确管理过就是存下来的那份，
 * 否则是内置默认目录。渲染层只管消费它，不必自己拼默认值。
 */
export interface LibraryDirectories {
  /** 生效的目录，按添加顺序。可能为空（用户把目录都移除了）。 */
  directories: string[]
  /** 其中此刻不可用的（拔掉的盘、删掉的目录），用来诚实提示 —— 它们仍留在列表里。 */
  missing: string[]
}

/**
 * 曲目身份键：把同一个文件的两种写法归一到一个键上。
 *
 * 为什么需要它：引擎把 `scan` 收到的目录字符串原样拼进每首曲目的 path
 * （结果是混用分隔符的 `D:/a\b.flac` 或 `D:\a\b.flac`），并用整串 path 去重。
 * 于是**调用方换个写法就是另一首歌**：先扫 `<测试曲库>/a.flac`、再扫
 * `<测试曲库>\\a.flac`，91 个文件会变成 182 条、且 182 个互不相同的 trackId
 * 与 182 个互不相同的 path（实测，见 CR-013）。这不是引擎的 id 分配错，是身份
 * 依赖了调用方的拼写。
 *
 * 归一：分隔符统一为 `\`、去掉结尾分隔符、转小写。Windows 路径大小写不敏感，
 * 所以转小写不会把两个不同的文件并成一个；反过来，少了它就会出现同一文件两条。
 * 局限：不合并连续分隔符，也不处理 UNC 前导 `\\`。应用只会把对话框返回的
 * 目录交给引擎，不会自己造出这两种形状，所以不为此加复杂度。
 */
export function libraryPathKey(file: string): string {
  if (typeof file !== 'string') return ''
  return file.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()
}

/**
 * `file` 是否位于目录 `root` 之下（含它自身）。
 *
 * 用来把引擎 catalog 里的曲目按当前曲库目录过滤：移除一个目录后，引擎仍然
 * 留着那批条目（它没有清空命令），应用只能决定「显示谁」。边界必须掐在分隔符上，
 * 否则 `D:\Music2` 会被误判成在 `D:\Music` 之下。
 */
export function isUnderRoot(file: string, root: string): boolean {
  const target = libraryPathKey(file)
  const base = libraryPathKey(root)
  if (!target || !base) return false
  return target === base || target.startsWith(base + '\\')
}
