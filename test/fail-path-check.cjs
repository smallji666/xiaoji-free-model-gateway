#!/usr/bin/env node
// fail-path-check.cjs —— 三条"失败路径"上的体验修复
//
// ① **额度重置用的是厂商自己的时区**。openrouter 的 `free-models-per-day` 按 **UTC 零点** 重置,
//    旧代码一律按 UTC+8 算 —— 额度早就回来了, 我们还在冷却, 实测最多白等 8 小时。
// ② **"代理没开"不是厂商的问题**。旧行为当 network 处理: **整家冷却 90 秒** ——
//    用户把代理打开后还要再等 90 秒才能用, 而界面上没有任何东西解释为什么。
// ③ **首字节 15 秒对交互式偏长, 但只能"有退路才敢早放弃"**。15 秒是兜底值; 直接调小会把
//    "慢但活着"的模型误杀成失败。所以只在"链上还有别的候选"且"该模型有足够实测样本"时,
//    按它**自己的**常态 TTFB 收紧; 它是最后一个候选时保持 15 秒。
//
// 本套件断言的是**状态与耗时**, 不是"请求成功与否" —— 这三个问题都不会让请求直接报错,
// 只会悄悄变慢 / 悄悄多等。
//
// 端口 8827/8828 是专属区间; 8829/8830 是**故意不监听**的死端口(用来制造"连不上"和"代理没开")。
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')

const NODE = process.execPath
const HERE = __dirname
const SB = path.join(HERE, 'sb-path')
const ROOT = (() => { const _fs = require('fs'), _p = require('path'); let d = _p.dirname(__dirname); for (let i = 0; i < 6; i++) { if (_fs.existsSync(_p.join(d, 'server.mjs'))) return d; d = _p.dirname(d) } return _p.join(__dirname, '..') })()
const GW_PORT = 8827
const UP_PORT = 8828
const DEAD_PORT = 8829     // 没人监听: 造"直连连不上"
const DEAD_PROXY = 8830    // 没人监听: 造"代理没开"
const GW_KEY = 'freegw-path-test-0000000000000000'
const CFG = path.join(SB, 'config.json')
const CAT = path.join(SB, 'free_catalog.json')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let pass = 0, fail = 0
let lastResp = ''
const ok = (c, m, extra) => {
  if (c) { pass++; console.log('  PASS  ' + m) }
  else { fail++; console.log('  FAIL  ' + m + (extra ? '  → ' + extra : '')); if (lastResp) console.log('    ↳ 最近响应: ' + lastResp.replace(/\s+/g, ' ').slice(0, 240)) }
}

// ── 假上游 ──
//   hang-8b  : hangMode 关 -> 立刻 200(流式); 开 -> **永不响应头**(模拟"连得上但不回")
//   alone-8b : 同上, 用 aloneHang 单独控制(它要测"没有退路时保持 15 秒")
//   quota-8b : 429 + "free-models-per-day"(日额度用完, 无 Retry-After)
//   ok-8b    : 200
let hangMode = false
let aloneHang = false
const ALL_MODELS = ['hang-8b', 'ok-8b', 'alone-8b', 'quota-8b']
const hanging = new Set()
const up = http.createServer((req, res) => {
  let body = ''
  req.on('data', (c) => { body += c })
  req.on('end', () => {
    if (req.url.includes('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ object: 'list', data: ALL_MODELS.map((id) => ({ id })) }))
    }
    let p = {}
    try { p = JSON.parse(body) } catch {}
    const m = String(p.model || '')
    if (m.includes('quota-8b')) {
      res.writeHead(429, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ error: { message: 'Rate limit exceeded: free-models-per-day. Add 10 credits to unlock 1000 free model requests per day' } }))
    }
    const hang = (m.includes('hang-8b') && hangMode) || (m.includes('alone-8b') && aloneHang)
    if (hang) { hanging.add(res); return }   // 挂住: 一个字节都不回
    if (p.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      res.write(`data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', model: m, choices: [{ index: 0, delta: { role: 'assistant', content: 'OK' }, finish_reason: null }] })}\n\n`)
      res.write(`data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', model: m, choices: [{ index: 0, delta: { content: ' done' }, finish_reason: 'stop' }], usage: { total_tokens: 3 } })}\n\n`)
      res.write('data: [DONE]\n\n')
      return res.end()
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({
      id: 'x', object: 'chat.completion', model: m,
      choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }))
  })
})

