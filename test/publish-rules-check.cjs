// publish-rules-check.cjs —— 发布闸门自身的回归。
//
// 为什么值得单独一个套件：`scripts/publish-rules.cjs` 的注释写着"唯一判据来源"，
// 但"唯一"这件事**只靠人记**是守不住的 —— 2026-11-07 实测过：同一份密钥判据在
// check-secrets / make-dist / pack-skill 里各抄了一份，已经漂了（Groq {30,} vs {20,}、
// OpenRouter 只认 hex、缺 Bearer）。漂了的判据不是"少抓几条"，是"抓不到"。
// 所以这里把三件只写在注释里的事变成会报红的断言：
//   ① 判据只有一份（打包脚本里不能再出现第二份密钥特征）
//   ② 去敏只改路径里的用户名，**不能**把品牌名一起改掉（本机用户名恰好也叫 xiaoji）
//   ③ 自检失败时只报特征名，绝不回显命中原文（脚本输出常被贴进 Issue）
//
// ⚠ 本套件全部是文件级断言：不读 config.json、不起网关、不碰网络、不占端口。
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

// ⚠ 从 `path.dirname(__dirname)` 起步（红线：protocol-test 会把 server.mjs 拷进 test/）
const ROOT = (() => { const _fs = require('fs'), _p = require('path'); let d = _p.dirname(__dirname); for (let i = 0; i < 6; i++) { if (_fs.existsSync(_p.join(d, 'server.mjs'))) return d; d = _p.dirname(d) } return _p.join(__dirname, '..') })()

let pass = 0, fail = 0
const ok = (c, m) => { if (c) { pass++; console.log('  PASS  ' + m) } else { fail++; console.log('  FAIL  ' + m) } }

ok(fs.existsSync(path.join(ROOT, 'scripts', 'publish-rules.cjs')), `项目根定位正确（${ROOT}）`)

const RULES = require(path.join(ROOT, 'scripts', 'publish-rules.cjs'))
const { USER, SECRET_RES, PERSONAL_RES, SANITIZE, FORBIDDEN_NAME } = RULES

// ── [1] 每条密钥特征都真的能命中 ──
// 构造样本（**全是假的**，只为匹配形状，不是任何真实 Key）
console.log('\n[1] 密钥特征必须真的能命中（假样本，非真实 Key）')
const SECRET_SAMPLES = {
  '网关统一 Key': 'freegw-' + 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6',
  'Groq Key': 'gsk_' + 'x'.repeat(24),
  'OpenRouter Key': 'sk-or-v1-' + 'y'.repeat(24),
  'Anthropic Key': 'sk-ant-api03-' + 'z'.repeat(24),
  'Google Key': 'AIza' + 'Q'.repeat(32),
  'OpenAI Key': 'sk-proj-' + 'w'.repeat(44),
  'HuggingFace Key': 'hf_' + 'v'.repeat(32),
  'NVIDIA Key': 'nvapi-' + 'u'.repeat(32),
  'Cerebras Key': 'csk-' + 't'.repeat(32),
  'Perplexity Key': 'pplx-' + 's'.repeat(44),
  '任意 Bearer': 'Bearer ' + 'r'.repeat(36),
}
for (const [name, re] of SECRET_RES) {
  const sample = SECRET_SAMPLES[name]
  if (sample === undefined) { ok(false, `样本表缺「${name}」—— 新增特征时必须同时补样本，否则这条闸门会空转`); continue }
  ok(re.test(sample), `命中「${name}」`)
}

// ⚠ 反断言：闸门不能靠"什么都拦"取胜 —— 正常文档文本必须放行，
//   否则 make-dist 会在正常 README 上直接红，然后有人把整条规则注释掉。
console.log('\n[1b] ⚠ 反断言：正常文本不能被误伤（否则规则会被整条注释掉）')
const BENIGN = [
  '把 Key 填进 config.json，形如 freegw-xxxx（长度不足 32 位不算）',
  'sk- 开头的短串不是 Key',
  'Authorization: Bearer <你的网关 Key>',
  'https://openrouter.ai/models?free=true',
  '模型 id 形如 deepseek/deepseek-chat-v3:free',
]
for (const t of BENIGN) {
  const hit = SECRET_RES.filter(([, re]) => re.test(t)).map(([n]) => n)
  ok(hit.length === 0, `放行正常文本：${t.slice(0, 34)}…${hit.length ? ' ← 误伤「' + hit.join('、') + '」' : ''}`)
}

