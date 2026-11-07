// 语法体检：把 dashboard.html 里的每个 <script> 抽出来，逐段 new Function 检查。
// 为什么必须做：补丁多一个 ) → 整个 <script> 解析失败、页面只剩空壳，
// 而 layout-check 此时反报「两列差 3px PASS」（两列都空，指标反而好看）。
//
// 2026-10-11 补上 <style> 段的结构检查。为什么 CSS 也要查：
// CSS 注释是**唯一**能让一条规则被静默吞掉的语法错误 —— 往注释块末尾追加文字时多留一个
// `*/`，后面紧跟的规则就被当成注释内容吃掉。实测：`#changes{max-height:461px}` 整条被吞，
// 浏览器回退到 `.chg-list` 的 320px，**页面看起来一切正常**（只是那一列矮了 141px），
// 报出来的症状是「两列高度差 165px FAIL」—— 根因和版式毫无关系。
// 这类错误必须在语法层拦下，不能靠眼睛。
const fs = require('fs')
const p = process.argv[2] || 'dashboard.html'
const html = fs.readFileSync(p, 'utf8')
const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi
let m, i = 0, bad = 0
while ((m = re.exec(html))) {
  i++
  const code = m[1]
  const line = html.slice(0, m.index).split('\n').length
  try { new Function(code) } catch (e) {
    bad++
    console.log(`✗ script#${i} (html 行 ${line}) 解析失败: ${e.message}`)
  }
}

const css = (html.match(/<style[^>]*>([\s\S]*?)<\/style>/i) || [])[1] || ''
if (css) {
  const opens = (css.match(/\/\*/g) || []).length
  const closes = (css.match(/\*\//g) || []).length
  // 剥掉成对注释后再数花括号：注释里的 { } 是文字，不该参与配对
  const bare = css.replace(/\/\*[\s\S]*?\*\//g, '')
  const brace = (bare.match(/\{/g) || []).length - (bare.match(/\}/g) || []).length
  if (opens !== closes) { bad++; console.log(`✗ <style> 注释不配对: /* ${opens} 个 vs */ ${closes} 个`) }
  if (brace !== 0) { bad++; console.log(`✗ <style> 花括号不配对: 差 ${brace} 个`) }
  if (opens === closes && brace === 0) console.log(`✓ <style> 结构完整（注释 ${opens} 对 · 花括号平衡）`)
} else {
  console.log('· 没找到 <style> 段，跳过 CSS 结构检查')
}
console.log(bad ? `\n${bad} 项解析失败` : `✓ ${i} 段 <script> 全部解析通过`)
process.exit(bad ? 1 : 0)
