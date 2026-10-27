/**
 * 替代建议表：给"目标字符集表示不了"的字符一个可执行的替代方案。
 *
 * 三条纪律：
 *  1. 只给**有语义依据**的映射（印刷体标点→ASCII、全角→半角、数学符号→ASCII 记法），
 *     不做"形近字替换"这种会改语义的动作。
 *  2. 每条建议都必须用 probe 复核一遍——替换后的字符串同样要在目标字符集里可表示，
 *     否则标 verified=false 并且不当作修复建议展示。
 *  3. risk 明确区分：lossless（语义等价）/ degrade（写法降级，可读性下降）/ drop（直接删除）。
 *
 * 表里没有任何"某个字符在 GBK 里可不可表示"的断言——那由 probe 现场判定。
 */

const RULES = [
  // ---- 空白与零宽
  { range: [[0x00a0, 0x00a0]], to: " ", why: "不换行空格 → 普通空格", risk: "lossless" },
  { range: [[0x2000, 0x200a]], to: " ", why: "各种宽度空格 → 普通空格", risk: "lossless" },
  { range: [[0x202f, 0x202f], [0x205f, 0x205f]], to: " ", why: "窄空格 → 普通空格", risk: "lossless" },
  { range: [[0x3000, 0x3000]], to: " ", why: "全角空格 → 半角空格", risk: "lossless" },
  { range: [[0x200b, 0x200d], [0xfeff, 0xfeff], [0x2060, 0x2060]], to: "", why: "零宽/不可见控制符，删除不影响可见文本", risk: "drop" },
  { range: [[0x0080, 0x009f]], to: "", why: "C1 控制字符，删除", risk: "drop" },

  // ---- 引号与破折号
  { range: [[0x2018, 0x201b]], to: "'", why: "弯单引号 → ASCII 单引号", risk: "lossless" },
  { range: [[0x201c, 0x201f]], to: "\"", why: "弯双引号 → ASCII 双引号", risk: "lossless" },
  { range: [[0x2010, 0x2015]], to: "-", why: "各类连字符/破折号 → ASCII 连字符", risk: "degrade" },
  { range: [[0x2212, 0x2212]], to: "-", why: "数学减号 → ASCII 连字符", risk: "lossless" },
  { range: [[0x2026, 0x2026]], to: "...", why: "省略号 → 三个句点", risk: "lossless" },
  { range: [[0x2032, 0x2032]], to: "'", why: "角分符号 → 单引号", risk: "degrade" },
  { range: [[0x2033, 0x2033]], to: "\"", why: "角秒符号 → 双引号", risk: "degrade" },
  { range: [[0x00b7, 0x00b7]], to: ".", why: "间隔号 → 句点", risk: "degrade" },
  { range: [[0x2022, 0x2022], [0x00b0, 0x00b0]], to: "*", why: "项目符号/度数符 → 星号", risk: "degrade" },

  // ---- 数学与符号
  { range: [[0x00d7, 0x00d7]], to: "x", why: "乘号 → 小写 x", risk: "lossless" },
  { range: [[0x00f7, 0x00f7]], to: "/", why: "除号 → 斜杠", risk: "lossless" },
  { range: [[0x00b1, 0x00b1]], to: "+/-", why: "正负号 → ASCII 记法", risk: "lossless" },
  { range: [[0x2264, 0x2264]], to: "<=", why: "小于等于 → <=", risk: "lossless" },
  { range: [[0x2265, 0x2265]], to: ">=", why: "大于等于 → >=", risk: "lossless" },
  { range: [[0x2260, 0x2260]], to: "!=", why: "不等于 → !=", risk: "lossless" },
  { range: [[0x2248, 0x2248]], to: "~", why: "约等于 → 波浪号", risk: "degrade" },
  { range: [[0x00a9, 0x00a9]], to: "(c)", why: "版权符 → (c)", risk: "lossless" },
  { range: [[0x00ae, 0x00ae]], to: "(R)", why: "注册符 → (R)", risk: "lossless" },
  { range: [[0x2122, 0x2122]], to: "(TM)", why: "商标符 → (TM)", risk: "lossless" },
  { range: [[0x20ac, 0x20ac]], to: "EUR", why: "欧元符 → EUR 文字", risk: "degrade" },
  { range: [[0x00a3, 0x00a3]], to: "GBP", why: "英镑符 → GBP 文字", risk: "degrade" },
  { range: [[0x2190, 0x2190]], to: "<-", why: "左箭头 → <-", risk: "lossless" },
  { range: [[0x2192, 0x2192]], to: "->", why: "右箭头 → ->", risk: "lossless" },
  { range: [[0x2191, 0x2191]], to: "^", why: "上箭头 → ^", risk: "degrade" },
  { range: [[0x2193, 0x2193]], to: "v", why: "下箭头 → v", risk: "degrade" },

  // ---- 全角 ASCII
  { range: [[0xff01, 0xff5e]], to: null, fullwidthToAscii: true, why: "全角 ASCII → 半角 ASCII", risk: "lossless" },

  // ---- 项目符号 / 图形
  { range: [[0x25a0, 0x25cf]], to: "*", why: "几何图形项目符号 → *", risk: "degrade" },
  { range: [[0x2605, 0x2606]], to: "*", why: "实心/空心星 → *", risk: "degrade" },
  { range: [[0x2500, 0x257f]], to: "-", why: "制表符 → 连字符（表格线会丢样式）", risk: "degrade" },

  // ---- emoji 与其他符号：无等价 ASCII，删除并显式告知
  { range: [[0x1f000, 0x1faff], [0x2600, 0x27bf], [0x2b00, 0x2bff], [0xfe0f, 0xfe0f], [0x1f1e6, 0x1f1ff]], to: "", why: "emoji/象形符号，目标字符集无对应，只能删除", risk: "drop" }
]

function pickRule (cp) {
  for (const rule of RULES) {
    for (const [lo, hi] of rule.range) {
      if (cp >= lo && cp <= hi) return rule
    }
  }
  return null
}

/**
 * @param {number} cp 码点
 * @param {ReturnType<import('./probe.mjs').probeTarget>} probe 目标字符集探针
 * @returns {null | {text: string, why: string, risk: string, verified: boolean}}
 */
export function suggestFor (cp, probe) {
  const rule = pickRule(cp)
  if (!rule) return null
  let text = rule.to
  if (rule.fullwidthToAscii) text = String.fromCodePoint(cp - 0xfee0)
  const chars = [...text]
  let verified = true
  for (const c of chars) {
    if (probe.of(c.codePointAt(0)).kind !== "ok") { verified = false; break }
  }
  if (text === "" && rule.risk !== "drop") verified = false
  return { text, why: rule.why, risk: rule.risk, verified }
}
