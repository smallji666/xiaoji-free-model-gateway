#!/usr/bin/env node
'use strict'
/*
 * run-all.cjs —— 统一测试入口。改完代码跑这一个就够。
 *
 * 为什么需要它：测试台有 20+ 个套件，散落各处，没有统一入口时"从哪开始跑、哪些能跑"
 * 全靠记忆。更重要的是**分层** —— 离线组（假上游，零 Key、零网络）能进 CI，
 * 联网组（真实 Key + 代理）只能在开发者本机跑，混在一起就永远接不上 CI。
 *
 * 用法：
 *   node test/run-all.cjs              跑离线组（默认；CI 跑的就是这一组）
 *   node test/run-all.cjs --all        离线组 + 本机组 + 联网组
 *   node test/run-all.cjs --local      只跑需要本机网关/浏览器的组
 *   node test/run-all.cjs --online     只跑联网组
 *   node test/run-all.cjs --list       只列清单，不跑
 *   node test/run-all.cjs <关键词>     只跑文件名含关键词的套件（如 protocol / batch）
 *
 * 分组：
 *   offline  假上游 / 纯函数 / 本地文件 —— 不需要 Key、不需要网络、不需要浏览器。CI 可跑。
 *   local    需要**本机 8787 网关在跑** + Edge 浏览器（仪表盘版面与交互）。
 *   online   需要真实厂商 Key + 代理（端到端打通真实上游）。
 *
 * 退出码：有任何套件失败即 1（CI 靠它判红绿）。
 *
 * ══ 端口分配表（加新套件前先看这里，别再撞车）══
 *   8788 gw / 8790 up   protocol-test
 *   8791 gw / 8792 up   gate-check
 *   8793 gw / 8794 up   batch1、batch4(A)      ⚠ 两者共用，不能并行
 *   8795 gw / 8796 up   batch2、batch4(B)      ⚠ 同上
 *   8797 gw / 8798 up   batch3
 *   8800 gw / 8803 up   free-eval
 *   8801 gw / 8802 up   features-check
 *   8804 gw             route-invariant-check
 *   8810 gw / 8811+8812 up   hedge
 *   8813 gw             stale-source-check
 *   8814 gw             why-check
 *   8815 gw             probe-route
 *   8816 gw             sb-build（默认沙箱）
 *   8817 gw / 8818 up   quota-reload-check
 *   8819 gw / 8820 up   ctx-compact-check
 *   8823 gw / 8824 up   coalesce-retry-check
 *   8825 gw / 8826 up   fail-scope-check
 *   8827 gw / 8828 up   fail-path-check（8829/8830 是它**故意不监听**的死端口）
 *   8831 gw / 8832 up   key-rotate-check
 *   8833 gw             wl-freshness-check（无假上游，全靠桩源）
 *   9300+ 随机          shotseg
 *   ⚠ 历史上这批端口有 5 处冲突（hedge 的 8792/8793/8794 撞 gate-check 与 batch1/batch4，
 *     以及 why/probe 共用 8799、stale 撞 batch3、sb-build 撞 protocol 的假上游）。
 *     表现为"上一个套件的残留进程占着端口 → 下一个套件的网关绑不上 → 请求打到别人的假上游 → 404"，
 *     而且只在整组连跑时偶发。已全部重排到互不重叠的区间。
 */
const { spawn, execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const HERE = __dirname
const ROOT = (() => { let d = path.dirname(HERE); for (let i = 0; i < 6; i++) { if (fs.existsSync(path.join(d, 'server.mjs'))) return d; d = path.dirname(d) } return path.join(HERE, '..') })()

// 新克隆没有 config.json（它含明文 Key，被 .gitignore 排除），而部分离线套件要读它。
// 先补一份最小配置，否则刚 clone 的人看到的是"测试全红"，实际只是少了份配置。
try {
  execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'init-config.cjs')], { stdio: 'ignore' })
} catch { /* 失败不阻断：真缺配置时对应套件会自己报错 */ }

// 每套超时（毫秒）。对冲测试要等 12s 的慢家，batch 类要起网关再等就绪，给足余量。
const TIMEOUT_MS = 240000

