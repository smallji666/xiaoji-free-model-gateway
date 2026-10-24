#!/usr/bin/env node
/*
 * 多 Key 轮转（LRU）回归
 *
 * 为什么单开一个套件：`pickKeyIdx()` 是**唯一**决定"这次请求花哪把 Key 的额度"的地方，
 * 而它的旧实现是"从下标 0 往后找第一把没冷却的" —— 也就是**永远用第 0 把**。
 * 免费池的瓶颈恰恰是每把 Key 各自的每日 / RPM 额度：配了 3 把却只用 1 把，
 * 等于把 3 份额度当成 1 份花；更糟的是切换点是"第 1 把已经被限流(429)"，那次请求已经白费。
 * 这条行为没有任何其它套件覆盖（batch3 只验 reindexKeys 的下标前移，不验选择策略）。
 *
 * 测什么（全部端到端，不读源码猜）：
 *   1. 3 把 Key 连打 4 次 → 假上游看到的 Authorization 必须依次是 k0,k1,k2,k0（轮转）
 *   2. 任何一把都不许被连续用两次（这是"轮转"的定义，也是旧实现唯一会违反的那条）
 *   3. 从没用过的新 Key 优先于用过的（LRU 的"最久未用"在冷启动时必须成立）
 *   4. 单 Key 供应商行为不变（只有一把时永远选它 —— 绝大多数用户是这种）
 *
 * 沙箱：独立目录 + 独立端口(8831 网关 / 8832 假上游)，首尾各算一次生产 config.json 的
 * 语义摘要做"没碰生产"的守卫。端口避开 run-all 端口表里已占用的区间。
 *
 * 用法：node test/key-rotate-check.cjs
 */
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { resetSandboxDir, stableConfigView } = require('./sb-util.cjs')

const ROOT = (() => { const _fs = require('fs'), _p = require('path'); let d = _p.dirname(__dirname); for (let i = 0; i < 6; i++) { if (_fs.existsSync(_p.join(d, 'server.mjs'))) return d; d = _p.dirname(d) } return _p.join(__dirname, '..') })()
const NODE = process.execPath
const GW_PORT = 8831
const UP_PORT = 8832
const KEY = 'freegw-keyrot-test-0000000000000000'
const REAL_CONFIG = path.join(ROOT, 'config.json')
const MODEL = 'llama-3.3-70b-versatile'
const SB = path.join(__dirname, 'sb-keyrot')

let pass = 0, fail = 0
const chk = (label, cond, extra) => { if (cond) { pass++; console.log('  PASS  ' + label) } else { fail++; console.log('  FAIL  ' + label + (extra ? ' -> ' + extra : '')) } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 假上游按"到达顺序"记录每次请求带的 Key。用数组而不是只记最后一次 ——
// 轮转是**顺序性质**，只留最后一份等于把要验的东西扔了。
let seenAuth = []
function startFakeUpstream() {
  const s = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      if (req.method === 'GET' && /\/models/.test(req.url)) {
        res.writeHead(200, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ object: 'list', data: [{ id: MODEL }] }))
      }
      seenAuth.push(String(req.headers.authorization || '').replace(/^Bearer\s+/i, ''))
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        id: 'chatcmpl-test', object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: MODEL,
        choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }))
    })
  })
  return new Promise((resolve) => s.listen(UP_PORT, '127.0.0.1', () => resolve(s)))
}

const waitPort = async (port, timeout = 12000) => {
  const t0 = Date.now()
  while (Date.now() - t0 < timeout) {
    try { await fetch(`http://127.0.0.1:${port}/healthz`); return true } catch { await sleep(150) }
  }
  return false
}

function makeSandbox(keys) {
  resetSandboxDir(SB)
  fs.mkdirSync(SB, { recursive: true })
  fs.copyFileSync(path.join(ROOT, 'server.mjs'), path.join(SB, 'server.mjs'))
  // .sandbox 标记：否则启动 600ms 内那轮真实白名单同步会把下面这份构造好的名单覆盖掉，
  // whitelistFor(127.0.0.1) 变 null，免费闸门掉到启发式，池子就不是我们构造的了。
  fs.writeFileSync(path.join(SB, '.sandbox'), '')
  fs.writeFileSync(path.join(SB, 'free_whitelist.json'), JSON.stringify({
    fetched_at: new Date().toISOString(),
    list_date: new Date().toISOString().slice(0, 10),
    hosts: { '127.0.0.1': { source: 'sandbox', models: [MODEL] } },
  }))
  fs.writeFileSync(path.join(SB, 'config.json'), JSON.stringify({
    port: GW_PORT, proxy: '', gatewayKey: KEY, aliases: {},
    // coalesce 关掉：本套件要连打多次**相似**请求来观察轮转，默认开启的并发合并会把
    // "同一时刻在飞的相同 payload"并成一次，于是第 2、3 次根本不产生上游请求（见 CHANGELOG 1.2.0）。
    coalesce: false,
    providers: [{
      id: 'aaaa1111-2222-3333-4444-555555555555', name: 'keyrot', label: 'keyrot',
      base_url: `http://127.0.0.1:${UP_PORT}/v1`, keys: keys.slice(), api_key: keys[0],
      model: MODEL, models: [MODEL], needs_proxy: false, enabled: true, ok: 3, err: 0,
      cooldownUntil: 0, lastSweepAt: new Date(Date.now() + 3600e3).toISOString(), disabledModels: {},
    }],
  }, null, 2))
}

