import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parseTtml } from '../src/shared/ttml.ts'
import { parseYrc } from '../src/shared/yrc.ts'
import { detectLyricsFormat, parseLyricsDocument } from '../src/shared/lyrics-parse.ts'
import { neteaseLyrics } from '../src/shared/netease-lyrics.ts'
import { deriveTrackIdentity, matchKey, artistTokens } from '../src/shared/track-identity.ts'

const fixture = (name) => readFileSync(new URL('../fixtures/lyrics/' + name, import.meta.url), 'utf8')

test('TTML: word spans, inline translation and romanization, background vocal, ruby, head aux tracks', () => {
  const parsed = parseTtml(fixture('feature.ttml'))
  assert.ok(parsed, 'feature.ttml must parse')
  const lines = parsed.lines
  assert.equal(lines.length, 4)

  // L1：两个音节 + 行内翻译 + 行内罗马音
  assert.equal(lines[0].text, '雨上がり')
  assert.deepEqual(lines[0].words.map(w => [w.text, w.startMs, w.endMs]), [['雨', 500, 1000], ['上がり', 1000, 1500]])
  assert.equal(lines[0].translation, '雨停了')
  assert.equal(lines[0].romanization, 'a me a ga ri')

  // L2：背景人声（带自己的翻译）并进同一行 —— AMLL 的渲染就是这样。
  // 实体也必须解开：&amp; 是 '&'，不是字面上的四个字符。
  assert.equal(lines[1].text, '傘 & 街(信じてる)')
  assert.equal(lines[1].translation, '我如此坚信', 'nested x-bg translation is the line translation')

  // L3：注音（ruby）按字标注，时间取注音音节自己的时间；
  // 行内没有 x-roman，所以罗马音回落到 head 的 transliterations。
  assert.deepEqual(lines[2].words.map(w => [w.text, w.ruby, w.startMs, w.endMs]), [
    ['所', 'しょ', 6000, 6400],
    ['詮', 'せん', 6400, 7000],
    ['なし', undefined, 7000, 8000]
  ])
  assert.equal(lines[2].translation, '都一样', 'multi-language inline translation prefers Chinese')
  assert.equal(lines[2].romanization, 'sho sen na shi')

  // L4：没有字级时间的行 —— words 必须为空数组，不能凭空插值（契约 §4.3 的诚实要求）
  assert.equal(lines[3].text, '行级歌词没有字级时间')
  assert.deepEqual(lines[3].words, [])
  assert.equal(parsed.wordByWord, false, 'mixed file is not word-by-word')
})

test('TTML: an AMLL-shaped file parses with every line word-by-word and translated', () => {
  // 形状取自真实 AMLL 导出（amll-ttml-db 的 ncm-lyrics 结构），正文已换成合成文本：
  // 公开仓库不带任何受版权保护的歌词。语法特征（逐字 span、行内翻译、head 头信息）保持原样。
  const parsed = parseTtml(fixture('amll-real.ttml'))
  assert.ok(parsed)
  assert.equal(parsed.lines.length, 4)
  assert.equal(parsed.wordByWord, true)
  assert.equal(parsed.lines[0].translation, '合成歌词第一行')
  for (const line of parsed.lines) {
    assert.ok(line.words.length > 0, 'every line keeps its syllables')
    // 渲染不变式：逐字拼起来必须就是这一行的文本。
    assert.equal(line.words.map(w => w.text).join(''), line.text)
    for (const word of line.words) {
      assert.ok(word.endMs >= word.startMs, 'no inverted word ranges')
    }
  }
})

test('YRC: syllable offsets are ABSOLUTE milliseconds (measured against the real service)', () => {
  // 时间戳取自一次真实网易云 yrc 抓包（正文已换成合成文本，公开仓库不带版权歌词）：
  //   yrc: [21110,1660](21110,370,0)合(21480,340,0)成(21820,950,0)行
  //   lrc: [00:21.056]合成行
  // 若按「行首 + 偏移」读，第一个字会落到 42220 ms —— 比这一行结束还晚。
  const parsed = parseYrc(fixture('demo.yrc'))
  assert.ok(parsed)
  assert.equal(parsed.lines.length, 5, 'two credit lines + three lyric lines; stripping credits is the caller job')
  assert.equal(parsed.lines[2].startMs, 21110)
  assert.deepEqual(parsed.lines[2].words.map(w => [w.text, w.startMs, w.endMs]), [
    ['合', 21110, 21480], ['成', 21480, 21820], ['行', 21820, 22770]
  ])
  assert.equal(parsed.lines[2].text, '合成行')
  // 同一行内的字必须落在这一行的时间窗里 —— 这是「绝对偏移」最直接的判别式。
  for (const line of parsed.lines) {
    for (const word of line.words) {
      assert.ok(word.startMs >= line.startMs - 150 && word.startMs <= line.endMs + 150,
        word.text + '@' + word.startMs + ' escapes line ' + line.startMs + '..' + line.endMs)
    }
  }
})

test('YRC: the relative dialect is detected from the data instead of being assumed', () => {
  // 同一套格式存在「相对行首」的产出工具。两个方言都解析得通，靠数据自证选一个：
  // 绝对解释落不进本行区间、相对解释落得进去 —— 就用相对。
  const relative = parseYrc('[3000,2500](0,800,0)第(800,700,0)二(1500,500,0)行')
  assert.ok(relative)
  assert.deepEqual(relative.lines[0].words.map(w => [w.text, w.startMs, w.endMs]), [
    ['第', 3000, 3800], ['二', 3800, 4500], ['行', 4500, 5000]
  ])
  // 绝对方言（行首 3000、字偏移 3000）同样被认出来，不会被误当成相对。
  const absolute = parseYrc('[3000,2500](3000,800,0)第(3800,700,0)二(4500,500,0)行')
  assert.ok(absolute)
  assert.deepEqual(absolute.lines[0].words.map(w => w.startMs), [3000, 3800, 4500])
})

