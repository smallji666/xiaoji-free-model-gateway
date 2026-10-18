// 端到端验证: 用真实网关 Key 走一次 auto 路由请求, 确认整条链路可用。
// 用 node 读 config.json 取 Key —— 避免 Key 出现在工具输出里被显示层替换成假值。
//
// ⚠ 2026-09-19 补断言与退出码。此前这个脚本**只打印不判定**: 无论上游 502、内容为空、
//   鉴权被绕过, 进程都退 0 —— 挂在 CI / 批量回归里等于一个永远绿的空壳。现在:
//     · 每条用例都有明确期望(状态码 / 内容非空 / 请求 ID 贯通), 失败计数进 process.exitCode
//     · 流式用例真的读 SSE 并按行缓冲拼内容(顺带覆盖"分包切断一行"的老坑)
//     · 额外验证错误响应里也带 request_id —— 排查线上问题时它就是那根线头
//
// 依赖: 线上网关已在跑(默认 8787, 端口取 config.json)。
// 用法：node test/e2e-check.cjs
const fs = require('node:fs')
const path = require('node:path')

const cfg = JSON.parse(fs.readFileSync(path.join((() => { const _fs = require('fs'), _p = require('path'); let d = _p.dirname(__dirname); for (let i = 0; i < 6; i++) { if (_fs.existsSync(_p.join(d, 'server.mjs'))) return d; d = _p.dirname(d) } return _p.join(__dirname, '..') })(), 'config.json'), 'utf8'))
const key = cfg.gatewayKey
const base = 'http://127.0.0.1:' + (cfg.port || 8787)
const RID_RE = /^[0-9a-f]{8}$/          // 服务端生成的请求 ID: 8 位 hex

let pass = 0, fail = 0
const chk = (label, cond, extra) => { if (cond) { pass++; console.log('  PASS  ' + label) } else { fail++; console.log('  FAIL  ' + label + (extra ? ' -> ' + extra : '')) } }

// ⚠ max_tokens 给足 150+: 思考型模型(gemini-3-flash / north-mini-code 之类)会把预算全花在
// reasoning 上, 20~30 的预算下会返回**空 content + finish_reason=stop**, 看着像 bug 其实不是。
// 断言"content 非空"时这一点必须考虑, 否则这条用例会随机假失败。
const TOK = 200
const SAY = { role: 'user', content: '只回复两个字：正常' }

async function post(body, headers) {
  const t0 = Date.now()
  try {
    const r = await fetch(base + '/v1/chat/completions', {
      method: 'POST',
      headers: Object.assign({ 'content-type': 'application/json', authorization: 'Bearer ' + key }, headers || {}),
      body: JSON.stringify(body),
    })
    const txt = await r.text()
    let content = '', err = ''
    try {
      const j = JSON.parse(txt)
      if (j.error) err = j.error.message || JSON.stringify(j.error)
      else {
        const c = j.choices && j.choices[0]
        content = (c && c.message && c.message.content) || ''
      }
    } catch { err = txt.slice(0, 200) }
    return { status: r.status, rid: r.headers.get('x-request-id') || '', content, err, raw: txt, ms: Date.now() - t0 }
  } catch (e) {
    return { status: 0, rid: '', content: '', err: e.message, raw: '', ms: Date.now() - t0 }
  }
}

// 流式: 按行缓冲解析 SSE(不能 split('\n') 直接切 —— TCP 分包会切断一行 JSON)
async function postStream(body) {
  const t0 = Date.now()
  try {
    const r = await fetch(base + '/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key },
      body: JSON.stringify(body),
    })
    let content = '', sawDone = false, chunks = 0
    if (r.body) {
      const rd = r.body.getReader()
      const dec = new TextDecoder()
      let buf = ''
      for (;;) {
        const { value, done } = await rd.read()
        if (done) break
        buf += dec.decode(value, { stream: true })
        let i
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim()
          buf = buf.slice(i + 1)
          if (!line.startsWith('data:')) continue
          const payload = line.slice(5).trim()
          if (payload === '[DONE]') { sawDone = true; continue }
          try {
            const j = JSON.parse(payload)
            const c = j.choices && j.choices[0]
            const d = c && (c.delta || c.message)
            if (d && d.content) { content += d.content; chunks++ }
          } catch { /* 非 JSON 的行(注释/心跳)忽略 */ }
        }
      }
    }
    return { status: r.status, rid: r.headers.get('x-request-id') || '', content, sawDone, chunks, ms: Date.now() - t0 }
  } catch (e) {
    return { status: 0, rid: '', content: '', sawDone: false, chunks: 0, err: e.message, ms: Date.now() - t0 }
  }
}

