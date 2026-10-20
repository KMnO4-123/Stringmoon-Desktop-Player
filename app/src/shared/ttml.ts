import type { LyricLine, LyricWord } from './protocol'

/**
 * AMLL TTML → CONTRACT §4.3 行结构。
 *
 * 为什么单独一个文件而不是在 lrc.ts 里加 if：REFS-B2 §「多解析器 → 一个中间态」——
 * 每多一种格式就多一个 if，最后没人能说清某种输入到底走了哪条分支。
 * 这里只做一件事：把一份 Already-normalized 的文档变成 Lyrics 的 lines。
 *
 * 覆盖的语法（依据 amll-ttml-db wiki §格式规范）：
 *  - <p begin end itunes:key>                    行
 *  - <span begin end>                            逐字音节
 *  - <span ttm:role="x-translation" xml:lang>    行内翻译（可多条语言）
 *  - <span ttm:role="x-roman">                   行内音译/罗马音
 *  - <span ttm:role="x-bg">                      背景人声（可以自己再带翻译与时间）
 *  - <span tts:ruby="container|base|textContainer|text">  注音（ruby）
 *  - <iTunesMetadata><translations|transliterations><text for="L1">  头信息辅助轨
 *
 * 三条刻意的取舍：
 *  1. **不引 XML 依赖**。TTML 是机器生成的规整 XML，这里写一个只认语法的扫描器；
 *     遇到畸形输入**返回 null**，绝不返回半份错位的歌词（错位的歌词比没有歌词更糟）。
 *  2. **不做命名空间解析**。属性按「最后一个冒号之后的局部名」匹配，因为 TTML 的
 *     前缀是任意的（ttm:/amll:/itunes:）而局部名是规范的。
 *  3. 背景人声**并进同一行**（AMLL 的渲染就是这样：主句后面跟 "(信じてる)"），
 *     只有整行都是背景人声时 line.background 才为 true。
 */

const MAX_SOURCE_CHARS = 4 * 1024 * 1024
const MAX_DEPTH = 64
/** 时间戳上限：24 小时。超过它只可能是把偏移量当成了时间。 */
const MAX_TIME_MS = 24 * 60 * 60 * 1000

interface XmlNode {
  /** 小写元素名；'#text' 表示文本节点 */
  name: string
  attrs: Map<string, string>
  children: XmlNode[]
  text: string
}

const isText = (node: XmlNode): boolean => node.name === '#text'

/** 属性的局部名（最后一个冒号之后）。TTML 的前缀是任意的，局部名才是规范。 */
function attrLocal(node: XmlNode, local: string): string | undefined {
  for (const [key, value] of node.attrs) {
    const colon = key.lastIndexOf(':')
    if ((colon < 0 ? key : key.slice(colon + 1)) === local) return value
  }
  return undefined
}

function decodeEntities(value: string): string {
  if (!value.includes('&')) return value
  return value.replace(/&(#[xX][0-9a-fA-F]+|#[0-9]+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X'
        ? Number.parseInt(body.slice(2), 16)
        : Number.parseInt(body.slice(1), 10)
      if (!Number.isInteger(code) || code <= 0 || code > 0x10ffff) return match
      try {
        return String.fromCodePoint(code)
      } catch {
        return match
      }
    }
    switch (body) {
      case 'amp': return '&'
      case 'lt': return '<'
      case 'gt': return '>'
      case 'quot': return '"'
      case 'apos': return "'"
      case 'nbsp': return '\u00a0'
      default: return match
    }
  })
}

interface Tag {
  name: string
  attrs: Map<string, string>
  selfClosing: boolean
  end: number
}

function readTag(source: string, start: number): Tag | null {
  let index = start + 1
  const nameStart = index
  while (index < source.length && !/[\s/>]/.test(source[index]!)) index++
  if (index === nameStart) return null
  const name = source.slice(nameStart, index).toLowerCase()
  const attrs = new Map<string, string>()
  while (index < source.length) {
    while (index < source.length && /\s/.test(source[index]!)) index++
    if (index >= source.length) return null
    const char = source[index]!
    if (char === '>') return { name, attrs, selfClosing: false, end: index + 1 }
    if (char === '/' && source[index + 1] === '>') return { name, attrs, selfClosing: true, end: index + 2 }
    if (char === '/') { index++; continue }
    const attrName = index
    while (index < source.length && !/[\s=/>]/.test(source[index]!)) index++
    if (index === attrName) return null
    const key = source.slice(attrName, index).toLowerCase()
    while (index < source.length && /\s/.test(source[index]!)) index++
    if (index >= source.length || source[index] !== '=') return null
    index++
    while (index < source.length && /\s/.test(source[index]!)) index++
    const quote = source[index]
    if (quote !== '"' && quote !== "'") return null
    index++
    const valueStart = index
    while (index < source.length && source[index] !== quote) index++
    if (index >= source.length) return null
    attrs.set(key, decodeEntities(source.slice(valueStart, index)))
    index++
  }
  return null
}