const GROUPS = {
  offline: [
    ['protocol-test.cjs', '四协议入口 + 流式/非流式 + 5 类边界'],
    ['gate-check.cjs', '免费校验闸门（隔离/解除）'],
    ['anon-check.cjs', '免 Key 端点实测转正的判据契约'],
    ['batch1-check.cjs', '安全与数据完整性'],
    ['batch2-check.cjs', '可观测性数据层'],
    ['batch3-check.cjs', '后端与前端一致性'],
    ['batch4-check.cjs', '可观测性与韧性收尾'],
    ['features-check.cjs', '别名/多模态/tools 学习/导出导入'],
    ['why-check.cjs', '免费判定依据 /api/why'],
    ['free-eval.cjs', '免费判定事故回归库 + 准确率'],
    ['route-invariant-check.cjs', '路由排序不变量'],
    ['stale-source-check.cjs', '停更源熔断（离线端到端）'],
    ['model-type-check.cjs', '模型类型准入（读本地扫描结果）'],
    ['promo-page-check.cjs', '整页活动判定'],
    ['hedge/hedge-check.cjs', '对冲请求量化回归'],
    ['quota-reload-check.cjs', '配额头采集 + config 热重载'],
    ['ctx-compact-check.cjs', '上下文降级（超窗裁历史重发）'],
    ['coalesce-retry-check.cjs', '并发合并 + 限流兜底重试'],
    ['fail-scope-check.cjs', '失败归类范围 + 连续失败退避'],
    ['fail-path-check.cjs', '额度重置时区 / 代理不通 / 首字节超时'],
    ['key-rotate-check.cjs', '多 Key 轮转（LRU）'],
    ['wl-freshness-check.cjs', '白名单变没变的判据（304 / 指纹 / 真变了）'],
    ['startup-files-check.cjs', '启动入口不变式（CRLF/ASCII/gitattributes）'],
  ],
  local: [
    ['layout-check.cjs', '双视口布局红线（需 8787 + Edge）'],
    ['console-check.cjs', '控制台零报错 + 交互冒烟（需 8787 + Edge）'],
    ['mobile-layout-check.cjs', '移动端 390px（需 8787 + Edge）'],
  ],
  online: [
    ['e2e-check.cjs', '真实上游端到端'],
    ['e2e-real.cjs', '四协议真实冒烟'],
    ['promo-live-check.cjs', '活动巡检端到端'],
  ],
}

// 无断言的工具（不在分组里，但 --tools 可跑）
const TOOLS = ['deadcode-scan.cjs', 'syncheck.cjs', 'probe-route.cjs', 'sb-build.cjs', 'diag-cards.cjs']

const argv = process.argv.slice(2)
const has = (f) => argv.includes(f)
const filter = argv.find((a) => !a.startsWith('--'))

function selected() {
  if (has('--all')) return [...GROUPS.offline, ...GROUPS.local, ...GROUPS.online]
  if (has('--online')) return GROUPS.online
  if (has('--local')) return GROUPS.local
  return GROUPS.offline
}

async function gwUp() {
  try {
    const r = await fetch('http://127.0.0.1:8787/healthz', { signal: AbortSignal.timeout(1500) })
    return r.ok
  } catch { return false }
}

function runOne(file, label) {
  return new Promise((resolve) => {
    const t0 = Date.now()
    const p = spawn(process.execPath, [path.join(HERE, file)], { cwd: HERE, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; try { p.kill('SIGKILL') } catch {} }, TIMEOUT_MS)
    p.stdout.on('data', (d) => { out += d })
    p.stderr.on('data', (d) => { out += d })
    p.on('close', (code) => {
      clearTimeout(timer)
      // 汇总行格式有三类：`N 通过 / M 失败`、`N passed, M failed`、`N/M 通过`。
      // ⚠ 第三类是 `通过/总数`（不是 通过/失败），失败数要相减 —— 漏了它会让 model-type-check
      //   与 promo-page-check 的项数**不计入合计**（表现为那两行显示成 "exit 0"）。
      let m = out.match(/(\d+)\s*通过\s*\/\s*(\d+)\s*失败/) || out.match(/(\d+)\s*passed,\s*(\d+)\s*failed/)
      let passed = null, failed = null
      if (m) { passed = Number(m[1]); failed = Number(m[2]) }
      else if ((m = out.match(/(\d+)\s*\/\s*(\d+)\s*通过/))) { passed = Number(m[1]); failed = Number(m[2]) - Number(m[1]) }
      resolve({ file, label, code, ms: Date.now() - t0, passed, failed, timedOut, out })
    })
  })
}

