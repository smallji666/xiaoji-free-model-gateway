// 模型类型准入回归：网关只做文字对话，专用模型必须被说明性排除，不得进入 auto 池。
// 这不是仅靠名字的离线正则测试，而是读取真实刷新后 free_catalog.json，验证服务端实际判定结果。
const fs = require('fs')
const path = require('path')
// ⚠ free_catalog.json 必须用**主目录**那份(真实扫描结果)，不能用沙箱里那份几百字节的假样本 ——
// 拿假样本跑会 10 项全挂，而且报错全是 "目录已包含 Groq 扫描结果" 这种，
// 看不出真正原因是"读错文件了"。(2026-09-18 记过一次"要从主目录跑", 结果还是踩了第二次, 所以改成自动挑。)
// 策略: 在候选里挑**最大**的那份 —— 真实目录 50KB+, 假样本几百字节, 不会选错。
function loadCatalog() {
  const cands = [
    path.join(process.cwd(), 'free_catalog.json'),
    path.join(__dirname, '..', 'free_catalog.json')   // test/ -> 项目根
  ]
  let best = null, bestSize = -1
  for (const p of cands) {
    try { const sz = fs.statSync(p).size; if (sz > bestSize) { best = p; bestSize = sz } } catch {}
  }
  if (!best) return null
  console.log(`目录来源: ${best} (${bestSize} 字节)`)
  if (bestSize < 10000) console.warn(`⚠ 只有 ${bestSize} 字节, 不像真实扫描结果 —— 下面大概率全挂\n`)
  return JSON.parse(fs.readFileSync(best, 'utf8'))
}
const cat = loadCatalog()
// free_catalog.json 是 gitignore 的运行时产物（最近一次目录扫描结果），全新 clone / CI 里没有它。
// 这时**跳过而不是失败**：本套件验的是"扫描结果符合准入规则"，没有扫描结果就无从验起。
// 启动一次网关、等一轮目录扫描完成后再跑，即可覆盖这些断言。
if (!cat) {
  console.log('⊘ 跳过：找不到 free_catalog.json（运行时产物，不在版本库里）。')
  console.log('  启动一次网关、等一轮目录扫描完成后重跑即可。')
  process.exit(0)
}
let pass = 0, fail = 0
const t = (name, ok, detail = '') => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`) }
const get = (name) => cat.providers.find((p) => p.name === name)
const ex = (p) => (p && p.excluded) || []
const live = (p) => (p && p.models) || []
const has = (arr, part) => arr.some((x) => String(x.id || x).toLowerCase().includes(part.toLowerCase()))

const groq = get('groq')
const gemini = get('gemini')
const mistral = get('mistral')
const amd = get('amd')

// ⚠ 扫描无效（多为代理没开 → 上游一律 ECONNREFUSED）时**跳过而不是失败**：
//   那种情况下 `models` 与 `excluded` 会同时为空，"没排除任何东西"是环境造成的，
//   不是准入规则坏了 —— 报红只会误导（本项目反复强调的"假 FAIL"会训练人忽略闸门）。
//   判据是"这一家到底扫到模型没有"，**不是**"excluded 是不是空" ——
//   若真扫到了模型却没排除（真实回归），下面照常报 FAIL。
const scanned = (p) => !!(p && !p.error && (p.models || []).length > 0)
const unscanned = [['groq', groq], ['gemini', gemini], ['mistral', mistral]]
  .filter(([, p]) => !scanned(p)).map(([n]) => n)
if (unscanned.length) {
  console.log(`⊘ 跳过：${unscanned.join('、')} 本轮没有有效扫描结果（多为代理未开 / 上游不通）。`)
  console.log('  这几家的排除规则无从验起 —— 开代理后启动一次网关、等扫描完成再跑。')
  process.exit(0)
}
t('目录已包含 Groq 扫描结果', !!groq)
t('Groq TTS 已排除', has(ex(groq), 'orpheus'), ex(groq).filter((x) => /orpheus/i.test(x.id)).map((x) => x.kind).join(', '))
t('Groq 审核模型已排除', has(ex(groq), 'prompt-guard') && has(ex(groq), 'safeguard'))
t('Groq Whisper 已排除', has(ex(groq), 'whisper'))
t('Gemini 原生音频/TTS 已排除', has(ex(gemini), 'native-audio') && has(ex(gemini), 'tts'))
t('Mistral embedding 已排除', has(ex(mistral), 'embed'))
t('Mistral OCR/审核已排除', has(ex(mistral), 'ocr') && has(ex(mistral), 'moderation'))
// ⚠ 2026-11-07 修：旧版硬要求 `excluded` 里必须出现 mineru。实测 11-07 上游本轮**根本没提供**
//   这个模型（amd 扫到 3 个可路由 / 4 个排除，无 mineru），于是报一条"MinerU 已排除"的假红 ——
//   上游下架模型不是准入规则坏了，这跟 free-eval 把"上游没收录"说成"该改 CASES"是同一个病。
//   改成三态：在可路由目录里 = 真回归(FAIL)；在排除列表里 = PASS；本轮没这个模型 = SKIP。
//   ⚠ SKIP 不等于"这条不看了"：紧跟着一条**不依赖模型名**的性质断言兜底 ——
//     凡是本轮被判「上游元数据输出为非文本」的模型，一个都不许出现在可路由目录里。
//     这样既不会因上游下架假红，也不会把真回归养成"一个一直绿的闸门"。
let skipped = 0
const skip = (name, why) => { skipped++; console.log(`SKIP  ${name}  — ${why}`) }
if (has(live(amd), 'mineru')) {
  t('AMD MinerU 元数据非文本输出已排除', false, '⚠ MinerU 出现在可路由目录里 —— 真回归')
} else if (has(ex(amd), 'mineru')) {
  t('AMD MinerU 元数据非文本输出已排除', true, ex(amd).filter((x) => /mineru/i.test(x.id)).map((x) => x.kind).join(', '))
} else {
  skip('AMD MinerU 元数据非文本输出已排除', '上游本轮未提供该模型（样本假设失效），不是准入规则坏了')
}
if (scanned(amd)) {
  const metaExcluded = ex(amd).filter((x) => /上游元数据输出为/.test(String(x.reason || '')))
  t('⚠ 反断言: AMD 元数据非文本输出模型一个都不许进可路由目录',
    !metaExcluded.some((x) => has(live(amd), x.id)),
    metaExcluded.filter((x) => has(live(amd), x.id)).map((x) => x.id).join(', '))
} else {
  skip('AMD 元数据非文本输出的性质断言', 'amd 本轮没有有效扫描结果')
}

// 最重要的断言：已被识别为专用的模型绝不能同时留在可路由目录。
for (const p of cat.providers) {
  const both = ex(p).filter((x) => has(live(p), x.id))
  t(`${p.label} 排除项不进入文字对话目录`, both.length === 0, both.map((x) => x.id).join(', '))
}
// catalog 里的可路由模型仍应均有明确类型，避免以后有人往 entry.models 塞未标注对象。
for (const p of cat.providers) {
  const unknown = live(p).filter((x) => x.type && x.type !== '文字对话')
  t(`${p.label} 路由目录只保留文字对话类型`, unknown.length === 0)
}
console.log(`\n${fail ? '✗' : '✓'} ${pass}/${pass + fail} 通过${skipped ? ` ｜ ${skipped} 跳过` : ''}`)
process.exit(fail ? 1 : 0)
