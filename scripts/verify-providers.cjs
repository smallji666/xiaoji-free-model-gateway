#!/usr/bin/env node
// verify-providers.cjs — 配置自检：把 config.json 里每个「免 Key(anon)」厂商的模型
// 逐个发一条最小 chat 请求，确认 base_url + model 组合真的能调通。
// 用途：接入新厂商后跑一次，避免"配置写进去了但其实调不通"。
// 用法：node scripts/verify-providers.cjs [providerName ...]
const fs = require('fs')
const path = require('path')
const http = require('http')
const https = require('https')

const ROOT = path.resolve(__dirname, '..')
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'))
const only = process.argv.slice(2)

// 复用与 server.mjs 相同的代理设置（读 config.json 的 proxy 字段）
const proxyUrl = cfg.proxy || ''
let proxy = null
try { if (proxyUrl) proxy = new URL(proxyUrl) } catch {}

function post(urlStr, body, headers, timeoutMs) {
  return new Promise((resolve) => {
    const u = new URL(urlStr)
    const payload = JSON.stringify(body)
    const opts = {
      method: 'POST',
      host: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), ...headers },
      timeout: timeoutMs,
    }
    // 走 HTTP 代理：CONNECT 隧道
    if (proxy) {
      const creq = http.request({
        host: proxy.hostname, port: proxy.port, method: 'CONNECT',
        path: `${u.hostname}:${u.port || 443}`, timeout: timeoutMs,
      })
      creq.on('connect', (res, socket) => {
        if (res.statusCode !== 200) { socket.destroy(); return resolve({ status: 0, text: 'proxy ' + res.statusCode }) }
        const req = https.request({ ...opts, socket, agent: false }, onRes)
        req.on('error', (e) => resolve({ status: 0, text: e.message }))
        req.on('timeout', () => { req.destroy(); resolve({ status: 0, text: 'timeout' }) })
        req.end(payload)
      })
      creq.on('error', (e) => resolve({ status: 0, text: 'proxy err ' + e.message }))
      creq.on('timeout', () => { creq.destroy(); resolve({ status: 0, text: 'proxy timeout' }) })
      creq.end()
      return
    }
    const mod = u.protocol === 'https:' ? https : http
    const req = mod.request(opts, onRes)
    req.on('error', (e) => resolve({ status: 0, text: e.message }))
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, text: 'timeout' }) })
    req.end(payload)
    function onRes(res) {
      let t = ''
      res.on('data', (c) => { t += c })
      res.on('end', () => resolve({ status: res.statusCode, text: t }))
    }
  })
}

;(async () => {
  const targets = cfg.providers.filter((p) => p.enabled !== false && (!only.length || only.includes(p.name)))
  console.log(`验证 ${targets.length} 家厂商的模型可调用性\n`)
  let pass = 0, fail = 0, skip429 = 0
  for (const p of targets) {
    const models = (p.models && p.models.length) ? p.models : [p.model]
    console.log(`── ${p.label || p.name} (${models.length} 个模型)`)
    for (const m of models) {
      const url = p.base_url.replace(/\/$/, '') + '/chat/completions'
      // ⚠ anon(免 Key)厂商**不能带 Authorization 头** —— 实测 OVH/Kilo 收到一个假的
      // "Bearer free" 会直接回 403/401 "authentication failed"，不带就正常 200。
      // 这是"配置写对但调不通"的典型陷阱，必须在这里体现。
      const headers = p.anon ? {} : { authorization: 'Bearer ' + ((p.keys && p.keys[0]) || '') }
      const r = await post(url, { model: m, messages: [{ role: 'user', content: 'hi' }], max_tokens: 5 },
        headers, 45000)
      if (r.status === 200 && /"choices"/.test(r.text)) { console.log(`  ✓ ${m}`); pass++ }
      else if (r.status === 429) { console.log(`  ~ ${m}  (429 限流，不计失败)`); skip429++ }
      else { console.log(`  ✗ ${m}  HTTP ${r.status} ${r.text.slice(0, 90).replace(/\s+/g, ' ')}`); fail++ }
    }
  }
  console.log(`\n结果: ✓${pass} 通过  ✗${fail} 失败  ~${skip429} 限流`)
  process.exit(fail ? 1 : 0)
})()
