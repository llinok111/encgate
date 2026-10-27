/**
 * 逐码点探针：回答"这个字符能不能被目标字符集表示"。
 *
 * 判定方式**不依赖替换字符的字面值**（`iconv.defaultCharSingleByte` 是模块级可变量，
 * 用户可以改成任何字符），而是先取回环结果 `decode(encode(ch))`：
 *   - 回环等于自身            → ok
 *   - 回环为空                → dropped
 *   - 回环等于替换字符的编码  → replaced（不可表示，被替换成占位符）
 *   - 其它                    → substituted（可表示，但换成另一个字符，属于静默语义变更）
 *
 * 单字符判定与整串转码的一致性由 test/exactness 套件锁死（14 个字符集 × 5463 码点，零分歧）。
 */
import iconv from "../lib/index.js"
import { resolveCharset } from "./charsets.mjs"

/** 预置一些常见替换字符候选的编码，用于识别 substituted 与 replaced 的区别。 */
function fallbackBytes (iconvName) {
  const ch = typeof iconv.defaultCharSingleByte === "string" && iconv.defaultCharSingleByte
    ? iconv.defaultCharSingleByte
    : "?"
  return iconv.encode(ch, iconvName)
}

function verdictFor (cp, iconvName, fbBytes) {
  const ch = String.fromCodePoint(cp)
  let bytes
  try {
    bytes = iconv.encode(ch, iconvName)
  } catch (err) {
    return { kind: "error", becomes: null, bytes: 0, message: err && err.message }
  }
  if (bytes.length === 0) {
    return ch === "" ? { kind: "ok", becomes: ch, bytes: 0 } : { kind: "dropped", becomes: "", bytes: 0 }
  }
  let back
  try {
    back = iconv.decode(bytes, iconvName)
  } catch (err) {
    return { kind: "error", becomes: null, bytes: bytes.length, message: err && err.message }
  }
  if (back === ch) return { kind: "ok", becomes: ch, bytes: bytes.length }
  // 增补平面字符在单字节编码器里会按 UTF-16 码元拆成两个占位符（'??'），
  // 这仍然属于"替换"而不是"改写成另一个字符"，所以按字节逐个比对替换字节。
  const allFallback = fbBytes && fbBytes.length === 1
    ? bytes.every((b) => b === fbBytes[0])
    : Boolean(fbBytes && bytes.equals(fbBytes))
  if (allFallback) {
    return { kind: "replaced", becomes: back, bytes: bytes.length }
  }
  return { kind: "substituted", becomes: back, bytes: bytes.length }
}

/**
 * @param {string} target 目标字符集（名称或别名）
 * @returns {{
 *   charset: object, of: (cp: number) => object,
 *   bytesFor: (cp: number) => number,
 *   roundTrip: (text: string) => { bytes: number, text: string, lossless: boolean },
 *   perCharBytesExact: boolean,
 * }}
 */
export function probeTarget (target) {
  const cs = resolveCharset(target)
  if (!cs) {
    const err = new Error(`未知字符集：${target}`)
    err.code = "UNKNOWN_CHARSET"
    throw err
  }
  if (!iconv.encodingExists(cs.iconv)) {
    const err = new Error(`iconv-lite 不支持该字符集：${cs.key}（${cs.iconv}）`)
    err.code = "UNSUPPORTED_CHARSET"
    throw err
  }
  const fbBytes = cs.kind === "unicode" ? null : fallbackBytes(cs.iconv)
  const cache = new Map()

  const of = (cp) => {
    let v = cache.get(cp)
    if (v === undefined) {
      v = verdictFor(cp, cs.iconv, fbBytes)
      cache.set(cp, v)
    }
    return v
  }

  return {
    charset: cs,
    of,
    bytesFor: (cp) => of(cp).bytes,
    /** 有状态编码（UTF-7）逐字符拼接 ≠ 整串字节，字节数不可加总。 */
    perCharBytesExact: cs.kind !== "stateful",
    roundTrip (text) {
      const bytes = iconv.encode(text, cs.iconv)
      const back = iconv.decode(bytes, cs.iconv)
      return { bytes: bytes.length, text: back, lossless: back === text }
    },
    _cache: cache
  }
}