function parseXml(source: string): XmlNode | null {
  const root: XmlNode = { name: '#document', attrs: new Map(), children: [], text: '' }
  const stack: XmlNode[] = [root]
  const pushText = (raw: string): void => {
    if (!raw) return
    const parent = stack[stack.length - 1]!
    parent.children.push({ name: '#text', attrs: new Map(), children: [], text: decodeEntities(raw) })
  }
  let index = 0
  while (index < source.length) {
    const open = source.indexOf('<', index)
    if (open < 0) { pushText(source.slice(index)); break }
    if (open > index) pushText(source.slice(index, open))
    if (source.startsWith('<!--', open)) {
      const close = source.indexOf('-->', open + 4)
      index = close < 0 ? source.length : close + 3
      continue
    }
    if (source.startsWith('<![CDATA[', open)) {
      const close = source.indexOf(']]>', open + 9)
      pushText(source.slice(open + 9, close < 0 ? source.length : close))
      index = close < 0 ? source.length : close + 3
      continue
    }
    if (source.startsWith('<?', open) || source.startsWith('<!', open)) {
      const close = source.indexOf('>', open + 2)
      index = close < 0 ? source.length : close + 1
      continue
    }
    if (source.startsWith('</', open)) {
      const close = source.indexOf('>', open + 2)
      if (close < 0) break
      const name = source.slice(open + 2, close).trim().toLowerCase()
      for (let depth = stack.length - 1; depth > 0; depth--) {
        if (stack[depth]!.name === name) { stack.length = depth; break }
      }
      index = close + 1
      continue
    }
    const tag = readTag(source, open)
    if (!tag) { pushText(source[open]!); index = open + 1; continue }
    if (stack.length <= MAX_DEPTH) {
      const parent = stack[stack.length - 1]!
      const node: XmlNode = { name: tag.name, attrs: tag.attrs, children: [], text: '' }
      parent.children.push(node)
      if (!tag.selfClosing) stack.push(node)
    }
    index = tag.end
  }
  return stack.length === 1 && root.children.length > 0 ? root : null
}

/** 时间戳：'ss' | 'ss.xxx' | 'mm:ss(.xxx)' | 'hh:mm:ss(.xxx)'。纯数字、不许带单位。 */
export function parseTime(value: string | undefined): number | null {
  if (!value) return null
  const text = value.trim()
  if (!text || /[^0-9:.]/.test(text)) return null
  const parts = text.split(':')
  if (parts.length === 0 || parts.length > 3) return null
  let seconds = 0
  for (const part of parts) {
    if (part === '') return null
    const value = Number(part)
    if (!Number.isFinite(value) || value < 0) return null
    seconds = seconds * 60 + value
  }
  const ms = Math.round(seconds * 1000)
  if (!Number.isFinite(ms) || ms < 0 || ms > MAX_TIME_MS) return null
  return ms
}

const AUX_ROLES = new Set(['x-translation', 'x-roman'])

function isAux(node: XmlNode): boolean {
  const role = attrLocal(node, 'role')
  return role != null && AUX_ROLES.has(role.toLowerCase())
}

const localName = (node: XmlNode): string => {
  const colon = node.name.lastIndexOf(':')
  return colon < 0 ? node.name : node.name.slice(colon + 1)
}

/** 文本内容。跳过**子元素**里的翻译/罗马音与 ruby 注音（它们不属于歌词正文）， */
/** 但节点自己也可能是那类元素 —— 调用方要它的文字时就该拿到，所以不在入口处一刀切。 */
function plainText(node: XmlNode): string {
  if (isText(node)) return node.text
  let out = ''
  for (const child of node.children) out += childText(child)
  return out
}

function childText(node: XmlNode): string {
  if (isText(node)) return node.text
  if (isAux(node)) return ''
  const ruby = attrLocal(node, 'ruby')
  if (ruby === 'textContainer' || ruby === 'text') return ''
  return plainText(node)
}

function findDescendants(node: XmlNode, predicate: (child: XmlNode) => boolean, out: XmlNode[] = []): XmlNode[] {
  for (const child of node.children) {
    if (isText(child)) continue
    if (predicate(child)) out.push(child)
    else findDescendants(child, predicate, out)
  }
  return out
}

