#!/usr/bin/env node
/*
 * sync-skill-dist.cjs —— 把项目**当前**源码同步进技能包。
 *
 * 为什么要有这个脚本：
 *   技能包的 `assets/gateway/` 是"给别人部署用"的完整源码，原来靠**手工拷贝**维护 ——
 *   实测已经落后两个版本，而 SKILL.md 里却写着新功能，**描述与产物不一致**，比不同步更糟。
 *   这和"要人工补录才会动的列表 = 死列表"是同一个病。
 *
 * 同步三块：
 *   ① 网关源码（server.mjs / dashboard.html / 启动脚本 / README）
 *   ② 开发侧测试台（test/ → assets/gateway/test/）
 *   ③ 出包前自检（密钥 + 个人信息特征），命中即整体拒绝，不写任何一个文件
 *
 * 同步时会做两类改写（**只作用于技能包副本，不动项目源文件**）：
 *   · 路径自适应：测试脚本改用"逐级上找 server.mjs"定位项目根，包内包外同一份代码都能跑
 *   · 去个人信息：本机用户名 / 内部目录名 / 个人化归属措辞
 *
 * 用法：node scripts/sync-skill-dist.cjs [--check]
 *   --check  只做自检与清单报告，不写盘
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')
const SKILL = path.join(os.homedir(), '.workbuddy-ai', 'skills', 'xiaoji-free-model-gateway')
const GATEWAY_DST = path.join(SKILL, 'assets', 'gateway')
const TEST_SRC = path.join(ROOT, 'test')

const CHECK_ONLY = process.argv.includes('--check')

// 要同步的 [源文件, 技能包内相对路径]（代码 / 启动脚本 / 参考文档；数据与密钥类刻意不在列）
const TARGETS = [
  ['server.mjs', 'assets/gateway/server.mjs'],
  ['dashboard.html', 'assets/gateway/dashboard.html'],
  ['xiaoji-launcher.vbs', 'assets/gateway/xiaoji-launcher.vbs'],
  ['小鸡开关.bat', 'assets/gateway/小鸡开关.bat'],
  ['free_whitelist.json', 'assets/gateway/free_whitelist.json'],
  ['README.md', 'references/README.md'],
]

// 文本类才做改写（JSON 数据只做自检，不动内容）
const TEXT_EXT = /\.(mjs|html|md|cjs|bat|vbs|txt)$/i

// ═══════════════ 路径自适应（只对测试脚本）═══════════════
// 测试脚本用**自适应**方式定位项目根：从父目录逐级上找含 server.mjs 的目录。
// 于是同一份脚本在 <项目根>/test/ 与 <gateway>/test/ 下都能找对根目录，无需按包内外改写。
// PATH_FIX 只作兜底 —— 万一某脚本又写成 `__dirname/../..` 的老式两层上跳，这里能救回来。
// ⚠ 必须从 `path.dirname(__dirname)` 起步，不能从 __dirname 起步 ——
//    protocol-test 会把 server.mjs 拷进自己目录，从 __dirname 起步会在第二次运行时认错根目录。
const ROOT_AUTO =
  "(() => { const _fs = require('fs'), _p = require('path'); " +
  "let d = _p.dirname(__dirname); for (let i = 0; i < 6; i++) { " +
  "if (_fs.existsSync(_p.join(d, 'server.mjs'))) return d; d = _p.dirname(d) } " +
  "return _p.join(__dirname, '..') })()"

const PATH_FIX = [
  [/const ROOT = path\.join\(__dirname, '\.\.', '\.\.'\)/g, `const ROOT = ${ROOT_AUTO}`],
  [/const ROOT = path\.resolve\(__dirname, '\.\.\/\.\.'\)/g, `const ROOT = ${ROOT_AUTO}`],
  [/const SRC = path\.join\(DIR, '\.\.', '\.\.'\)[^\n]*/g, `const SRC = ${ROOT_AUTO}`],
  [/path\.join\(__dirname, '\.\.', '\.\.', 'config\.json'\)/g, `path.join(${ROOT_AUTO}, 'config.json')`],
  [/path\.join\(__dirname, '\.\.', '\.\.', 'free_catalog\.json'\)[^\n]*/g, `path.join(__dirname, '..', 'free_catalog.json')`],
  [/path\.join\(ROOT, '\.workbuddy-ai\/testinst\/layout-check\.cjs'\)/g, `path.join(__dirname, 'layout-check.cjs')`],
  [/path\.join\(HERE, '\.\.', '\.\.', '\.\.', 'server\.mjs'\)/g, `path.join(${ROOT_AUTO}, 'server.mjs')`],
  [/path\.join\(HERE, '\.\.', '\.\.', '\.\.', 'dashboard\.html'\)/g, `path.join(${ROOT_AUTO}, 'dashboard.html')`],
]