// ── [2] 去敏：只改路径里的用户名，不许碰品牌名 ──
// 本机用户名恰好等于品牌名（都是 xiaoji），这是最容易把 .bat 改坏的地方：
// 裸词替换会把 xiaoji-launcher.vbs 改成 <用户名>-launcher.vbs，自检照样"通过"，装上去起不来。
console.log('\n[2] 去敏改写：路径里的用户名改掉，品牌名一个字都不能动')
const sanitize = (s) => { let x = s; for (const [re, to] of SANITIZE) x = x.replace(re, to); return x }
const USERPATH = `C:\\Users\\${USER}\\Downloads\\gateway`
ok(!sanitize(USERPATH).includes(USER), `绝对路径里的用户名已改写：${sanitize(USERPATH)}`)

// ⚠ 反断言：这三样一旦被改，包就装不上了（.bat 找不到 launcher / 日志路径变了 / 目录名变了）
for (const must of ['xiaoji-launcher.vbs', 'logs/xiaoji.log', 'xiaoji-free-model-gateway']) {
  ok(sanitize(must) === must, `⚠ 反断言：品牌名/文件名原样保留：${must}`)
}
ok(!/用户原话|用户明确|用户要求|用户反馈|用户说/.test(sanitize('用户原话："太乱了"')), '归属措辞被改写（不是留着）')
ok(sanitize('用户原话："太乱了"').includes('太乱了'), '改写只换归属词、保留原话内容')

// ── [3] 判据只有一份：打包脚本里不许再出现第二份 ──
// 判据是"特征名只允许出现在 publish-rules.cjs"。抄一份的人必然连名字一起抄 ——
// 于是"名字出现在别的脚本里"就是"又抄了一份"的可观测信号。
//
// ⚠ 扫之前先剥注释：注释**应该**能讨论这些特征名（"别抄 'Groq Key'" 是好注释），
//   不剥的话这条闸门会逼着人把注释删掉。只剥整行 `//` 与 `/* */` 块 —— 行尾注释
//   可能落在字符串里（`https://`），硬剥反而会制造假象。
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
console.log('\n[3] 判据只有一份：特征名不许出现在 publish-rules.cjs 之外')
const CONSUMERS = ['check-secrets.cjs', 'make-dist.cjs', 'pack-skill.cjs', 'sync-skill-dist.cjs']
const LABELS = SECRET_RES.map(([n]) => n).concat(PERSONAL_RES.map(([n]) => n))
for (const f of CONSUMERS) {
  const p = path.join(ROOT, 'scripts', f)
  if (!fs.existsSync(p)) { ok(false, `脚本存在：${f}`); continue }
  const src = stripComments(fs.readFileSync(p, 'utf8'))
  ok(/require\(['"]\.\/publish-rules\.cjs['"]\)/.test(src), `${f} 从 publish-rules.cjs 取判据`)
  const dup = LABELS.filter((l) => src.includes(`'${l}'`) || src.includes(`"${l}"`))
  ok(dup.length === 0, `⚠ 反断言：${f} 里没有第二份特征名${dup.length ? ' ← 又抄了一份：' + dup.join('、') : ''}`)
}

// ── [4] 自检失败不许回显命中原文 ──
console.log('\n[4] 自检输出只报特征名，不回显命中原文')
for (const f of ['make-dist.cjs', 'pack-skill.cjs', 'sync-skill-dist.cjs']) {
  const src = stripComments(fs.readFileSync(path.join(ROOT, 'scripts', f), 'utf8'))
  // 命中后把匹配到的子串打进日志 = 把 Key 的前几位抄进 Issue
  const leaks = /m\[0\]\.slice|match\(re\)\[0\]|\.exec\(text\)\[0\]/.test(src)
  ok(!leaks, `⚠ 反断言：${f} 没有把命中原文写进日志`)
}

// ── [5] 违禁文件名：配置的**任何备份形态**都必须拦住 ──
// 2026-11-07 前这里是 `^config\.json$`，挡不住"手工备份一份"这个最常见的动作。
console.log('\n[5] 违禁文件名覆盖配置的备份形态')
for (const name of ['config.json', 'config.json.bak', 'config.json.2026-10-01', 'config.json.prev', 'gateway.pid', 'usage_log.json']) {
  ok(FORBIDDEN_NAME.some((re) => re.test(name)), `拦住 ${name}`)
}
ok(!FORBIDDEN_NAME.some((re) => re.test('config.example.json')), '⚠ 反断言：config.example.json 是模板，必须放行')

// ── [6] make-dist 真的做了去敏（而不是只查不洗） ──
// 只查不洗的后果实测过：42 个文件的包里带着十几处"用户原话…"，闸门却是绿的。
console.log('\n[6] make-dist 出包前真的去敏（不只是查）')
const md = fs.readFileSync(path.join(ROOT, 'scripts', 'make-dist.cjs'), 'utf8')
ok(/SANITIZE/.test(md) && /for \(const \[re, to\] of SANITIZE\)/.test(md), 'make-dist 对包内文本应用了 SANITIZE')
ok(/PERSONAL_RES/.test(md), 'make-dist 也查个人信息（原来只查密钥）')

console.log(`\n  ${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