;(async () => {
  console.log('网关:', base, '| Key 长度:', key.length)
  const online = await fetch(base + '/healthz').then((r) => r.json()).catch(() => null)
  chk('网关在线（/healthz 可访问）', !!online && online.ok === true, JSON.stringify(online))
  if (!online || online.ok !== true) {
    console.log('\n结果: ' + pass + ' 通过 / ' + fail + ' 失败 —— 网关没在跑, 后面的链路用例无法验证')
    process.exitCode = 1
    return
  }
  chk('至少接入了一家供应商', online.providers > 0, 'providers=' + online.providers)

  // ── 1. auto 非流式 ──
  console.log('\n[1] auto 非流式')
  const a = await post({ model: 'auto', messages: [SAY], max_tokens: TOK })
  chk('HTTP 200', a.status === 200, 'HTTP ' + a.status + ' ' + (a.err || '').slice(0, 160))
  chk('content 非空', !!a.content.trim(), JSON.stringify(a.content).slice(0, 120))
  chk('响应头带 x-request-id（8 位 hex）', RID_RE.test(a.rid), 'rid=' + JSON.stringify(a.rid))

  // ── 2. auto 流式 ──
  console.log('\n[2] auto 流式')
  const s = await postStream({ model: 'auto', messages: [SAY], max_tokens: TOK, stream: true })
  chk('HTTP 200', s.status === 200, 'HTTP ' + s.status + ' ' + (s.err || '').slice(0, 160))
  chk('收到 [DONE] 结束标记', s.sawDone === true, 'chunks=' + s.chunks)
  chk('拼出的 content 非空', !!s.content.trim(), JSON.stringify(s.content).slice(0, 120))
  chk('流式响应也带 x-request-id', RID_RE.test(s.rid), 'rid=' + JSON.stringify(s.rid))

  // ── 3. 指定模型 ──
  console.log('\n[3] 指定模型（不走 auto）')
  const first = (cfg.providers[0].models || [])[0]
  const m = await post({ model: first, messages: [SAY], max_tokens: TOK })
  chk(`HTTP 200（model=${first}）`, m.status === 200, 'HTTP ' + m.status + ' ' + (m.err || '').slice(0, 160))
  chk('content 非空', !!m.content.trim(), JSON.stringify(m.content).slice(0, 120))

  // ── 4. 鉴权不得被绕过 ──
  console.log('\n[4] 鉴权')
  const noKey = await fetch(base + '/v1/chat/completions', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'auto', messages: [SAY] }),
  }).then((r) => r.status).catch(() => 0)
  chk('不带 Key 被拒（401/403）', noKey === 401 || noKey === 403, 'HTTP ' + noKey)
  const bad = await post({ model: 'auto', messages: [SAY] }, { authorization: 'Bearer wrong-key' })
  chk('错误 Key 被拒（401/403）', bad.status === 401 || bad.status === 403, 'HTTP ' + bad.status)
  // 错误响应也要带 request_id —— 用户报障时把它贴出来, 就能直接定位到具体那次调用
  chk('错误响应里带 request_id', RID_RE.test(bad.rid) || /request_id/.test(bad.raw), 'rid=' + JSON.stringify(bad.rid))

  console.log('\n结果: ' + pass + ' 通过 / ' + fail + ' 失败')
  process.exitCode = fail ? 1 : 0
})().catch((e) => { console.error('测试异常:', e && e.stack || e); process.exitCode = 1 })
