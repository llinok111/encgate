/**
 * encgate 公共 API。
 *
 * 这是一个**转码闸门**，不是编码探测器：核心承诺是"在产出字节之前，精确说出会丢哪些字"。
 * 已乱码文件的取证与还原不在本项目范围内（那是另一条工具链的事），此处不提供 repair。
 */
export { analyze, applySuggestions } from "./analyze.mjs"
export { detect, utf8Validity } from "./detect.mjs"
export { CHARSETS, DETECT_CANDIDATES, listCharsets, resolveCharset } from "./charsets.mjs"
export { probeTarget } from "./probe.mjs"
export { suggestFor } from "./suggest.mjs"
export { EXIT, preflight, transcode, transcodeFile, VERSION } from "./transcode.mjs"
