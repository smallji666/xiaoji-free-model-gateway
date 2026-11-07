// hedge-check.cjs —— 对冲请求(hedge)的量化回归测试。
//
// 做法: 起一个**独立的网关实例**(端口 8810, 配置在 ./config.json), 链上放两家假上游:
//   第 1 家 "slow"  : 12 秒才响应  (模拟"连得上但很慢"的供应商)
//   第 2 家 "fast"  : 立刻响应
// 两家初始指标完全相同(ok/err/latency 都是空), pickChain 的排序是稳定排序, 所以 slow
// 必然排第一 —— 正好复现"领跑者很慢"的场景。
//
// 期望:
//   不开对冲 -> 必须干等 slow 的 12 秒
//   开了对冲 -> 约 HEDGE_MS(3s) 后并行开 fast, 总耗时 ~3.1s
//
// 同时校验两个容易出错的点:
//   · 落败的 slow 不能被记为"失败"(否则对冲会惩罚无辜供应商)
//   · 落败的 slow 要记下真实 TTFB(否则它永远学不到自己慢, 每次都白开一条请求)
//
// ⚠ 端口 8810/8811/8812 是**专属区间**（见 run-all.cjs 的端口分配表）——
//   曾经用 8792/8793/8794，与 gate-check / batch1 / batch4 撞车，整组连跑时偶发 404。
const { spawn } = require('child_process')
const fs = require('fs')
const path = require('path')

