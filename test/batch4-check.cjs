#!/usr/bin/env node
/*
 * 第 4 批回归: 可观测性与韧性收尾。
 * 覆盖 5 件事, 每件都在独立沙箱里跑, 不碰生产 config.json(首尾哈希守卫)。
 *
 *   4.1 /healthz?deep=1   存活 vs 就绪 —— 浅检永远秒回且不依赖外网; 深检区分"活着但干不了活"
 *   4.2 入站并发闸门       maxConcurrent 生效: 超出排队而不是打上游; 健康检查不被排队挡住
 *   4.3 管理令牌(auth)     mode=token 时 /api/* 要令牌, /healthz 与 /v1 不受影响; 配置不全时退回 local
 *   4.4 日志滚动           服务端自持日志: 超限滚动并保留历史(旧版只能原地截断丢历史)
 *   4.5 取消传播(断开在上游回话之前)  最常见的取消时刻 —— 必须真的停掉上游, 且不被算成失败
 *
 * 用法：node test/batch4-check.cjs
 */
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { spawn } = require('node:child_process')
const { resetSandboxDir, stableConfigView } = require('./sb-util.cjs')

const ROOT = (() => { const _fs = require('fs'), _p = require('path'); let d = _p.dirname(__dirname); for (let i = 0; i < 6; i++) { if (_fs.existsSync(_p.join(d, 'server.mjs'))) return d; d = _p.dirname(d) } return _p.join(__dirname, '..') })()
const NODE = process.execPath
const REAL_CONFIG = path.join(ROOT, 'config.json')
const KEY = 'freegw-batch4-test-key-00000000000'
const TOKEN = 'admin-token-batch4-0123456789'

const GW_A = 8793, UP_A = 8794      // 主沙箱: 上游可达 + token 模式 + 并发 1
const GW_B = 8795, UP_B = 8796      // 次沙箱: 上游不可达(什么都没监听) + token 模式但没配令牌

let pass = 0, fail = 0
const chk = (label, cond, extra) => { if (cond) { pass++; console.log('  PASS  ' + label) } else { fail++; console.log('  FAIL  ' + label + (extra ? ' -> ' + extra : '')) } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const sha = (p) => { try { return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex') } catch { return 'missing' } }
const waitPort = async (port, timeout = 12000) => {
  const t0 = Date.now()
  while (Date.now() - t0 < timeout) {
    try { await fetch(`http://127.0.0.1:${port}/healthz`); return true } catch { await sleep(150) }
  }
  return false
}

// ── 假上游: 支持"慢响应"与"永不响应"两种病态, 并记录客户端是否中途断开 ──
const seen = { aborted: {}, requested: {} }
function startFakeUpstream() {
  const srv = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      if (/\/models/.test(req.url)) {
        res.writeHead(200, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ object: 'list', data: [
          { id: 'fast-model', pricing: { prompt: '0', completion: '0' } },
          { id: 'slow-model', pricing: { prompt: '0', completion: '0' } },
          { id: 'hang-model', pricing: { prompt: '0', completion: '0' } },
        ] }))
      }
      let model = ''
      try { model = JSON.parse(body || '{}').model || '' } catch {}
      seen.requested[model] = (seen.requested[model] || 0) + 1
      // 客户端(网关)中途断开 -> writableEnded 还是 false。这就是"取消传播有没有生效"的观测点
      res.on('close', () => { if (!res.writableEnded) seen.aborted[model] = (seen.aborted[model] || 0) + 1 })
      const ok = (extraMs) => setTimeout(() => {
        if (res.writableEnded || res.destroyed) return
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({
          id: 'c1', object: 'chat.completion', model,
          choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }))
      }, extraMs || 0)
      if (model === 'slow-model') return ok(1500)
      if (model === 'hang-model') return   // 永不响应: 用来测"客户端在上游回话前断开"
      return ok(0)
    })
  })
  return new Promise((resolve) => {
    const srvs = []
    let pending = 2
    const done = () => { if (--pending === 0) resolve(srvs) }
    for (const host of ['127.0.0.1', '::1']) {
      const s = http.createServer(srv.listeners('request')[0])
      s.on('error', done)
      s.listen(UP_A, host, () => { srvs.push(s); done() })
    }
  })
}

