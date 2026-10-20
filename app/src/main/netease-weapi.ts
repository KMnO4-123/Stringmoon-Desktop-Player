import crypto from 'node:crypto'

/**
 * 网易云 weapi 参数加密 —— **只为了拿字级歌词**。
 *
 * 为什么要碰加密：契约 §4.4 第 3 顺位写的是「网易云 yrc 带 yv=-1 即返回字级」。
 * 实测（2026-10-17）证明：明文接口 `/api/song/lyric` 与 `/api/song/lyric/v1` **永远不返回 yrc**，
 * 只有 weapi 的 `/weapi/song/lyric` 会返回。所以不加密就永远看不到字级数据。
 * 加密后实测 6 首中文歌 **3 首有 yrc**（陈奕迅/邓紫棋/TestSinger 有，周杰伦翻唱/林俊杰/毛不易 无），
 * 而日文歌 4 首全部没有 —— 逐字打轴主要发生在中文歌上。
 *
 * 这套算法是公开的、所有第三方网易云客户端都在用的同一套：
 *   ① 两次 AES-128-CBC（固定 nonce → 随机 secret），得到 params
 *   ② 把 secret 反转后当作大整数做教科书式 RSA（无填充），得到 encSecKey
 * 这里只用 node:crypto 与 BigInt，不引依赖。
 *
 * ⚠️ 若将来接入契约 §6.1 指定的 `@neteasecloudmusicapienhanced/api`，这个模块可以整块删掉；
 * 它存在只是为了**今天**能验证「yrc 到底有没有」，以及在没有平台层的情况下把字级歌词用起来。
 */

const IV = Buffer.from('0102030405060708')
const NONCE = '0CoJUm6Qyw8W8jud'
const PUBKEY = '010001'
const MODULUS = '00e0b509f6259df8642dbc35662901477df22677ec152b5ff68ace615bb7b7251523ab17a876aea8a5aa76d2e417629ec4ee341f56135fccf695280104e0312ecbda92557c93870114af6c9d05c4f7f0c3685b7a46bee255932575cce10b424d813cfe4875d3e82047b97ddef52741d546b8e289dc6935b3ece0462db0a22b8e7'

export const NETEASE_LYRIC_URL = 'https://music.163.com/weapi/song/lyric?csrf_token='

/** weapi 只认这些头：普通 GET 用的那些不够，会拿到空响应。 */
export const NETEASE_WEAPI_HEADERS: Record<string, string> = {
  'content-type': 'application/x-www-form-urlencoded',
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  referer: 'https://music.163.com/',
  origin: 'https://music.163.com',
  cookie: 'os=pc; appver=2.9.7'
}

function aesBase64(text: string, key: string): string {
  const cipher = crypto.createCipheriv('aes-128-cbc', Buffer.from(key, 'utf8'), IV)
  return Buffer.concat([cipher.update(Buffer.from(text, 'utf8')), cipher.final()]).toString('base64')
}

function modPow(base: bigint, exponent: bigint, modulus: bigint): bigint {
  let result = 1n
  let factor = base % modulus
  let power = exponent
  while (power > 0n) {
    if (power & 1n) result = (result * factor) % modulus
    factor = (factor * factor) % modulus
    power >>= 1n
  }
  return result
}

/** secret 反转 → 十六进制 → 大整数 → 模幂 → 定长 256 位十六进制。 */
export function rsaEncrypt(secret: string): string {
  const reversed = secret.split('').reverse().join('')
  const value = BigInt('0x' + Buffer.from(reversed, 'utf8').toString('hex'))
  return modPow(value, BigInt('0x' + PUBKEY), BigInt('0x' + MODULUS)).toString(16).padStart(256, '0')
}

export function randomSecret(): string {
  return crypto.randomBytes(8).toString('hex').slice(0, 16)
}

/** 生成 POST 表单体。secret 只在测试里注入，生产随机。 */
export function weapiForm(payload: Record<string, unknown>, secret: string = randomSecret()): string {
  const params = aesBase64(aesBase64(JSON.stringify(payload), NONCE), secret)
  return new URLSearchParams({ params, encSecKey: rsaEncrypt(secret) }).toString()
}

export interface NeteaseRichLyric {
  code?: number
  yrc?: { lyric?: string }
  lrc?: { lyric?: string }
  tlyric?: { lyric?: string }
  romalrc?: { lyric?: string }
  ytlrc?: { lyric?: string }
  yromalrc?: { lyric?: string }
}