// ═══════════════ 去个人信息（对所有文本）═══════════════
// 只动"能定位到人"和"个人化归属"的部分；泛指网关使用者的「用户」一词保持不变。
// 本机用户名**动态取**（写死某个名字只对一台机器有效，换人/换机就形同虚设）。
const USER_NAME = os.userInfo().username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const SANITIZE = [
  // ① 本机用户名与路径
  [new RegExp('C:\\\\+Users\\\\+' + USER_NAME, 'g'), 'C:\\Users\\<用户名>'],
  [new RegExp(USER_NAME, 'g'), '<用户名>'],
  // ② 内部工作目录名
  [/\.workbuddy-ai[\\/]testinst/g, 'test'],
  // ③ 个人化归属措辞 → 中性设计说明
  // ⚠ **只换名词短语、不插冒号** —— 原文的标点与语法照旧，否则会出现
  //    「设计约定：是"重复了吧"」「按设计约束：**不进正式名单**」这类读着别扭的句子。
  // ⚠ 长词必须排在短词前面（`用户明确反感过` 要在 `用户明确` 之前）。
  [/用户明确反感过/g, '曾被否过'],
  [/用户明确问过/g, '曾确认过'],
  [/用户明确否掉过/g, '已明确否掉过'],
  [/用户明确要求/g, '既定约束'],
  [/用户明确提出的/g, '既定原则'],
  [/用户明确/g, '既定要求'],
  [/用户原话/g, '设计约定'],
  [/用户反馈/g, '设计反馈'],
  [/用户要求/g, '设计约束'],
  [/用户说过/g, '反馈过'],
  [/用户认可/g, '既定认可'],
  [/用户说/g, '约定'],
  [/用户报障时/g, '排查故障时'],
  // ④ 含第一人称的引用整句改写
  // ⚠ 引文常**跨行**（中间夹着 `//   ` 续行注释），所以分隔符要用 `[\s\S]{0,n}?` 而不是 `\s*`。
  [/新增的怎么都是英文api,?[\s\S]{0,40}?我作为普通用户都不知道[\s\S]{0,40}?是干嘛的/g, '新增的全是英文 api，看不出是哪家'],
  [/我作为普通用户都不知道\s*那几个是干嘛的/g, '裸域名看不出是哪家'],
  [/我不信每次都是那18家,?[\s\S]{0,30}?总有新的大厂给到免费模型,?[\s\S]{0,20}?比如阶跃星辰/g, '免费厂商名单长期不变'],
  [/你实测通过的怎么没往上面加？[\s\S]{0,20}?上面的列表没变过/g, '实测通过的厂商没进下拉'],
  [/不能它写什么我们就信什么/g, '不能源写什么就信什么'],
  // ⑤ 全包扫描补出的漏网变体（归因词不是"用户原话"那种标准写法）
  [/候选的厂家为什么你不测试呢,?\s*必须得我提供 ?key\?/g, '候选厂商能不能不接 Key 就给出结论'],
  [/候选的厂家为什么你不测试/g, '候选厂商能不能不接 Key 就测'],
  [/起因\(用户\)[:：]?\s*/g, '起因：'],
  [/这正是用户问/g, '这正是回答'],
  [/用户问过/g, '曾有过一问'],
  [/用户问/g, '曾有一问'],
  [/按你的要求/g, '按既定约束'],
]