function hasTimedSpan(node: XmlNode): boolean {
  return findDescendants(node, child => localName(child) === 'span'
    && parseTime(attrLocal(child, 'begin')) != null
    && parseTime(attrLocal(child, 'end')) != null).length > 0
}

interface AuxText { text: string; lang: string }

interface LineBuilder {
  key: string | null
  startMs: number
  endMs: number
  words: LyricWord[]
  textParts: string[]
  translations: AuxText[]
  romanizations: AuxText[]
  leadWords: number
  backgroundWords: number
}

function rubyWord(container: XmlNode, fallbackStart: number, fallbackEnd: number): LyricWord {
  const base = findDescendants(container, child => attrLocal(child, 'ruby') === 'base')[0]
  const text = base ? plainText(base) : plainText(container)
  const rubyNodes = findDescendants(container, child => attrLocal(child, 'ruby') === 'text')
  const ruby = rubyNodes.map(node => plainText(node)).join('').trim()
  let startMs = parseTime(attrLocal(container, 'begin'))
  let endMs = parseTime(attrLocal(container, 'end'))
  if (startMs == null || endMs == null) {
    // 规范允许注音音节各自带时间戳（一个汉字对多个假名）。
    const timed = rubyNodes
      .map(node => ({ start: parseTime(attrLocal(node, 'begin')), end: parseTime(attrLocal(node, 'end')) }))
      .filter((item): item is { start: number; end: number } => item.start != null && item.end != null)
    if (timed.length > 0) {
      startMs = timed[0]!.start
      endMs = timed[timed.length - 1]!.end
    }
  }
  const word: LyricWord = {
    text,
    startMs: startMs ?? fallbackStart,
    endMs: endMs ?? fallbackEnd
  }
  if (ruby) word.ruby = ruby
  return word
}

function collectAux(node: XmlNode, builder: LineBuilder): void {
  for (const child of node.children) {
    if (isText(child)) continue
    const role = attrLocal(child, 'role')?.toLowerCase()
    if (role === 'x-translation' || role === 'x-roman') {
      const text = plainText(child).trim()
      if (text) {
        const entry = { text, lang: (attrLocal(child, 'lang') ?? '').toLowerCase() }
        if (role === 'x-translation') builder.translations.push(entry)
        else builder.romanizations.push(entry)
      }
      continue
    }
    collectAux(child, builder)
  }
}

function walk(node: XmlNode, builder: LineBuilder, lineStart: number, lineEnd: number, background: boolean): void {
  for (const child of node.children) {
    if (isText(child)) { builder.textParts.push(child.text); continue }

    const role = attrLocal(child, 'role')?.toLowerCase()
    if (role === 'x-translation' || role === 'x-roman') {
      // 注意这里必须 continue 而不是 return：辅助轨常常是 <p> 的最后几个子元素，
      // 但它们也可能夹在正文中间（背景人声块之后还有主句），提前返回会吞掉后面的字。
      const text = plainText(child).trim()
      if (text) {
        const entry = { text, lang: (attrLocal(child, 'lang') ?? '').toLowerCase() }
        if (role === 'x-translation') builder.translations.push(entry)
        else builder.romanizations.push(entry)
      }
      continue
    }

    const rubyKind = attrLocal(child, 'ruby')
    if (rubyKind === 'container') {
      const word = rubyWord(child, lineStart, lineEnd)
      builder.words.push(word)
      if (background) builder.backgroundWords++
      else builder.leadWords++
      collectAux(child, builder)
      continue
    }
    if (rubyKind === 'base' || rubyKind === 'textContainer' || rubyKind === 'text') {
      // 没有 container 包裹的裸 ruby 结构：按普通文字处理，宁可显示原文也不吞字。
      builder.textParts.push(plainText(child))
      continue
    }

    const childBackground = background || role === 'x-bg'
    const begin = parseTime(attrLocal(child, 'begin'))
    const end = parseTime(attrLocal(child, 'end'))
    if (localName(child) === 'span' && begin != null && end != null) {
      const text = plainText(child)
      if (text) {
        builder.words.push({ text, startMs: begin, endMs: Math.max(begin, end) })
        if (childBackground) builder.backgroundWords++
        else builder.leadWords++
      }
      collectAux(child, builder)
      continue
    }
    // 背景人声包装层：它自己可能没有时间戳，里面才是带时间的音节。
    if (role === 'x-bg' && !hasTimedSpan(child)) {
      builder.textParts.push(plainText(child))
      collectAux(child, builder)
      continue
    }
    walk(child, builder, lineStart, lineEnd, childBackground)
  }
}