async function main() {
  let list = selected()
  if (filter) list = list.filter(([f]) => f.toLowerCase().includes(filter.toLowerCase()))
  if (!list.length) { console.error('没有匹配的套件：' + (filter || '')); process.exit(1) }

  if (has('--list')) {
    for (const [f, label] of list) console.log(`  ${f.padEnd(30)} ${label}`)
    return
  }

  // local 组的前置条件：8787 必须在跑。不在就跳过并说明原因 ——
  // 不然会渲染浏览器错误页，然后报一堆"看似严重"的 FAIL（测量工具前置条件没满足时，数字是可信的假象）。
  let gw = true
  if (list.some(([f]) => GROUPS.local.some(([g]) => g === f))) {
    gw = await gwUp()
    if (!gw) console.log('⚠ 本机 8787 网关未在监听 → local 组将跳过。先启动网关再跑。\n')
  }

  const results = []
  for (const [file, label] of list) {
    const isLocal = GROUPS.local.some(([g]) => g === file)
    if (isLocal && !gw) { results.push({ file, label, skipped: true, reason: '网关未运行' }); continue }
    process.stdout.write(`\n▶ ${file}  —  ${label}\n`)
    const r = await runOne(file, label)
    if (r.timedOut) console.log(`  ⏱ 超时（>${TIMEOUT_MS / 1000}s），已终止`)
    else if (r.code !== 0) console.log(r.out.split('\n').filter((l) => /FAIL|✗|失败|Error/.test(l)).slice(-6).join('\n'))
    results.push(r)
  }

  // ── 汇总 ──
  console.log('\n' + '═'.repeat(64))
  console.log('  测试汇总')
  console.log('═'.repeat(64))
  let totalPass = 0, totalFail = 0, bad = 0, skipped = 0
  for (const r of results) {
    if (r.skipped) { skipped++; console.log(`  ⊘ ${r.file.padEnd(28)} 跳过（${r.reason}）`); continue }
    const status = r.timedOut ? '⏱ 超时' : (r.code === 0 ? '✓ 通过' : '✗ 失败')
    const counts = (r.passed != null) ? `${r.passed} 通过 / ${r.failed} 失败` : `exit ${r.code}`
    if (r.passed != null) { totalPass += r.passed; totalFail += r.failed }
    if (r.code !== 0 || r.timedOut) bad++
    console.log(`  ${status}  ${r.file.padEnd(28)} ${counts.padEnd(22)} ${(r.ms / 1000).toFixed(1)}s`)
  }
  console.log('─'.repeat(64))
  console.log(`  合计：${totalPass} 通过 / ${totalFail} 失败 ｜ 失败套件 ${bad} 个 ｜ 跳过 ${skipped} 个`)
  console.log(`  耗时：${(results.reduce((a, r) => a + (r.ms || 0), 0) / 1000).toFixed(1)}s`)
  if (bad) {
    console.log('\n  失败的套件输出（末尾 20 行）：')
    for (const r of results) if (!r.skipped && (r.code !== 0 || r.timedOut)) {
      console.log(`\n  ── ${r.file} ──`)
      console.log(r.out.split('\n').slice(-20).map((l) => '  ' + l).join('\n'))
    }
  }
  process.exit(bad ? 1 : 0)
}

if (has('--tools')) {
  console.log('可用工具（无断言）：' + TOOLS.join(', '))
  process.exit(0)
}

main().catch((e) => { console.error(e.stack || e); process.exit(1) })
