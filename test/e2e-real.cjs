// 真实上游端到端验证: 四种协议入口(Anthropic / Gemini / Ollama / OpenAI)各发一条最小请求。
// 与 e2e-check 的分工: e2e-check 走 OpenAI 兼容入口验鉴权/请求 ID/流式; 这里专门验**协议转换**。
//
// ⚠ 2026-09-19 去硬编码。此前写死了 `C:\Users\<用户名>\...\config.json`、端口 8787 和模型
//   `groq/openai/gpt-oss-20b` —— 换机器/换目录直接跑不起来, 而且池里一旦没有那个模型,
//   六条用例会整片失败, 看起来像协议转换坏了。现在:
//     · 路径按 __dirname 解析, 端口取 config.json
//     · 被测模型从 /v1/models 现场挑(优先 groq 的小模型, 快且稳), 挑不到才退回 auto
//
// 依赖: 线上网关已在跑, 且上游可达(需要代理的厂商要先把代理开着)。
// 用法：node test/e2e-real.cjs
const fs = require('node:fs')
const path = require('node:path')

const cfg = JSON.parse(fs.readFileSync(path.join((() => { const _fs = require('fs'), _p = require('path'); let d = _p.dirname(__dirname); for (let i = 0; i < 6; i++) { if (_fs.existsSync(_p.join(d, 'server.mjs'))) return d; d = _p.dirname(d) } return _p.join(__dirname, '..') })(), 'config.json'), 'utf8'))
const GK = cfg.gatewayKey
const B = 'http://127.0.0.1:' + (cfg.port || 8787)

// max_tokens 给 64 而不是 16: 思考型模型会把预算耗在 reasoning 上, 预算太小时
// gemini 的 candidates[0].content 可能整个缺失 —— 那是预算问题, 不是协议转换坏了。
const TOK = 64
const ASK = 'Reply with exactly: OK'

let pass = 0, fail = 0
async function t(name, url, headers, body, check) {
  try {
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(90000) })
    const text = await r.text()
    let ok = false, why = ''
    if (r.status !== 200) why = 'HTTP ' + r.status
    else { try { ok = !!check(text) } catch (e) { why = '解析失败: ' + e.message } }
    if (ok) { pass++; console.log('  PASS  ' + name + ' | HTTP ' + r.status) }
    else { fail++; console.log('  FAIL  ' + name + ' | ' + (why || 'HTTP ' + r.status) + ' | ' + text.slice(0, 160).replace(/\s+/g, ' ')) }
    return ok
  } catch (e) { fail++; console.log('  FAIL  ' + name + ' | ' + e.message); return false }
}

async function main() {
  const online = await fetch(B + '/healthz').then((r) => r.json()).catch(() => null)
  if (!online || online.ok !== true) { console.log('网关未在运行 (' + B + ')，测试中止'); process.exitCode = 1; return }
  console.log('网关:', B, '| 供应商:', online.providers)

  // 现场挑一个池里真实存在的模型 —— 写死模型名是这类脚本最常见的腐坏方式
  const list = await fetch(B + '/v1/models', { headers: { authorization: 'Bearer ' + GK } }).then((r) => r.json()).catch(() => null)
  const ids = ((list && list.data) || []).map((x) => x && x.id).filter((x) => x && x !== 'auto')
  const M = ids.find((x) => /gpt-oss/i.test(x)) || ids[0] || 'auto'
  console.log('被测模型:', M, '(池内共 ' + ids.length + ' 条)', '\n')

  console.log('[Anthropic 协议]')
  await t('anthropic /v1/messages', B + '/v1/messages', { 'x-api-key': GK, 'anthropic-version': '2023-06-01' },
    { model: M, max_tokens: TOK, messages: [{ role: 'user', content: ASK }] },
    (s) => { const j = JSON.parse(s); return j.type === 'message' && Array.isArray(j.content) })
  await t('anthropic stream', B + '/v1/messages', { 'x-api-key': GK },
    { model: M, max_tokens: TOK, stream: true, messages: [{ role: 'user', content: ASK }] },
    (s) => /event: message_start/.test(s) && /event: message_stop/.test(s))

  console.log('\n[Gemini 协议]')
  await t('gemini generateContent', B + '/v1beta/models/' + encodeURIComponent(M) + ':generateContent', { 'x-goog-api-key': GK },
    { contents: [{ parts: [{ text: ASK }] }] },
    (s) => { const j = JSON.parse(s); const c = j.candidates && j.candidates[0]; return !!c && (!!c.content || !!c.finishReason) })

  console.log('\n[Ollama 协议]')
  await t('ollama /api/chat', B + '/api/chat', { authorization: 'Bearer ' + GK },
    { model: M, stream: false, messages: [{ role: 'user', content: ASK }] },
    (s) => { const j = JSON.parse(s); return j.done === true })
  {
    const r = await fetch(B + '/api/tags', { headers: { authorization: 'Bearer ' + GK } })
    const j = await r.json().catch(() => ({}))
    const ok = r.status === 200 && Array.isArray(j.models) && j.models.some((m) => m.model === 'auto')
    if (ok) { pass++; console.log('  PASS  ollama /api/tags | HTTP ' + r.status) }
    else { fail++; console.log('  FAIL  ollama /api/tags | HTTP ' + r.status + ' | ' + JSON.stringify(j).slice(0, 160)) }
  }

  console.log('\n[鉴权]')
  {
    const r = await fetch(B + '/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'wrong-key' }, body: JSON.stringify({ model: 'auto', max_tokens: 8, messages: [] }) })
    if (r.status === 401) { pass++; console.log('  PASS  auth reject | HTTP ' + r.status) }
    else { fail++; console.log('  FAIL  auth reject | HTTP ' + r.status + '（应为 401）') }
  }

  console.log('\n结果: ' + pass + ' 通过 / ' + fail + ' 失败')
  process.exitCode = fail ? 1 : 0
}
main().catch((e) => { console.error('测试异常:', e && e.stack || e); process.exitCode = 1 })
