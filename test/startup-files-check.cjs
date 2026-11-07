// startup-files-check.cjs —— 启动入口的"看不见的不变式"。
//
// 为什么值得单独一个套件: `小鸡开关.bat` / `xiaoji-launcher.vbs` 是用户**唯一的启动入口**
// (助手没法让网关持久运行, 只能靠用户双击 bat), 而它们的两个致命要求都是**看不见的**:
//   ① 行尾必须是 CRLF —— 被静默改成 LF 后 cmd 解析可能出错, 而这个改动**在编辑器里完全看不出来**。
//      本机踩过一次: bat 被改成 LF, 179 行全漂, 是靠字节级统计才发现的。
//   ② 必须纯 ASCII 且无 BOM —— 带 BOM 的 bat 会把 BOM 当成第一条命令的一部分; bat 里写中文
//      在非中文 locale 的 cmd 里会变乱码甚至报错(这两条文件本身是纯 ASCII, 但没有任何东西拦着
//      以后有人"顺手加一句中文提示")。
//
// ⚠ 这两条以前**只写在红线文档里, 没有任何断言** —— 而本项目自己的教训恰恰是
//   "手工维护、没人断言的东西必然漂移"。所以这里把它们变成会报红的断言, 顺带守住
//   `.gitattributes` 里那两条钉死规则(规则被删掉时本套件必须红, 否则"别人 clone 下来
//   bat 变成 LF"要等到有人反馈才发现)。
const fs = require('fs')
const path = require('path')

// ⚠ 必须从 `path.dirname(__dirname)` 起步，**不能**从 `__dirname` 起步。
//   原因: protocol-test 会把一份 `server.mjs` 拷进 `test/` 当自己的实例 —— 于是
//   `test/server.mjs` 是真实存在的，从 `__dirname` 起步会**认 `test/` 当项目根**，
//   然后所有"文件在不在"的断言全红（实测 2026-10-09: 单独跑绿、经 run-all 跑红，
//   差别只在"那一轮 protocol-test 有没有先把副本拷进来"）。这就是红线里那条
//   "ROOT_AUTO 必须从 dirname(__dirname) 起步"的现场复现。
const ROOT = (() => { const _fs = require('fs'), _p = require('path'); let d = _p.dirname(__dirname); for (let i = 0; i < 6; i++) { if (_fs.existsSync(_p.join(d, 'server.mjs'))) return d; d = _p.dirname(d) } return _p.join(__dirname, '..') })()

let pass = 0, fail = 0
const ok = (c, m) => { if (c) { pass++; console.log('  PASS  ' + m) } else { fail++; console.log('  FAIL  ' + m) } }

// 先把"根目录找对了没"单独断言一次，并把判据打出来 —— 否则根目录认错时，
// 下面每条都会报"文件不存在"，看起来像"文件被删了"，而不像"根目录找错了"。
ok(fs.existsSync(path.join(ROOT, 'package.json')) && fs.existsSync(path.join(ROOT, '.gitattributes')),
  `项目根目录定位正确（${ROOT}）`)

// 需要钉 CRLF 的启动入口。README 的交付话术直接引用它们, 所以文件名本身也算契约。
const SCRIPTS = ['小鸡开关.bat', 'xiaoji-launcher.vbs']

function stats(file) {
  const b = fs.readFileSync(path.join(ROOT, file))
  let crlf = 0, lfOnly = 0
  for (let i = 0; i < b.length; i++) if (b[i] === 10) { if (b[i - 1] === 13) crlf++; else lfOnly++ }
  let nonAscii = 0
  for (const x of b) if (x > 127) nonAscii++
  return { crlf, lfOnly, bom: b[0] === 0xEF && b[1] === 0xBB && b[2] === 0xBF, nonAscii }
}

for (const f of SCRIPTS) {
  if (!fs.existsSync(path.join(ROOT, f))) { ok(false, `启动入口存在：${f}`); continue }
  ok(true, `启动入口存在：${f}`)
  const s = stats(f)
  // ⚠ 判据是"裸 LF 计数为 0", **不是**"CRLF 计数 > 0" —— 混排(前半 LF、后半 CRLF)时后者照样绿。
  ok(s.lfOnly === 0, `${f} 行尾全是 CRLF（裸 LF ${s.lfOnly} 处，必须为 0）`)
  ok(!s.bom, `${f} 没有 BOM（带 BOM 的 bat 会把 BOM 当成命令的一部分执行）`)
  ok(s.nonAscii === 0, `${f} 是纯 ASCII（非 ASCII 字节 ${s.nonAscii} 个 —— 中文注释在非中文 locale 的 cmd 里会乱码）`)
}

// ── .gitattributes 是"别人 clone 下来也正确"的唯一保证 ──
// 本机文件是对的、但规则被删掉, 一样会漂 —— 所以规则本身也要断言。
const ga = (() => { try { return fs.readFileSync(path.join(ROOT, '.gitattributes'), 'utf8') } catch { return '' } })()
const gaLines = ga.split('\n').map((l) => l.trim())
const idxAll = gaLines.findIndex((l) => /^\*\s+text=auto/.test(l))
const idxBat = gaLines.findIndex((l) => /^\*\.bat\s+text\s+eol=crlf$/.test(l))
const idxVbs = gaLines.findIndex((l) => /^\*\.vbs\s+text\s+eol=crlf$/.test(l))
ok(idxBat >= 0, '.gitattributes 仍把 *.bat 钉成 `text eol=crlf`')
ok(idxVbs >= 0, '.gitattributes 仍把 *.vbs 钉成 `text eol=crlf`')
// ⚠ 顺序是**真的会生效**的: git 里后出现的规则覆盖先出现的。通配规则写在后面的话,
//   上面那两条会被静默盖掉 —— 文件里看起来还留着, 实际已经失效。
ok(idxAll >= 0 && idxBat > idxAll, '.gitattributes 里 *.bat 排在通配规则**之后**（git 后出现者生效，顺序反了会被通配盖掉）')
ok(idxAll >= 0 && idxVbs > idxAll, '.gitattributes 里 *.vbs 排在通配规则之后')

// 交付话术的落点: 文档让用户"双击 小鸡开关.bat", 改名而不同步文档会让这句话直接失效。
const readme = (() => { try { return fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8') } catch { return '' } })()
ok(readme.includes('小鸡开关.bat'), 'README 仍提到启动入口「小鸡开关.bat」（交付话术的落点，改名必须同步文档）')

console.log(`\n  ${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