const NODE = process.execPath
const HERE = __dirname
// 项目根：从父目录逐级上找含 server.mjs 的目录。
// 项目内是 <root>/test/hedge，技能包内是 <gateway>/assets/gateway/test/hedge —— 同一份代码都能定位。
const ROOT = (() => { const _fs = require('fs'), _p = require('path'); let d = _p.dirname(__dirname); for (let i = 0; i < 6; i++) { if (_fs.existsSync(_p.join(d, 'server.mjs'))) return d; d = _p.dirname(d) } return _p.join(__dirname, '..') })()
const GW_PORT = 8810
const SLOW_PORT = 8811
const FAST_PORT = 8812
const SLOW_DELAY = 12000
const GW_KEY = 'freegw-hedge-test-0000000000000000'
const HEDGE_MS = 3000

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const procs = []
function launch(args, cwd, label) {
  const p = spawn(NODE, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
  p.stdout.on('data', () => {})
  p.stderr.on('data', (d) => { const s = String(d).trim(); if (s) console.log(`  [${label}] ${s}`) })
  procs.push(p)
  return p
}
function cleanup() { for (const p of procs) { try { p.kill() } catch {} } }
process.on('exit', cleanup)

let pass = 0, fail = 0
// 失败时把最近一次响应体打出来 —— 否则只看到"HTTP 200（实得 404）"这类信息，
// 得回头翻源码才知道 404 是"网关没起来"还是"打到别人的假上游"。
let lastResp = ''
const ok = (c, m) => {
  if (c) { pass++; console.log('  PASS  ' + m) }
  else { fail++; console.log('  FAIL  ' + m); if (lastResp) console.log('    ↳ 响应体: ' + lastResp.replace(/\s+/g, ' ').slice(0, 300)) }
}

async function post(pathname, body, extra = {}) {
  const t = Date.now()
  const r = await fetch(`http://127.0.0.1:${GW_PORT}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + GW_KEY, ...extra },
    body: JSON.stringify(body),
  })
  const text = await r.text()
  lastResp = text
  return { status: r.status, text, ms: Date.now() - t }
}

async function main() {
  // ── 准备独立测试环境 ──
  const now = new Date().toISOString()
  const cfg = {
    port: GW_PORT, proxy: '', gatewayKey: GW_KEY,
    providers: [
      // slow 必须排第一(两家指标完全相同, pickChain 稳定排序 -> 按数组顺序)
      { id: 'slow', name: 'slow', label: 'SlowCo', base_url: `http://127.0.0.1:${SLOW_PORT}/v1`, api_key: 'sk-x', keys: ['sk-x'], model: 'slow-model', models: ['slow-model'], needs_proxy: false, enabled: true, ok: 0, err: 0, cooldownUntil: 0, lastError: '', lastSweepAt: now },
      { id: 'fast', name: 'fast', label: 'FastCo', base_url: `http://127.0.0.1:${FAST_PORT}/v1`, api_key: 'sk-y', keys: ['sk-y'], model: 'fast-model', models: ['fast-model'], needs_proxy: false, enabled: true, ok: 0, err: 0, cooldownUntil: 0, lastError: '', lastSweepAt: now },
    ],
  }
  fs.writeFileSync(path.join(HERE, 'config.json'), JSON.stringify(cfg, null, 2))
  // .sandbox 标记：让 server.mjs 启动时跳过 syncUpstreamWhitelist（见 server.mjs 的沙箱短路注释）。
  // 否则真实同步会把下面这份手工白名单覆盖掉，测试的确定性就没了。
  fs.writeFileSync(path.join(HERE, '.sandbox'), '')
  // 白名单预置成"刚同步过", 免得启动时去外网拉(会把启动拖慢、且与本次测试无关)
  fs.writeFileSync(path.join(HERE, 'free_whitelist.json'), JSON.stringify({ list_date: now.slice(0, 10), fetched_at: now, sources: { local: now.slice(0, 10) }, hosts: {} }, null, 2))

  // ⚠ server.mjs 里所有路径(config/白名单/目录/日志)都是按 __dirname 解析的, 不是 cwd。
  // 所以独立实例必须用**同一目录下的副本**, 否则它会去读写生产的那套文件。
  fs.copyFileSync(path.join(ROOT, 'server.mjs'), path.join(HERE, 'server.mjs'))
  fs.copyFileSync(path.join(ROOT, 'dashboard.html'), path.join(HERE, 'dashboard.html'))

  console.log('启动假上游…')
  launch([path.join(HERE, 'fake-up.cjs'), String(SLOW_PORT), String(SLOW_DELAY)], HERE, 'slow-up')
  launch([path.join(HERE, 'fake-up.cjs'), String(FAST_PORT), '0'], HERE, 'fast-up')

  // ⚠ 必须每个场景都用**全新的网关实例**: 一次请求之后 fast 就学到了延迟,
  //   下一轮它会被排到 slow 前面, 于是"领跑者很慢"的场景就不复存在了(第 2 次测不到对冲)。
  let gw = null
  async function startGw(tag) {
    fs.writeFileSync(path.join(HERE, 'config.json'), JSON.stringify(cfg, null, 2))
    gw = launch([path.join(HERE, 'server.mjs')], HERE, tag)
    for (let i = 0; i < 60; i++) {
      await sleep(400)
      try { const r = await fetch(`http://127.0.0.1:${GW_PORT}/api/state`, { headers: { authorization: 'Bearer ' + GW_KEY } }); if (r.ok) break } catch {}
    }
    await sleep(1500) // 等启动扫描安静下来
  }
  async function stopGw() {
    if (!gw) return
    gw.kill()
    for (let i = 0; i < 40; i++) { await sleep(150); if (gw.exitCode !== null || gw.killed) break }
    gw = null
    await sleep(400)
  }

  // ── 用例 1: 非流式, 领跑者慢 ──
  console.log('\n[1] 非流式 auto（第 1 家慢 12s, 第 2 家立刻回）')
  await startGw('gw#1')
  let r = await post('/v1/chat/completions', { model: 'auto', messages: [{ role: 'user', content: 'ping' }] })
  ok(r.status === 200, `HTTP 200（实得 ${r.status}）`)
  ok(r.ms < SLOW_DELAY / 2, `耗时 ${r.ms}ms 远小于慢家延迟 ${SLOW_DELAY}ms（对冲生效）`)
  ok(r.ms >= HEDGE_MS - 400 && r.ms < HEDGE_MS + 3000, `耗时 ${r.ms}ms 落在对冲窗口附近（~${HEDGE_MS}ms + 快家）`)
  ok(/"content"\s*:\s*"hi"/.test(r.text), '正文来自假上游')
  await stopGw()

  // ── 用例 2: 流式, 领跑者慢（全新实例, 重新回到 slow 领跑）──
  console.log('\n[2] 流式 auto（同上, 全新实例）')
  await startGw('gw#2')
  r = await post('/v1/chat/completions', { model: 'auto', stream: true, messages: [{ role: 'user', content: 'ping2' }] })
  ok(r.status === 200, `HTTP 200（实得 ${r.status}）`)
  ok(r.ms < SLOW_DELAY / 2, `耗时 ${r.ms}ms 远小于 ${SLOW_DELAY}ms（对冲在流式下同样生效）`)
  ok(r.ms >= HEDGE_MS - 400, `耗时 ${r.ms}ms 不早于对冲窗口`)
  ok(/data:\s*\[DONE\]/.test(r.text), 'SSE 流完整收到 [DONE]（未被对冲打断）')

  // ── 用例 3: 落败方不该被惩罚, 但要学到"自己慢" ──
  // 慢家的响应头要 12s 才到, 被取消后它会在那一刻才把 TTFB 记下来 —— 必须等到那时候再断言
  console.log(`\n[3] 落败方(slow)的记账（等慢家那条被取消的请求落地, 约 ${SLOW_DELAY / 1000}s）`)
  await sleep(SLOW_DELAY + 1500)
  const st = await (await fetch(`http://127.0.0.1:${GW_PORT}/api/state`, { headers: { authorization: 'Bearer ' + GW_KEY } })).json()
  const slow = (st.providers || []).find((p) => p.name === 'slow')
  const fast = (st.providers || []).find((p) => p.name === 'fast')
  ok(!!slow && !!fast, '两家供应商都在')
  ok(slow && slow.err === 0, `slow 的 err 为 0（实得 ${slow && slow.err}）—— 被取消不算失败`)
  ok(fast && fast.ok >= 1, `fast 的 ok >= 1（实得 ${fast && fast.ok}）—— 请求由它完成`)
  ok(slow && slow.lastTtfb >= SLOW_DELAY - 1500, `slow 学到真实首字节延迟 ${slow && slow.lastTtfb}ms（>= ${SLOW_DELAY - 1500}）`)
  ok(slow && (slow.latency || 0) >= SLOW_DELAY - 1500, `slow 的平均延迟被记录为 ${slow && slow.latency}ms`)

  // ── 用例 4: 排序自愈 —— slow 学到慢之后, 下次不该再排第一 ──
  console.log('\n[4] 排序自愈：slow 被降权后不再领跑')
  r = await post('/v1/chat/completions', { model: 'auto', messages: [{ role: 'user', content: 'ping3' }] })
  ok(r.ms < 1500, `第 3 次请求仅 ${r.ms}ms（fast 已排到最前, 不再等对冲窗口）`)

  console.log(`\n结果: ${pass} 通过 / ${fail} 失败`)
  cleanup()
  process.exit(fail ? 1 : 0)
}

main().catch((e) => { console.log('出错:', e.stack || e.message); cleanup(); process.exit(1) })