const BASE = () => `http://127.0.0.1:${GW_PORT}`
async function chat(n) {
  const r = await fetch(BASE() + '/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + KEY, 'content-type': 'application/json' },
    // 每次内容都不同：既是"真实的不同请求"，也顺手避开 coalesce（见 makeSandbox 注释）
    body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: `ping-${n}` }], stream: false }),
  })
  const t = await r.text()
  return { status: r.status, text: t }
}

;(async () => {
  const realBefore = stableConfigView(REAL_CONFIG)
  const up = await startFakeUpstream()
  const KEYS = ['sk-keyrot-a', 'sk-keyrot-b', 'sk-keyrot-c']
  makeSandbox(KEYS)
  const gw = spawn(NODE, ['server.mjs'], { cwd: SB, stdio: ['ignore', 'pipe', 'pipe'] })
  let gwLog = ''
  gw.stdout.on('data', (d) => { gwLog += d })
  gw.stderr.on('data', (d) => { gwLog += d })
  if (!await waitPort(GW_PORT)) { console.error('沙箱网关未能启动。日志:\n' + gwLog.slice(-1500)); process.exit(1) }

  // 等"启动 3 秒后自动跑的那轮目录扫描"落盘 —— 与 gate-check / features-check 同一原因：
  // 抢在它前面改路由池，结果会被它覆盖，断言随机失败（看起来像被测代码坏了）。
  {
    let listenAt = 0
    try { listenAt = fs.statSync(path.join(SB, 'gateway.pid')).mtimeMs } catch {}
    for (let i = 0; i < 80; i++) {
      let catAt = 0
      try { catAt = fs.statSync(path.join(SB, 'free_catalog.json')).mtimeMs } catch {}
      if (listenAt && Date.now() - listenAt >= 3200 && catAt >= listenAt + 3000) break
      if (!listenAt && i > 40) break
      await sleep(100)
    }
  }

  try {
    // ── 1. 轮转 ──
    seenAuth = []
    for (let i = 0; i < 4; i++) {
      const r = await chat(i)
      if (r.status !== 200) { chk(`第 ${i + 1} 次请求成功`, false, `HTTP ${r.status} ${r.text.slice(0, 200)}`); break }
    }
    chk('4 次请求全部成功', seenAuth.length === 4, `上游只收到 ${seenAuth.length} 次`)
    chk('按顺序轮转 a→b→c→a', seenAuth.join(',') === 'sk-keyrot-a,sk-keyrot-b,sk-keyrot-c,sk-keyrot-a', seenAuth.join(','))

    // ── 2. 反向断言：任何一把都不许被连续用两次 ──
    // 旧实现（永远返回下标 0）在这一条上必然失败，这是本套件的核心判据。
    let consecutive = false
    for (let i = 1; i < seenAuth.length; i++) if (seenAuth[i] === seenAuth[i - 1]) consecutive = true
    chk('没有同一把 Key 被连续使用两次', seenAuth.length >= 2 && !consecutive, seenAuth.join(','))

    // ── 3. LRU：新加进来的 Key（从没用过）必须优先 ──
    // 通过 Key 管理接口加第 4 把，然后下一次请求应该用它 —— 因为它的 lastUsed 是空。
    // 用「加 Key」而不是「删 Key」是因为删 Key 会触发 reindexKeys 整体前移，那是 batch3 的事。
    seenAuth = []
    const add = await fetch(BASE() + '/api/providers/keyrot/keys/add', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + KEY, 'content-type': 'application/json' },
      body: JSON.stringify({ key: 'sk-keyrot-d' }),
    })
    const addBody = await add.text()
    if (add.status === 200) {
      await chat('after-add')
      chk('新增的 Key 优先被使用（从没用过 = lastUsed 为空）', seenAuth[0] === 'sk-keyrot-d', `实际=${seenAuth[0]} / ${addBody.slice(0, 120)}`)
    } else {
      chk('新增的 Key 优先被使用（从没用过 = lastUsed 为空）', false, `加 Key 接口返回 HTTP ${add.status}: ${addBody.slice(0, 160)}`)
    }

    // ── 4. 单 Key 不变 ──
    // 删到只剩一把（接口不允许删到 0 把，所以每次删下标 1，连删三次剩 a），再验每次都选它。
    // 删 Key 走的是 reindexKeys 那条路径，顺带证明轮转逻辑不会在单 Key 下选空（返回 -1 会让
    // 上游拿到空 Key 直接 401）。
    seenAuth = []
    for (let i = 0; i < 3; i++) {
      await fetch(BASE() + '/api/providers/keyrot/keys/remove', {
        method: 'POST',
        headers: { authorization: 'Bearer ' + KEY, 'content-type': 'application/json' },
        body: JSON.stringify({ idx: 1 }),
      })
    }
    for (let i = 0; i < 2; i++) await chat('solo-' + i)
    chk('只剩一把 Key 时每次都选它', seenAuth.length === 2 && seenAuth.every((x) => x === 'sk-keyrot-a'), seenAuth.join(','))
  } catch (e) {
    chk('套件执行未抛错', false, e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : String(e))
  } finally {
    try { gw.kill() } catch {}
    if (process.platform === 'win32') { try { require('node:child_process').execSync('taskkill /PID ' + gw.pid + ' /F', { stdio: 'ignore' }) } catch {} }
    try { up.close() } catch {}
  }

  const realAfter = stableConfigView(REAL_CONFIG)
  chk('没有碰生产 config.json', realBefore === realAfter, `${realBefore} -> ${realAfter}`)

  console.log(`\n== ${pass} passed, ${fail} failed ==`)
  process.exit(fail ? 1 : 0)
})()
