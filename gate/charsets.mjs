/**
 * 目标字符集元数据。
 *
 * 这里只放"事实"：iconv-lite 使用的编码名、族别（单字节/双字节/Unicode/有状态）、
 * 是否无损、超集关系、检测时的期望文字种类。判定逻辑一律走 probe.mjs 的真实回环，
 * 不在此处写死任何"某个字符能否表示"的结论。
 */

/**
 * kind:
 *   unicode  —— 覆盖全部 Unicode 码点，转码不会丢字，只可能因目标为 UTF-16/32 而改变字节序
 *   sbcs     —— 单字节编码，1 字节 1 字符，可表示集合很小
 *   dbcs     —— 双字节/多字节编码，字符按表映射
 *   stateful —— 有状态编码（转义序列切换），逐字符拼接不等于整串字节
 */
export const CHARSETS = Object.freeze({
  "utf-8": {
    key: "utf-8",
    iconv: "utf-8",
    label: "UTF-8",
    kind: "unicode",
    lossless: true,
    aliases: ["utf8", "u8"],
    note: "任意改写都可逆；BOM 由调用方决定是否写入"
  },
  "utf-16le": {
    key: "utf-16le",
    iconv: "utf-16le",
    label: "UTF-16LE",
    kind: "unicode",
    lossless: true,
    aliases: ["utf16le", "ucs2", "ucs-2"],
    note: "无 BOM；与 Windows 内部 wchar_t 一致"
  },
  "utf-16be": {
    key: "utf-16be",
    iconv: "utf-16be",
    label: "UTF-16BE",
    kind: "unicode",
    lossless: true,
    aliases: ["utf16be"],
    note: "无 BOM"
  },
  "utf-32le": {
    key: "utf-32le",
    iconv: "utf-32le",
    label: "UTF-32LE",
    kind: "unicode",
    lossless: true,
    aliases: ["utf32le"],
    note: "定长 4 字节，体积为 UTF-8 的 2–4 倍"
  },
  gbk: {
    key: "gbk",
    iconv: "gbk",
    label: "GBK",
    kind: "dbcs",
    lossless: false,
    aliases: ["cp936", "ms936", "windows-936"],
    supersetOf: ["gb2312"],
    upgradeTo: "gb18030",
    note: "简体中文 Windows 遗留默认；不含 emoji 与大量生僻字"
  },
  gb18030: {
    key: "gb18030",
    iconv: "gb18030",
    label: "GB18030",
    kind: "dbcs",
    lossless: false,
    aliases: ["gb-18030"],
    supersetOf: ["gbk", "gb2312"],
    note: "GBK 的超集，含四字节区；中文环境下最接近无损的\"遗留\"选择"
  },
  big5: {
    key: "big5",
    iconv: "big5",
    label: "Big5",
    kind: "dbcs",
    lossless: false,
    aliases: ["cp950", "csbig5"],
    upgradeTo: "big5hkscs",
    note: "繁体中文遗留默认；不含简体专用字"
  },
  big5hkscs: {
    key: "big5hkscs",
    iconv: "big5hkscs",
    label: "Big5-HKSCS",
    kind: "dbcs",
    lossless: false,
    aliases: ["big5-hkscs"],
    supersetOf: ["big5"],
    note: "香港增补字符集，Big5 超集"
  },
  shiftjis: {
    key: "shiftjis",
    iconv: "shift_jis",
    label: "Shift_JIS",
    kind: "dbcs",
    lossless: false,
    aliases: ["shift_jis", "sjis", "cp932", "ms932", "windows-31j"],
    upgradeTo: "utf-8",
    note: "日文 Windows 遗留默认；JIS X 0208 之外大量字符不可表示"
  },
  eucjp: {
    key: "eucjp",
    iconv: "euc-jp",
    label: "EUC-JP",
    kind: "dbcs",
    lossless: false,
    aliases: ["euc-jp", "x-euc-jp"],
    note: "日文 Unix 遗留默认"
  },
  cp949: {
    key: "cp949",
    iconv: "cp949",
    label: "CP949（UHC）",
    kind: "dbcs",
    lossless: false,
    aliases: ["uhc", "ks_c_5601-1987", "euc-kr"],
    note: "韩文 Windows 遗留默认；euc-kr 在 iconv-lite 中落到本表"
  },
  "windows-1252": {
    key: "windows-1252",
    iconv: "windows-1252",
    label: "Windows-1252",
    kind: "sbcs",
    lossless: false,
    aliases: ["cp1252", "latin1", "iso-8859-1", "binary"],
    note: "西欧单字节；0x80–0x9F 区间被微软重定义为可见字符"
  },
  ascii: {
    key: "ascii",
    iconv: "us-ascii",
    label: "US-ASCII",
    kind: "sbcs",
    lossless: false,
    aliases: ["us-ascii", "ansi_x3.4-1968"],
    note: "仅 0x00–0x7F；任何非 ASCII 字符都会丢"
  },
  utf7: {
    key: "utf7",
    iconv: "utf7",
    label: "UTF-7",
    kind: "stateful",
    lossless: true,
    aliases: ["utf-7"],
    note: "有状态编码：逐字符拼接字节 ≠ 整串字节，字节偏移不可按字符推算"
  }
})

/** 只用于探测的候选集合（顺序影响并列时的排序，不影响评分）。 */
export const DETECT_CANDIDATES = Object.freeze([
  "utf-8",
  "gb18030",
  "gbk",
  "big5",
  "big5hkscs",
  "shiftjis",
  "eucjp",
  "cp949",
  "windows-1252"
])

const ALIAS_INDEX = (() => {
  const idx = new Map()
  for (const cs of Object.values(CHARSETS)) {
    idx.set(cs.key.toLowerCase(), cs)
    idx.set(cs.iconv.toLowerCase(), cs)
    for (const a of cs.aliases || []) idx.set(a.toLowerCase(), cs)
  }
  return idx
})()

/**
 * 把用户输入（编码名/别名）解析成元数据；不认识则返回 null。
 * @param {string} name
 */
export function resolveCharset (name) {
  if (!name || typeof name !== "string") return null
  return ALIAS_INDEX.get(name.trim().toLowerCase().replace(/_/g, "-")) || null
}

/**
 * 供 --to 使用的稳定列表（按族分组，便于文档与 CLI 帮助输出）。
 */
export function listCharsets () {
  return Object.values(CHARSETS).map((cs) => ({
    key: cs.key,
    label: cs.label,
    kind: cs.kind,
    lossless: cs.lossless,
    note: cs.note
  }))
}
