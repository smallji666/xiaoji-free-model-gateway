// 死代码扫描：找出"声明了但全文只用一次（即只有声明处）"的顶层符号。
// 用来在改版后确认没有留下孤儿函数/常量（09-17 那次扫出 0 个，说明这个库一直比较干净）。
const fs = require('node:fs')
const path = require('node:path')
const ROOT = (() => { const _fs = require('fs'), _p = require('path'); let d = _p.dirname(__dirname); for (let i = 0; i < 6; i++) { if (_fs.existsSync(_p.join(d, 'server.mjs'))) return d; d = _p.dirname(d) } return _p.join(__dirname, '..') })()

// ⚠ 两个口径修正（2026-09-26 实测）：
// 1) 用 lookaround 代替 `\b`：`$` 这类**纯符号名**在 `\b` 下永远匹配 0 次 —— \b 要求"一侧是
//    word 字符"，而空格和 `$` 都不是，于是 `\b\$\b` 连定义处都匹配不到 → `$` 每轮都被报成零引用。
// 2) 接受 extraRefs：引用不一定写在 script 里，也可能写在 **HTML 属性**里
//    （`onclick="copyKey(...)"`、事件委托的 data-act）。只数 script 会把这类函数全报成假死 ——
//    实测 11 个"零引用"里 10 个都是 HTML 属性在调，真死代码会被这批假警报淹掉。
function scan(file, label, extraRefs = '') {
  const src = fs.readFileSync(file, 'utf8')
  const decl = []
  const re = /^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)|^(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/gm
  let m
  while ((m = re.exec(src))) decl.push(m[1] || m[2])
  const count = (n) => {
    const pat = '(?<![\\w$])' + n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![\\w$])'
    const r = new RegExp(pat, 'g')
    return (src.match(r) || []).length + (extraRefs.match(r) || []).length
  }
  const unused = decl.filter((n) => count(n) <= 1)
  console.log(`\n== ${label} ==`)
  console.log(`顶层声明 ${decl.length} 个；零引用 ${unused.length} 个`)
  if (unused.length) console.log('  ' + unused.join(', '))
  return unused
}

const a = scan(path.join(ROOT, 'server.mjs'), 'server.mjs')
// dashboard.html 只扫 <script> 主块，但引用来源要算上 HTML 属性（见 scan 的注释 2）
const html = fs.readFileSync(path.join(ROOT, 'dashboard.html'), 'utf8')
const all = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
fs.writeFileSync(path.join(__dirname, '_dashjs.js'), all.map((x) => x[1]).join('\n'))
const htmlAttrs = html.replace(/<script>[\s\S]*?<\/script>/g, '').replace(/<style>[\s\S]*?<\/style>/g, '')
const b = scan(path.join(__dirname, '_dashjs.js'), 'dashboard.html <script>', htmlAttrs)

// CSS 类：声明了但 HTML 里没用到的
const cssClasses = [...html.matchAll(/\.([a-z][\w-]*)\s*(?=[,{:\s])/g)].map((m) => m[1])
const cssSet = [...new Set(cssClasses)]
const bodyOnly = html.replace(/<style>[\s\S]*?<\/style>/g, '')
const unusedCss = cssSet.filter((c) => !new RegExp('\\b' + c.replace(/-/g, '\\-') + '\\b').test(bodyOnly)
  && !new RegExp(`'${c}'|"${c}"|\`${c}\``).test(html))
console.log(`\n== dashboard.html CSS ==`)
console.log(`类 ${cssSet.length} 个；HTML 与 JS 里都没出现 ${unusedCss.length} 个`)
if (unusedCss.length) console.log('  ' + unusedCss.join(', '))

try { fs.unlinkSync(path.join(__dirname, '_dashjs.js')) } catch {}
process.exit(a.length + b.length > 0 ? 1 : 0)