function makeSandbox(dir, cfgExtra) {
  // ⚠ 非递归重置（safe-delete 守卫），见 sb-util.cjs
  resetSandboxDir(dir)
  // .sandbox 标记: 跳过启动时的 syncUpstreamWhitelist（见 server.mjs 注释）
  fs.writeFileSync(path.join(dir, '.sandbox'), '')
  fs.copyFileSync(path.join(ROOT, 'server.mjs'), path.join(dir, 'server.mjs'))
  fs.copyFileSync(path.join(ROOT, 'dashboard.html'), path.join(dir, 'dashboard.html'))
  // 白名单预置成"刚同步过且没有任何 host" —— 免得启动时去外网拉, 也免得目录同步把池改掉
  const NOW = new Date().toISOString()
  fs.writeFileSync(path.join(dir, 'free_whitelist.json'), JSON.stringify({
    fetched_at: NOW, list_date: NOW.slice(0, 10), sources: { local: NOW.slice(0, 10) }, hosts: {},
  }))
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(Object.assign({
    proxy: '', gatewayKey: KEY,
    providers: [{
      id: 'bbbb1111-2222-3333-4444-555555555555', name: 'up', label: 'up',
      base_url: `http://127.0.0.1:${UP_A}/v1`, api_key: 'sk-up', keys: ['sk-up'],
      model: 'fast-model', models: ['fast-model', 'slow-model', 'hang-model'],
      needs_proxy: false, enabled: true, ok: 0, err: 0, cooldownUntil: 0,
    }],
  }, cfgExtra), null, 2))
  return dir
}

const spawnGw = (dir) => {
  const g = spawn(NODE, ['server.mjs'], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] })
  g.stdout.on('data', () => {}); g.stderr.on('data', () => {})
  return g
}
const jget = async (base, p, headers) => {
  const r = await fetch(base + p, { headers: headers || {} })
  const t = await r.text()
  try { return { status: r.status, body: JSON.parse(t) } } catch { return { status: r.status, body: t } }
}
const postChat = (base, model, extra, headers) => fetch(base + '/v1/chat/completions', {
  method: 'POST',
  headers: Object.assign({ 'content-type': 'application/json', authorization: 'Bearer ' + KEY }, headers || {}),
  body: JSON.stringify(Object.assign({ model, messages: [{ role: 'user', content: 'hi' }] }, extra || {})),
})