// ═══════════════ 自检规则 ═══════════════
const SECRET_RES = [
  ['网关统一 Key', /freegw-[0-9a-f]{32}/],
  ['Groq Key', /gsk_[A-Za-z0-9]{20,}/],
  ['OpenRouter Key', /sk-or-v1-[A-Za-z0-9]{20,}/],
  ['Anthropic Key', /sk-ant-[A-Za-z0-9_-]{20,}/],
  ['Google Key', /AIza[A-Za-z0-9_-]{30,}/],
  ['OpenAI Key', /sk-(?:proj-)?[A-Za-z0-9_-]{40,}/],
  ['HuggingFace Key', /hf_[A-Za-z0-9]{30,}/],
  ['NVIDIA Key', /nvapi-[A-Za-z0-9_-]{30,}/],
  ['Cerebras Key', /csk-[A-Za-z0-9]{30,}/],
]

const PERSONAL_RES = [
  ['本机用户名', new RegExp(USER_NAME, 'i')],
  ['个人化归属措辞', /用户原话|用户明确要求|用户说|用户反馈|用户要求|用户问|起因\(用户\)|按你的要求/],
  ['旧测试目录名', /\.workbuddy-ai[\\/]testinst/],
]

const problems = []
const blobs = []

function audit(label, text) {
  for (const [name, re] of SECRET_RES) if (re.test(text)) problems.push(`${label} 命中密钥特征「${name}」`)
  for (const [name, re] of PERSONAL_RES) if (re.test(text)) problems.push(`${label} 命中个人信息特征「${name}」`)
}

function transform(text, isTest) {
  let s = text
  if (isTest) for (const [re, to] of PATH_FIX) s = s.replace(re, to)
  for (const [re, to] of SANITIZE) s = s.replace(re, to)
  return s
}

// ── 收集：网关源码 ──
for (const [src, rel] of TARGETS) {
  const from = path.join(ROOT, src)
  if (!fs.existsSync(from)) { problems.push(`缺源文件：${src}`); continue }
  const raw = fs.readFileSync(from, 'utf8')
  const s = TEXT_EXT.test(src) ? transform(raw, false) : raw
  audit(src, s)
  blobs.push([rel, s])
}

// ── 收集：测试台（只拷 .cjs，数据/残留一律不带）──
const TEST_SKIP = /\.(json|pid|log|png|prev)$/i
for (const sub of ['', 'hedge']) {
  const dir = path.join(TEST_SRC, sub)
  if (!fs.existsSync(dir)) continue
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!e.isFile() || !e.name.endsWith('.cjs') || TEST_SKIP.test(e.name)) continue
    const rel = sub ? `${sub}/${e.name}` : e.name
    const s = transform(fs.readFileSync(path.join(dir, e.name), 'utf8'), true)
    audit(`test/${rel}`, s)
    blobs.push([`assets/gateway/test/${rel}`, s])
  }
}

// ── 收集：技能包内已有文档（源即产物，只自检不改写）──
for (const rel of ['SKILL.md']) {
  const p = path.join(SKILL, rel)
  if (fs.existsSync(p)) audit(rel, fs.readFileSync(p, 'utf8'))
}
const refDir = path.join(SKILL, 'references')
if (fs.existsSync(refDir)) {
  for (const f of fs.readdirSync(refDir).sort()) {
    if (!f.endsWith('.md') || f.endsWith('.prev')) continue
    audit(`references/${f}`, fs.readFileSync(path.join(refDir, f), 'utf8'))
  }
}

if (problems.length) {
  console.error('[x] 自检不通过，未写入任何文件：')
  for (const p of problems) console.error('    · ' + p)
  process.exit(1)
}
console.log(`[✓] 自检通过（待写入 ${blobs.length} 个文件，密钥与个人信息 0 命中）`)

if (CHECK_ONLY) {
  for (const [rel] of blobs) console.log('  ' + rel)
  process.exit(0)
}

// ── 写入 ──
if (!fs.existsSync(GATEWAY_DST)) {
  console.error('✗ 目标目录不存在：' + GATEWAY_DST)
  process.exit(1)
}
for (const [rel, s] of blobs) {
  const to = path.join(SKILL, rel)
  fs.mkdirSync(path.dirname(to), { recursive: true })
  fs.writeFileSync(to, s, 'utf8')
  console.log(`✓ ${rel}  ${s.length} chars`)
}
console.log('同步完成 → ' + SKILL)