const procs = []
let gwLog = ''
function launch(args, cwd) {
  const p = spawn(NODE, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
  p.stdout.on('data', (d) => { gwLog += d })
  p.stderr.on('data', (d) => { gwLog += d })
  procs.push(p)
  return p
}
function cleanup() {
  for (const r of hanging) { try { r.destroy() } catch {} }
  for (const p of procs) { try { p.kill() } catch {} }
  try { up.closeAllConnections() } catch {}
  try { up.close() } catch {}
}
process.on('exit', cleanup)

function writeCfg(c) { fs.writeFileSync(CFG, JSON.stringify(c, null, 2)) }
async function waitFor(fn, ms = 8000) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    try { if (await fn()) return true } catch {}
    await sleep(120)
  }
  return false
}
async function chat(model, stream = false) {
  const t0 = Date.now()
  const r = await fetch(`http://127.0.0.1:${GW_PORT}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + GW_KEY },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi ' + Math.random() }], max_tokens: 8, stream }),
  })
  const text = await r.text()
  lastResp = text
  return { status: r.status, text, ms: Date.now() - t0, provider: r.headers.get('x-xiaoji-provider') || '' }
}
// 读**内存态**(/api/state)而不是 config.json: saveConfig 有 300ms 防抖, 写完立刻读盘是旧值。
const prov = async (name) => {
  const r = await fetch(`http://127.0.0.1:${GW_PORT}/api/state`)
  const s = await r.json()
  return (s.providers || []).find((p) => p.name === name) || {}
}
// "该家当地明天零点" —— 与 server.mjs 的 quotaCooldownMs 同一口径(offset 小时数)。
function nextMidnightMs(offHours) {
  const off = offHours * 3600000
  const local = new Date(Date.now() + off)
  return Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + 1) - off + 120000
}
const cooldownLeft = (p, m) => {
  const t = (p.modelCooldown && p.modelCooldown[m]) || 0
  return t ? t - Date.now() : 0
}
// 失败候选的记账(内存态, 见 /api/usage)。用它验"超时值到底是多少" ——
// 那句 `上游 6s 内未返回响应头` 只出现在失败候选的 reason 里, 成功的响应体里没有。
async function failReasons(model) {
  const r = await fetch(`http://127.0.0.1:${GW_PORT}/api/usage?ok=0&limit=60`)
  const j = await r.json()
  return (j.records || []).filter((x) => !model || x.model === model).map((x) => String(x.reason || ''))
}