test('format detection goes by content, never by file extension', () => {
  assert.equal(detectLyricsFormat('<?xml version="1.0"?><tt><body></body></tt>'), 'ttml')
  assert.equal(detectLyricsFormat('\uFEFF<tt xmlns="http://www.w3.org/ns/ttml"></tt>'), 'ttml')
  assert.equal(detectLyricsFormat('[0,1000](0,200,0)字'), 'yrc')
  assert.equal(detectLyricsFormat('[00:12.00]line'), 'lrc')
  assert.equal(detectLyricsFormat('<00:12.00>enhanced'), 'lrc', 'enhanced LRC word tags are not XML')
  const lrc = parseLyricsDocument(fixture('demo-word.lrc'))
  assert.equal(lrc?.format, 'lrc')
  assert.ok((lrc?.lines.length ?? 0) > 0)
  assert.equal(parseLyricsDocument('   '), null)
  assert.equal(parseLyricsDocument('<tt><body><p>no timing</p></body></tt>'), null, 'a file with no timed line is not lyrics')
})

test('netease: three tracks pair by timestamp, credits are stripped, far-off lines stay unpaired', () => {
  const lines = neteaseLyrics({
    lrc: '[00:00.000] 作词 : Ayase\n[00:00.068] 作曲 : Ayase\n[00:01.000]無敵\n[00:02.000]知りたい\n[00:03.000]遠い',
    tlyric: '[00:01.000]无敌\n[00:02.030]想知道\n[00:03.900]太远了',
    romalrc: '[00:01.000]mu te ki\n[00:02.000]shi ri ta i'
  })
  assert.ok(lines)
  assert.equal(lines.lines.length, 3, 'the 作词/作曲 credit lines are not lyrics')
  assert.equal(lines.lines[0].text, '無敵')
  assert.equal(lines.lines[0].translation, '无敌')
  assert.equal(lines.lines[0].romanization, 'mu te ki')
  assert.equal(lines.lines[1].translation, '想知道', '30 ms apart still pairs')
  assert.equal(lines.lines[2].translation, undefined, '900 ms apart must NOT pair — a wrong translation is worse than none')
})

test('netease: the rich JSON lyric format is understood too', () => {
  const lines = neteaseLyrics({
    lrc: '{"t":0,"c":[{"tx":"作词: "},{"tx":"Ayase"}]}\n{"t":1000,"c":[{"tx":"無"},{"tx":"敵"}]}\n{"t":2000,"c":[{"tx":"知りたい"}]}'
  })
  assert.ok(lines)
  assert.equal(lines.lines.length, 2)
  assert.equal(lines.lines[0].text, '無敵')
  assert.equal(lines.lines[1].text, '知りたい')
})

test('track identity: 90 of the 91 local files carry no tags, so the filename must be split', () => {
  const fromFile = deriveTrackIdentity({ title: 'TEST ROID - TEST HELIX', artist: '', durationMs: 291000 })
  assert.deepEqual([fromFile.artist, fromFile.title, fromFile.derivedFrom], ['TEST ROID', 'TEST HELIX', 'filename'])
  // 真实文件名里的几种形态：多空格、逗号并列、带括号补注、feat.
  assert.deepEqual(
    [deriveTrackIdentity({ title: 'TestBand      - 测试曲' }).artist, deriveTrackIdentity({ title: 'TestBand      - 测试曲' }).title],
    ['TestBand', '测试曲']
  )
  assert.equal(deriveTrackIdentity({ title: 'TestArtist - oblivious (1)' }).title, 'oblivious (1)')
  assert.equal(deriveTrackIdentity({ title: 'TestDj - Bad Apple   feat.TestVocals(TestDj Remix)' }).artist, 'TestDj')
  // 有标签就以标签为准，绝不拿文件名覆盖作者的写法。
  const tagged = deriveTrackIdentity({ title: 'テスト曲', artist: 'TestBand', album: 'THE BOOK 3', durationMs: 213000 })
  assert.deepEqual([tagged.title, tagged.artist, tagged.derivedFrom], ['テスト曲', 'TestBand', 'tags'])
  // 切不开就当整串是歌名，艺人留空 —— 编不出来源就会搜出别人的歌。
  const plain = deriveTrackIdentity({ title: 'Hero Theme' })
  assert.deepEqual([plain.title, plain.artist], ['Hero Theme', ''])
})

test('match keys and artist tokens survive the messy real names', () => {
  assert.equal(matchKey('テストタイトル (1)'), matchKey('テストタイトル'))
  assert.equal(matchKey('Test World (Da Capo Version)'), matchKey('Test World'))
  assert.equal(matchKey('测试曲一 [MV]'), matchKey('测试曲一'))
  assert.deepEqual(artistTokens('Test City, Test Fair'), ['testcity', 'testfair'])
  assert.deepEqual(artistTokens('テストA, テストB, テストC'), ['テストa', 'テストb', 'テストc'])
  assert.equal(matchKey('ＴｅｓｔＢａｎｄ'), matchKey('TestBand'), 'full-width latin folds to half-width')
})
