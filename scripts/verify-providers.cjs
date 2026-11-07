#!/usr/bin/env node
// verify-providers.cjs — 配置自检：把 config.json 里每个已启用厂商的模型
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

// ⚠ 判"这家能不能用"不能只看 HTTP 200（项目里已经栽过三次同源事故：
//   200+{error} 体、200+SSE error 事件、200+空回答）。原来的判据是 `/\"choices\"/.test(text)`，
//   比"只看 200"更糟 —— 错误体里只要提到 choices 就算通过。
//   这里解析成结构再看：有 error 就是失败；choices[0] 既没内容也没 finish_reason 也算失败。
function judge(text) {
  let j
  try { j = JSON.parse(text) } catch { return { ok: false, why: '非 JSON 响应: ' + String(text).slice(0, 60).replace(/\s+/g, ' ') } }
  if (j && j.error) return { ok: false, why: 'error: ' + String((j.error && (j.error.message || j.error.type)) || JSON.stringify(j.error)).slice(0, 80) }
  const c = (j && Array.isArray(j.choices)) ? j.choices[0] : null
  if (!c) return { ok: false, why: '没有 choices 数组' }
  const msg = c.message || c.delta || {}
  const content = typeof msg.content === 'string'
    ? msg.content
    : (Array.isArray(msg.content) ? msg.content.map((x) => (x && x.text) || '').join('') : '')
  // max_tokens=5 时正常回答常常是空 content + finish_reason=length，所以 finish_reason 也算证据
  if (!content.trim() && !c.finish_reason) return { ok: false, why: 'choices 里既没内容也没 finish_reason（空回答）' }
  return { ok: true, why: content.trim() ? '' : 'finish_reason=' + c.finish_reason }
}

;(async () => {
  const targets = cfg.providers.filter((p) => p.enabled !== false && (!only.length || only.includes(p.name)))
  console.log(`验证 ${targets.length} 家厂商的模型可调用性\n`)
  let pass = 0, fail = 0, skip429 = 0, skipNoUrl = 0
  for (const p of targets) {
    const models = (p.models && p.models.length) ? p.models : [p.model]
    if (!p.base_url) { console.log(`── ${p.label || p.name} 跳过：没有 base_url`); skipNoUrl++; continue }
    console.log(`── ${p.label || p.name} (${models.length} 个模型)`)
    for (const m of models) {
      const url = p.base_url.replace(/\/$/, '') + '/chat/completions'
      // ⚠ anon(免 Key)厂商**不能带 Authorization 头** —— 实测 OVH/Kilo 收到一个假的
      // "Bearer free" 会直接回 403/401 "authentication failed"，不带就正常 200。
      // 这是"配置写对但调不通"的典型陷阱，必须在这里体现。
      const headers = p.anon ? {} : { authorization: 'Bearer ' + ((p.keys && p.keys[0]) || '') }
      const r = await post(url, { model: m, messages: [{ role: 'user', content: 'hi' }], max_tokens: 5 },
        headers, 45000)
      if (r.status === 429) { console.log(`  ~ ${m}  (429 限流，不计失败)`); skip429++; continue }
      if (r.status !== 200) { console.log(`  ✗ ${m}  HTTP ${r.status} ${r.text.slice(0, 90).replace(/\s+/g, ' ')}`); fail++; continue }
      const v = judge(r.text)
      if (v.ok) { console.log(`  ✓ ${m}${v.why ? '  (' + v.why + ')' : ''}`); pass++ }
      else { console.log(`  ✗ ${m}  HTTP 200 但${v.why}`); fail++ }
    }
  }
  console.log(`\n结果: ✓${pass} 通过  ✗${fail} 失败  ~${skip429} 限流${skipNoUrl ? '  ⊘' + skipNoUrl + ' 缺 base_url' : ''}`)
  process.exit(fail ? 1 : 0)
})()