async function main() {
  const now = new Date().toISOString()
  fs.mkdirSync(SB, { recursive: true })
  for (const f of ['config.json.prev', 'config.json.tmp', 'gateway.pid', 'usage_log.json', 'metrics.json', 'promo_state.json', 'free_whitelist.json']) {
    try { fs.unlinkSync(path.join(SB, f)) } catch {}
  }
  const mk = (name, models, extra = {}) => ({
    id: name, name, label: name, base_url: `http://127.0.0.1:${UP_PORT}/v1`,
    api_key: 'sk-x', keys: ['sk-x'], model: models[0], models,
    needs_proxy: false, enabled: true, ok: 0, err: 0, cooldownUntil: 0, lastError: '', lastSweepAt: now,
    ...extra,
  })
  writeCfg({
    port: GW_PORT, proxy: `http://127.0.0.1:${DEAD_PROXY}`, gatewayKey: GW_KEY, maxConcurrent: 0,
    providers: [
      mk('hango', ['hang-8b', 'ok-8b']),
      mk('backo', ['ok-8b']),
      mk('lonelyo', ['alone-8b']),
      mk('openrouter', ['quota-8b']),
      mk('genco', ['quota-8b']),
      mk('pxco', ['ok-8b'], { needs_proxy: true, base_url: 'https://api.example.com/v1' }),
      mk('directo', ['ok-8b'], { base_url: `http://127.0.0.1:${DEAD_PORT}/v1` }),
    ],
    // 组只收窄候选集合: 这两个候选刚好用来验"有退路时提前放弃"
    groups: { cmp: ['hango/hang-8b', 'backo/ok-8b'] },
  })
  // 预置目录快照 = 所有模型都"已知 ok" -> 启动扫描不会对它们发**入池探活**。
  // 不预置的话, 探活会把 quota-8b 先冷却掉(于是我们的请求根本打不到上游)、
  // 把 directo 先冷却 90 秒(于是"直连失败"那条对照断言必然红)。
  fs.writeFileSync(CAT, JSON.stringify({
    updated_at: now, ruleset: {}, changes: [],
    providers: ['hango', 'backo', 'lonelyo', 'openrouter', 'genco', 'pxco', 'directo'].map((name) => ({
      name, label: name, base_url: `http://127.0.0.1:${UP_PORT}/v1`, error: '',
      models: ALL_MODELS.map((id) => ({ id })), total: ALL_MODELS.length, excluded: [],
    })),
  }, null, 2))
  fs.writeFileSync(path.join(SB, '.sandbox'), '')
  fs.writeFileSync(path.join(SB, 'free_whitelist.json'), JSON.stringify({ list_date: now.slice(0, 10), fetched_at: now, sources: { local: now.slice(0, 10) }, hosts: {} }, null, 2))
  fs.copyFileSync(path.join(ROOT, 'server.mjs'), path.join(SB, 'server.mjs'))
  fs.copyFileSync(path.join(ROOT, 'dashboard.html'), path.join(SB, 'dashboard.html'))

  await new Promise((r) => up.listen(UP_PORT, '127.0.0.1', r))
  launch([path.join(SB, 'server.mjs')], SB)
  const ready = await waitFor(async () => (await fetch(`http://127.0.0.1:${GW_PORT}/api/state`)).ok, 30000)
  if (!ready) { console.log('  FAIL  网关未在 30s 内就绪'); console.log(gwLog.slice(-800)); process.exit(1) }
  await sleep(1500)

  // ══ 一、额度按厂商自己的时区重置 ══
  console.log('\n【一】日额度重置时区（openrouter 是 UTC 零点，别按 UTC+8 算）')
  const r1 = await chat('openrouter/quota-8b')
  ok(r1.status >= 400, `额度用完时调用失败（HTTP ${r1.status}，这是预期）`)
  const orCd = cooldownLeft(await prov('openrouter'), 'quota-8b')
  const orWant = nextMidnightMs(0) - Date.now()
  ok(Math.abs(orCd - orWant) < 180000,
    `openrouter 冷却到 **UTC 零点**（实得 ${(orCd / 3600000).toFixed(1)}h，应为 ${(orWant / 3600000).toFixed(1)}h）`)

  const r2 = await chat('genco/quota-8b')
  ok(r2.status >= 400, `同一条错误在普通厂商上也失败（HTTP ${r2.status}）`)
  const genCd = cooldownLeft(await prov('genco'), 'quota-8b')
  const genWant = nextMidnightMs(8) - Date.now()
  ok(Math.abs(genCd - genWant) < 180000,
    `认不出的厂商仍按 **UTC+8 零点**（实得 ${(genCd / 3600000).toFixed(1)}h，应为 ${(genWant / 3600000).toFixed(1)}h）`)
  ok(Math.abs(genCd - orCd) > 3600000,
    '两家算出的重置时间**确实不同**（同一条错误、不同厂商口径 —— 这一条防"改了个参数但其实没生效"）')

  // ══ 二、"代理没开"不是厂商的错 ══
  console.log('\n【二】代理没开：不许冷却整家 90 秒')
  const r3 = await chat('pxco/ok-8b')
  ok(r3.status >= 400, `需要代理的家在代理没开时失败（HTTP ${r3.status}）`)
  const px = await prov('pxco')
  const pxCd = (px.cooldownUntil || 0) - Date.now()
  ok(pxCd > 0 && pxCd <= 10000, `只冷却 5 秒级，不是 90 秒（实得 ${Math.round(pxCd / 1000)}s）—— 打开代理后立刻能用`)
  ok(!(px.downUntil && px.downUntil['ok-8b']), '没有把它降级 30 分钟（病因在本机，与这个模型无关）')
  ok(!(px.failStreak && px.failStreak['ok-8b']), '没有记进连续失败计数（否则会一路退避到 12 分钟）')
  ok(/代理/.test(String(px.lastError || '')), 'lastError 直接点名"代理"（不是"厂商返回异常"）', px.lastError)

  // 反断言: **直连**连不上仍然是正常的 network 处理(90 秒 + 降级), 别把这条通道一起改坏了
  const r4 = await chat('directo/ok-8b')
  ok(r4.status >= 400, `直连连不上时调用失败（HTTP ${r4.status}）`)
  const di = await prov('directo')
  const diCd = (di.cooldownUntil || 0) - Date.now()
  ok(diCd > 80000, `直连失败仍是 90 秒整家冷却（实得 ${Math.round(diCd / 1000)}s）—— 没有被上面的改动连累`)

  // ══ 三、首字节超时: 有退路才敢早放弃 ══
  console.log('\n【三】首字节超时（有退路收紧到 ~6s，没退路保持 15s）')
  // 先用 3 次成功把 hango/hang-8b 的实测 TTFB 学出来(样本 <3 不启用收紧)。
  for (let i = 0; i < 3; i++) await chat('hango/hang-8b', true)
  const hg = await prov('hango')
  ok((hg.modelLatN && hg.modelLatN['hang-8b']) >= 3, `该模型已积累 ≥3 个首字节样本（实得 ${(hg.modelLatN || {})['hang-8b'] || 0}）`)
  hangMode = true
  const r5 = await chat('cmp', true)
  ok(r5.status === 200, `领跑者卡死时仍然答出来了（HTTP ${r5.status}）`)
  ok(r5.provider === 'backo', `答案来自链上的下一家（实得 ${r5.provider || '(空)'}）`)
  ok(r5.ms > 4000 && r5.ms < 12000, `**没有**干等满 15 秒（实得 ${(r5.ms / 1000).toFixed(1)}s，收紧后约 6s）`)
  const hgWhy = await failReasons('hang-8b')
  ok(hgWhy.some((s) => /6s 内未返回响应头/.test(s)), '失败记账里写清了收紧后的超时值（不是悄悄变成 6s）', hgWhy[0] || '')

  // 反断言: **最后一个候选**必须保持 15 秒 —— 早放弃只会把"慢一点但能答"变成"报错"
  for (let i = 0; i < 3; i++) await chat('lonelyo/alone-8b', true)
  aloneHang = true
  const r6 = await chat('lonelyo/alone-8b', true)
  ok(r6.status >= 400, `唯一的候选卡死时最终失败（HTTP ${r6.status}）`)
  ok(r6.ms >= 13000, `没有退路时仍等满 15 秒（实得 ${(r6.ms / 1000).toFixed(1)}s）—— 不拿"可能很慢"换"一定失败"`)
  const alWhy = await failReasons('alone-8b')
  ok(alWhy.some((s) => /15s 内未返回响应头/.test(s)), '失败记账里仍是 15 秒（说明收紧只在有退路时生效）', alWhy[0] || '')

  if (process.env.DUMP_LOG) console.log('\n===== gwLog =====\n' + gwLog)
  console.log(`\n${fail ? '✗' : '✓'} fail-path-check: ${pass} 通过 / ${fail} 失败`)
  cleanup()
  process.exit(fail ? 1 : 0)
}

main().catch((e) => { console.error(e); cleanup(); process.exit(1) })