function preferredAux(list: AuxText[]): string | undefined {
  if (list.length === 0) return undefined
  const chinese = list.find(item => item.lang.startsWith('zh'))
  return (chinese ?? list[0]!).text || undefined
}

function collectHeadAux(root: XmlNode, kind: 'translations' | 'transliterations'): Map<string, { text: string; lang: string }> {
  const out = new Map<string, { text: string; lang: string }>()
  const containers = findDescendants(root, node => localName(node) === kind)
  for (const container of containers) {
    const blocks = container.children.filter((child): child is XmlNode => !isText(child) && localName(child) === kind.slice(0, -1))
    for (const block of blocks) {
      const lang = (attrLocal(block, 'lang') ?? '').toLowerCase()
      const texts = findDescendants(block, node => localName(node) === 'text')
      // 优先中文翻译；音译优先 ja-Latn，其次任意。同一条目可能有多语言，取最好的那个。
      const rank = kind === 'translations'
        ? (candidate: string): number => (candidate.startsWith('zh') ? 0 : 1)
        : (candidate: string): number => (candidate.startsWith('ja-latn') ? 0 : 1)
      for (const text of texts) {
        const forKey = attrLocal(text, 'for')
        if (!forKey) continue
        const value = plainText(text).trim()
        if (!value) continue
        const previous = out.get(forKey)
        if (previous == null || rank(lang) < rank(previous.lang)) out.set(forKey, { text: value, lang })
      }
    }
  }
  return out
}

export interface TtmlLyrics { lines: LyricLine[]; wordByWord: boolean }

export function parseTtml(source: string): TtmlLyrics | null {
  if (!source || source.length > MAX_SOURCE_CHARS) return null
  const root = parseXml(source)
  if (!root) return null
  const body = findDescendants(root, node => localName(node) === 'body')[0]
  if (!body) return null

  const paragraphs = findDescendants(body, node => localName(node) === 'p')
  if (paragraphs.length === 0) return null
  const headTranslations = collectHeadAux(root, 'translations')
  const headTransliterations = collectHeadAux(root, 'transliterations')

  const builders: LineBuilder[] = []
  for (const paragraph of paragraphs) {
    const startMs = parseTime(attrLocal(paragraph, 'begin'))
    if (startMs == null) continue
    const endMs = parseTime(attrLocal(paragraph, 'end'))
    const builder: LineBuilder = {
      key: attrLocal(paragraph, 'key') ?? null,
      startMs,
      endMs: endMs != null && endMs > startMs ? endMs : startMs,
      words: [],
      textParts: [],
      translations: [],
      romanizations: [],
      leadWords: 0,
      backgroundWords: 0
    }
    walk(paragraph, builder, startMs, builder.endMs, false)
    builders.push(builder)
  }
  if (builders.length === 0) return null

  builders.sort((a, b) => a.startMs - b.startMs)
  const lines: LyricLine[] = builders.map((builder, index) => {
    const next = builders[index + 1]
    const endMs = builder.endMs > builder.startMs
      ? builder.endMs
      : next ? next.startMs : builder.startMs + 5000
    const words = builder.words
      .map((word, wordIndex) => {
        const following = builder.words[wordIndex + 1]
        const stop = word.endMs > word.startMs
          ? word.endMs
          : following ? Math.max(word.startMs, following.startMs) : Math.max(word.startMs, endMs)
        return word.endMs === stop ? word : { ...word, endMs: stop }
      })
      .sort((a, b) => a.startMs - b.startMs)
    const joined = words.map(word => word.text).join('')
    const text = (joined || builder.textParts.join('')).replace(/\s+/g, ' ').trim()
    const line: LyricLine = { startMs: builder.startMs, endMs, words, text }
    const translation = preferredAux(builder.translations)
      ?? (builder.key ? headTranslations.get(builder.key)?.text : undefined)
    if (translation && translation !== text) line.translation = translation
    const romanization = preferredAux(builder.romanizations)
      ?? (builder.key ? headTransliterations.get(builder.key)?.text : undefined)
    if (romanization) line.romanization = romanization
    if (builder.backgroundWords > 0 && builder.leadWords === 0) line.background = true
    return line
  }).filter(line => line.text.length > 0 || line.translation != null)

  if (lines.length === 0) return null
  const wordByWord = lines.every(line => line.words.length > 0)
  return { lines, wordByWord }
}