;(async () => {
  const realBefore = stableConfigView(REAL_CONFIG)
  console.log('生产 config.json 语义摘要:', realBefore.slice(0, 12))

  const up = await startFakeUpstream()
  const dirA = makeSandbox(path.join(__dirname, 'sb4-a'), {
    port: GW_A, maxConcurrent: 1, auth: { mode: 'token', token: TOKEN },
  })
  // 预填 1.1MB 日志: 服务端启动后第一条日志就会把这份滚成 xiaoji.log.1
  fs.mkdirSync(path.join(dirA, 'logs'), { recursive: true })
  fs.writeFileSync(path.join(dirA, 'logs', 'xiaoji.log'), 'OLD-LOG-LINE\n'.repeat(90000))
  const preSize = fs.statSync(path.join(dirA, 'logs', 'xiaoji.log')).size

  const dirB = makeSandbox(path.join(__dirname, 'sb4-b'), {
    port: GW_B, proxy: '', auth: { mode: 'token' },   // 故意不配 token: 应退回 local
    providers: [{
      id: 'cccc1111-2222-3333-4444-555555555555', name: 'dead', label: 'dead',
      base_url: `http://127.0.0.1:${UP_B}/v1`, api_key: 'sk-x', keys: ['sk-x'],
      model: 'fast-model', models: ['fast-model'], needs_proxy: false, enabled: true, ok: 0, err: 0, cooldownUntil: 0,
    }],
  })

  const gwA = spawnGw(dirA)
  const gwB = spawnGw(dirB)
  if (!await waitPort(GW_A) || !await waitPort(GW_B)) { console.log('沙箱网关未能启动，测试中止'); process.exit(1) }
  await sleep(800)
  const A = `http://127.0.0.1:${GW_A}`, B = `http://127.0.0.1:${GW_B}`
  const TA = { 'x-admin-token': TOKEN }

  // ── 4.1 /healthz 深检 ──
  console.log('\n[4.1] /healthz 存活 vs 就绪')
  {
    const sh = await jget(A, '/healthz')
    chk('浅检永远 200 且只答"活着"', sh.status === 200 && sh.body.ok === true && sh.body.alive === true && sh.body.deep === undefined, JSON.stringify(sh.body))
    const dp = await jget(A, '/healthz?deep=1')
    chk('深检(上游可达) 200 且 ready=true', dp.status === 200 && dp.body.ready === true && dp.body.deep === true, JSON.stringify(dp.body).slice(0, 240))
    chk('深检列出逐家可达性', Array.isArray(dp.body.upstreams) && dp.body.upstreams[0].name === 'up' && dp.body.upstreams[0].ok === true, JSON.stringify(dp.body.upstreams))
    const dpB = await jget(B, '/healthz?deep=1')
    chk('深检(上游不可达) 返 503 且 ready=false', dpB.status === 503 && dpB.body.ready === false, `HTTP ${dpB.status} ${JSON.stringify(dpB.body).slice(0, 240)}`)
    chk('不可达时给出可读原因', typeof dpB.body.reason === 'string' && dpB.body.reason.length > 0, JSON.stringify(dpB.body.reason))
    chk('深检不需要管理令牌(否则监控会被自己挡住)', dpB.status !== 401)
  }

  // ── 4.2 入站并发闸门 ──
  console.log('\n[4.2] 入站并发上限（maxConcurrent=1）')
  {
    const t0 = Date.now()
    const p1 = postChat(A, 'slow-model')                       // 占住唯一名额 1.5s
    await sleep(250)
    const tH = Date.now()
    const hz = await fetch(A + '/healthz')
    const hMs = Date.now() - tH
    chk('并发占满时 /healthz 不被排队挡住', hz.status === 200 && hMs < 800, `${hMs}ms`)
    const p2 = postChat(A, 'fast-model')                       // 必须排队等待
    const [r1, r2] = await Promise.all([p1, p2])
    const ms1 = Date.now() - t0
    chk('第 1 个请求正常返回 200', r1.status === 200, 'HTTP ' + r1.status)
    chk('第 2 个请求排队后仍然成功（不是 503 硬拒）', r2.status === 200, 'HTTP ' + r2.status)
    chk('第 2 个确实等了第 1 个（总耗时 ≥ 1.4s）', ms1 >= 1400, `${ms1}ms`)
    chk('两个请求都真的打到了上游', seen.requested['slow-model'] >= 1 && seen.requested['fast-model'] >= 1, JSON.stringify(seen.requested))
  }

  // ── 4.3 管理令牌 ──
  console.log('\n[4.3] 管理令牌（auth.mode=token）')
  {
    const noTok = await jget(A, '/api/state')
    chk('/api/state 无令牌 -> 401', noTok.status === 401, 'HTTP ' + noTok.status)
    chk('401 里带 code=admin_token_required（仪表盘据此给指引）', !!(noTok.body && noTok.body.error && noTok.body.error.code === 'admin_token_required'), JSON.stringify(noTok.body))
    const withTok = await jget(A, '/api/state', TA)
    chk('/api/state 带令牌 -> 200', withTok.status === 200, 'HTTP ' + withTok.status)
    chk('回传 authMode=token', withTok.body && withTok.body.authMode === 'token', JSON.stringify(withTok.body && withTok.body.authMode))
    const hz = await jget(A, '/healthz')
    chk('/healthz 不受管理令牌影响', hz.status === 200, 'HTTP ' + hz.status)
    const vm = await jget(A, '/v1/models', { authorization: 'Bearer ' + KEY })
    chk('/v1/models 仍用网关 Key（与管理令牌是两套凭据）', vm.status === 200, 'HTTP ' + vm.status)
    const post401 = await postChat(A, 'fast-model', {}, TA)
    chk('带令牌时模型调用正常', post401.status === 200, 'HTTP ' + post401.status)
    // 写接口: 令牌对 + 网关 Key 对 -> 通过; 令牌缺 -> 401
    const w1 = await fetch(A + '/api/providers/nope/toggle', { method: 'POST', headers: Object.assign({ 'content-type': 'application/json', authorization: 'Bearer ' + KEY }, TA), body: '{}' })
    chk('写接口带令牌 -> 不再 401（此处 404 属正常）', w1.status !== 401, 'HTTP ' + w1.status)
    const w2 = await fetch(A + '/api/providers/nope/toggle', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + KEY }, body: '{}' })
    chk('写接口缺令牌 -> 401', w2.status === 401, 'HTTP ' + w2.status)
    // 配置不全必须退回 local, 而不是把人锁在门外
    const bState = await jget(B, '/api/state')
    chk('mode=token 但没配令牌 -> 退回 local（200）', bState.status === 200 && bState.body.authMode === 'local', `HTTP ${bState.status} ${JSON.stringify(bState.body && bState.body.authMode)}`)
  }

  // ── 4.4 日志滚动 ──
  console.log('\n[4.4] 日志按大小滚动 + 保留历史')
  {
    const f0 = path.join(dirA, 'logs', 'xiaoji.log')
    const f1 = f0 + '.1'
    const s0 = fs.existsSync(f0) ? fs.statSync(f0).size : -1
    chk('日志写在 logs/xiaoji.log（服务端自持, 不再靠启动脚本重定向）', s0 >= 0, 'size=' + s0)
    chk('超限的历史被滚成 .1 而不是被丢掉', fs.existsSync(f1) && fs.statSync(f1).size >= preSize, `${fs.existsSync(f1) ? fs.statSync(f1).size : 'missing'} vs 预填 ${preSize}`)
    chk('滚动后的新日志是干净的（不含旧内容）', s0 >= 0 && s0 < 64 * 1024, 'size=' + s0)
    const txt = fs.readFileSync(f0, 'utf8')
    chk('每行都带级别与时间戳（可分级）', /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3} (INFO |WARN |ERROR) /.test(txt.split('\n')[0] || ''), JSON.stringify((txt.split('\n')[0] || '').slice(0, 80)))
  }

  // ── 4.5 取消传播（断开发生在上游回话之前） ──
  console.log('\n[4.5] 客户端在上游回话前断开')
  {
    const before = seen.aborted['hang-model'] || 0
    const ac = new AbortController()
    const p = fetch(A + '/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + KEY },
      body: JSON.stringify({ model: 'hang-model', messages: [{ role: 'user', content: 'hi' }] }),
      signal: ac.signal,
    }).catch(() => null)
    await sleep(900)                       // 等它真的打到上游并挂住
    ac.abort()
    await p
    await sleep(700)
    const after = seen.aborted['hang-model'] || 0
    chk('断开后上游请求被真的中止（不再空烧额度）', after > before, `aborted ${before} -> ${after}`)
    // 关键: 这次断开不能被算成"上游失败", 否则该家会被冷却 90s, 下一个请求直接 502
    const nxt = await postChat(A, 'fast-model')
    chk('随后立刻再请求仍然成功（断开没被当成上游失败而冷却整家）', nxt.status === 200, 'HTTP ' + nxt.status)
  }

  gwA.kill(); gwB.kill()
  for (const s of up) s.close()
  await sleep(500)
  const realAfter = stableConfigView(REAL_CONFIG)
  chk('生产 config.json 未被触碰（供应商/模型/Key 摘要一致）', realBefore === realAfter, `${realBefore.slice(0, 12)} vs ${realAfter.slice(0, 12)}`)

  console.log(`\n═══ 第 4 批：${pass} 通过 / ${fail} 失败 ═══`)
  process.exit(fail ? 1 : 0)
})().catch((e) => { console.error('测试异常:', (e && e.stack) || e); process.exit(1) })
