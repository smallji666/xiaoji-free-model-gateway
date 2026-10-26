// 协议转换测试台: 假上游(8790) + 被测网关(8788) + 断言
const http = require('http')
const { spawn } = require('child_process')
const fs = require('fs')
const path = require('path')
const NODE = process.execPath
const DIR = __dirname
const GK = 'freegw-test-key-0000000000000000000000'

// ── 1. 写测试配置(单供应商指向假上游, 无需代理) ──
fs.writeFileSync(path.join(DIR, 'config.json'), JSON.stringify({
  port: 8788, proxy: '', gatewayKey: GK,
  providers: [{ id: 'testp', name: 'testp', label: 'TestP', base_url: 'http://127.0.0.1:8790/v1', api_key: 'sk-up', keys: ['sk-up'], model: 'test-model', models: ['test-model', 'tool-model'], needs_proxy: false, enabled: true, ok: 0, err: 0, cooldownUntil: 0, lastError: '' }],
}, null, 2))

// ── 2. 假上游: OpenAI 格式, 支持流式/非流式 ──
const fake = http.createServer((req, res) => {
  let b = ''
  req.on('data', (c) => (b += c))
  req.on('end', () => {
    const p = JSON.parse(b || '{}')
    if (req.url === '/v1/models') {
      res.setHeader('content-type', 'application/json')
      // ⚠ 必须把 config 里声明的两个模型都列出来：启动同步完成后会触发一次目录重扫，
      //   若这里只列 test-model，池子会被重扫结果覆盖成 1 个，"路由组去重"用例就变成
      //   cands2=1 稳定失败（本机网络慢、同步晚到，所以一直是侥幸绿）。
      return res.end(JSON.stringify({ data: [
        { id: 'test-model', pricing: { prompt: '0', completion: '0' } },
        { id: 'tool-model', pricing: { prompt: '0', completion: '0' } },
      ] }))
    }
    // 夹具: 工具调用(2026-10-17 加, 给 /v1/responses 用) —— OpenAI 形态, 网关要把它
    // 翻成 Responses 的独立 output_item(function_call), 而不是塞进 message.content。
    if (p.model === 'tool-model') {
      res.setHeader('content-type', 'application/json')
      return res.end(JSON.stringify({
        id: 'c2', object: 'chat.completion', model: p.model,
        choices: [{ message: { role: 'assistant', content: '', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"北京"}' } }] }, finish_reason: 'tool_calls' }],
        usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
      }))
    }
    if (p.model === 'bad-model') {
      // 模拟"上下文超限"类上游: 流式请求也直接回 400 JSON (2026-09-13 二次事故触发条件)
      res.statusCode = 400
      res.setHeader('content-type', 'application/json')
      return res.end(JSON.stringify({ error: { message: 'Please reduce the length of the messages.' } }))
    }
    // ── 边界夹具(2026-09-19 补): 上游行为异常的五种典型形态 ──
    // ① 200 + 空 body: 过载/内部报错时的常见形态。绝不能当成功转发给客户端。
    if (p.model === 'empty-body') {
      res.setHeader('content-type', 'application/json')
      return res.end('')
    }
    // ② 200 + {error:{...}}: 有些厂商不用 4xx/5xx, 把错误塞在 200 的正文里。
    if (p.model === 'err200') {
      res.setHeader('content-type', 'application/json')
      return res.end(JSON.stringify({ error: { message: 'internal error, please retry' } }))
    }
    // ③ 流式但**不补 [DONE]**: 有些兼容层就是直接关流。
    if (p.model === 'sse-nodone') {
      res.setHeader('content-type', 'text/event-stream')
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '你好' } }] })}\n\n`)
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '世界' } }], finish_reason: 'stop' })}\n\n`)
      return res.end()   // 没有 data: [DONE]
    }
    // ④ 流到一半上游把连接掐了(socket 级断开, 不是优雅结束)。
    if (p.model === 'sse-cut') {
      res.setHeader('content-type', 'text/event-stream')
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '半截' } }] })}\n\n`)
      return setTimeout(() => { try { res.socket.destroy() } catch {} }, 60)
    }
    // ⑤ 超大响应(6MB > readBody 的 4MB 上限): 会被静默截断成非法 JSON, 必须被发现而不是转发。
    if (p.model === 'huge') {
      res.setHeader('content-type', 'application/json')
      return res.end(JSON.stringify({
        id: 'c1', model: p.model,
        choices: [{ message: { role: 'assistant', content: 'x'.repeat(6 * 1024 * 1024) }, finish_reason: 'stop' }],
      }))
    }
    // ⑥ 流式 200 但 SSE 里塞 error(实测 2026-10-05: Kilo 转发的 Nvidia 过载就是这个形态) ——
    //    HTTP 200 + choices:[] + error:{code:503}。以前会被当成功原样透传给客户端,
    //    客户端报错而面板记成功; 现在必须判失败并换下一家(链上只有它 -> 502)。
    if (p.model === 'sse-err200') {
      res.setHeader('content-type', 'text/event-stream')
      res.write(`data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', model: 'nvidia/x', provider: 'Nvidia', choices: [], error: { code: 503, message: 'Upstream error from Nvidia: Service temporarily overloaded', metadata: { error_type: 'provider_overloaded' } } })}\n\n`)
      return res.end()
    }
    // ⑦ 流式"先正常吐几个字、再报错"(2026-10-05 补): 首段体检**看不出问题**(第一个事件是正常 delta),
    //    错误发生在更晚的时刻 —— 与 ⑥ 同一根因、只是更隐蔽。以前整条会被记成成功(客户端报错、面板一片绿)。
    if (p.model === 'sse-err-mid') {
      res.setHeader('content-type', 'text/event-stream')
      res.write(`data: ${JSON.stringify({ id: 'c1', choices: [{ delta: { content: '开头几个字' } }] })}\n\n`)
      return setTimeout(() => {
        res.write(`data: ${JSON.stringify({ choices: [], error: { code: 503, message: 'Upstream error from Nvidia: Service temporarily overloaded' } })}\n\n`)
        res.end()
      }, 50)
    }
    if (p.model === 'ctx413') {
      // ⑧ "请求太大"用 **413** 报错(2026-10-06 补): Groq 的真实措辞就是 413 + `Request too large`,
      //    而 classifyUpstreamError 原来只认 `status === 400` -> 413 掉进 'other'(仅冷却 90s),
      //    下一条大请求立刻再撞一遍。这里复刻真实响应, 用来守住"413 也要归 ctxtoolong + 记容量"。
      res.statusCode = 413
      res.setHeader('content-type', 'application/json')
      return res.end(JSON.stringify({ error: { message: `Request too large for model \`${p.model}\` in organization org-x on tokens per minute (TPM): Limit 8000, Requested 30000` } }))
    }
    if (p.model === 'empty-answer') {
      // ⑨ 200 + 合法 JSON + **回答为空**(2026-10-27 补, 对齐 freellmapi 的 empty-response protection):
      //    过载时确实有厂商回 choices[0].message.content="" 且 finish_reason="stop"。
      //    以前 chatBodyProblem 只要求"能解析出 choices", 于是这种响应被当成功转发:
      //    用户拿到空回答, 网关记 ok:true 且**不换下一家**。
      res.setHeader('content-type', 'application/json')
      return res.end(JSON.stringify({ id: 'c1', model: p.model, choices: [{ message: { role: 'assistant', content: '' }, finish_reason: 'stop' }] }))
    }
    if (p.model === 'empty-answer-length') {
      // ⑨ 的反断言: 同一个空回答, 但 finish_reason="length"(被 max_tokens 截断)。
      //    这是**合法**的空串(模型还没开口就被截了), 判失败会误杀正常模型 -> 必须原样放行。
      res.setHeader('content-type', 'application/json')
      return res.end(JSON.stringify({ id: 'c1', model: p.model, choices: [{ message: { role: 'assistant', content: '' }, finish_reason: 'length' }] }))
    }
    if (p.stream) {
      res.setHeader('content-type', 'text/event-stream')
      res.write(`data: ${JSON.stringify({ id: 'c1', choices: [{ delta: { content: '你好' } }] })}\n\n`)
      res.write(`data: ${JSON.stringify({ id: 'c1', choices: [{ delta: { content: '世界' } }], usage: { total_tokens: 42 } })}\n\n`)
      res.write('data: [DONE]\n\n')
      return res.end()
    }
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ id: 'c1', model: p.model, choices: [{ message: { role: 'assistant', content: '你好世界' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }))
  })
})
fake.listen(8790, '127.0.0.1')

// ── 3. 启动被测网关 ──
// ⚠ 必须先把**当前**的 server.mjs 拷到本目录再启动, 不能用目录里遗留的旧副本 ——
// 本目录曾是 2026-09-13 的一份快照, 直接跑会验到几个月前的老代码, 结论完全是假的。
// 另外 server.mjs 里所有路径(config/白名单/目录/日志)都是按 __dirname 解析的, 不是 cwd,
// 所以副本必须放在本目录, 否则它会去读写生产那套文件。
const SRC = (() => { const _fs = require('fs'), _p = require('path'); let d = _p.dirname(__dirname); for (let i = 0; i < 6; i++) { if (_fs.existsSync(_p.join(d, 'server.mjs'))) return d; d = _p.dirname(d) } return _p.join(__dirname, '..') })()
fs.copyFileSync(path.join(SRC, 'server.mjs'), path.join(DIR, 'server.mjs'))
fs.copyFileSync(path.join(SRC, 'dashboard.html'), path.join(DIR, 'dashboard.html'))
// 白名单预置成"刚同步过", 免得启动时去外网拉(拖慢启动且与协议测试无关)
const NOW = new Date().toISOString()
fs.writeFileSync(path.join(DIR, 'free_whitelist.json'), JSON.stringify({ list_date: NOW.slice(0, 10), fetched_at: NOW, sources: { local: NOW.slice(0, 10) }, hosts: {} }, null, 2))
const gw = spawn(NODE, [path.join(DIR, 'server.mjs')], { stdio: ['ignore', fs.openSync(path.join(DIR, 'gw.log'), 'w'), 'inherit'] })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function post(port, urlPath, headers, body) {
  const r = await fetch(`http://127.0.0.1:${port}${urlPath}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })
  const text = await r.text()
  return { status: r.status, text, json: (() => { try { return JSON.parse(text) } catch { return null } })() }
}
let pass = 0, fail = 0
function check(name, cond, got) {
  if (cond) { pass++; console.log('PASS', name) }
  else { fail++; console.log('FAIL', name, '| got:', String(got).slice(0, 300)) }
}

// ⚠ 不要用固定 sleep 等网关起来: 实测(2026-09-25)本机冷启动要 2.0~2.3s(改动前后一致),
//   而原来写的是 sleep(1500) —— 于是这个测试台**一直是挂的**, 报错还是 ECONNREFUSED,
//   看起来像"网关起不来", 实际只是没等够。改成轮询端口, 起多慢都不会假 FAIL。
async function waitPort(port, ms = 20000) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/healthz`)
      if (r.status < 500) return Date.now() - t0   // 401 也算"起来了"(网关要求 Key)
    } catch {}
    await sleep(100)
  }
  throw new Error(`被测网关 ${port} 在 ${ms}ms 内没起来`)
}
async function main() {
  const up = await waitPort(8788)
  console.log(`被测网关已就绪(用时 ${up}ms)`)
  const A = { authorization: 'Bearer ' + GK }

  // OpenAI 基线
  let r = await post(8788, '/v1/chat/completions', A, { model: 'auto', messages: [{ role: 'user', content: 'hi' }] })
  check('openai non-stream', r.json && r.json.choices && r.json.choices[0].message.content === '你好世界', r.text)

  // OpenAI 流式 SSE (回归 2026-09-13 事故: readable 保活后挂 data 不恢复流动, 流式全部挂死)
  {
    const resp = await fetch('http://127.0.0.1:8788/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json', ...A }, body: JSON.stringify({ model: 'auto', stream: true, messages: [{ role: 'user', content: 'hi' }] }) })
    const t = await resp.text()
    check('openai stream sse', resp.status === 200 && /你好/.test(t) && /世界/.test(t) && /\[DONE\]/.test(t), t)
  }

  // 流式请求 + 上游 400 JSON 错误体 -> 必须快速读错误返回(链上只有 bad-model 时返回 502),
  // 而不是卡死 (回归 2026-09-13 二次事故: readable 保活挂在错误响应上导致 readBody 永不结束)
  {
    const t0 = Date.now()
    const resp = await fetch('http://127.0.0.1:8788/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json', ...A }, body: JSON.stringify({ model: 'testp/bad-model', stream: true, messages: [{ role: 'user', content: 'hi' }] }) })
    const t = await resp.text()
    const ms = Date.now() - t0
    check('stream 400 fast-fail', resp.status === 502 && /all_upstream_failed/.test(t) && /HTTP 400/.test(t) && ms < 8000, `${ms}ms | ${t.slice(0, 200)}`)
  }

  // Anthropic 非流式
  r = await post(8788, '/v1/messages', { ...A, 'anthropic-version': '2023-06-01' }, { model: 'auto', max_tokens: 100, messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] })
  check('anthropic non-stream shape', r.json && r.json.type === 'message' && r.json.content && r.json.content[0].text === '你好世界' && r.json.usage.input_tokens === 10, r.text)

  // Anthropic 流式
  {
    const resp = await fetch('http://127.0.0.1:8788/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json', ...A }, body: JSON.stringify({ model: 'auto', max_tokens: 100, stream: true, messages: [{ role: 'user', content: 'hi' }] }) })
    const t = await resp.text()
    check('anthropic stream events', /event: message_start/.test(t) && /text_delta/.test(t) && /你好/.test(t) && /text_delta/.test(t) && /世界/.test(t) && /event: message_stop/.test(t), t)
  }

  // Anthropic system 转换
  r = await post(8788, '/v1/messages', A, { model: 'auto', max_tokens: 50, system: '你是助手', messages: [{ role: 'user', content: 'hi' }] })
  check('anthropic system string ok', r.json && r.json.content[0].text === '你好世界', r.text)

  // ── 配置快照 / 回滚（2026-10-17 新增）──
  // 这是"没有 git 时的退路"，三段都必须真跑：存 → 能列出来 → 删掉。
  // ⚠ 只用临时名字并在结尾删掉，不碰用户已有快照。
  {
    const nm = 'proto-test-tmp'
    let x = await post(8788, '/api/snapshots', A, { action: 'save', name: nm })
    const saved = !!(x.json && x.json.ok && x.json.name === nm)
    const listed = await (await fetch('http://127.0.0.1:8788/api/snapshots')).json()
    const has = !!(listed && (listed.items || []).some((i) => i.name === nm))
    await post(8788, '/api/snapshots', A, { action: 'delete', name: nm })
    const after = await (await fetch('http://127.0.0.1:8788/api/snapshots')).json()
    const gone = !!(after && !(after.items || []).some((i) => i.name === nm))
    check('配置快照 存/列/删', saved && has && gone, JSON.stringify({ saved, has, gone }))
  }

  // ── 路由组（2026-10-17 新增）──
  // 一个名字 = 一组候选。这里要证的是"组真的收窄了候选集合, 且组名能直接当模型名用",
  // 而不是"配置写进去了" —— 所以关键断言在 /api/route 的 candidates 与真实请求的 200 上。
  {
    const nm = 'proto-grp'
    let x = await post(8788, '/api/groups', A, { name: nm, members: ['testp/test-model', 'testp/tool-model'] })
    const created = !!(x.json && x.json.ok)
    const listed = await (await fetch('http://127.0.0.1:8788/api/groups')).json()
    const has = !!(listed && listed.groups && Array.isArray(listed.groups[nm]))
    // 组必须出现在 /v1/models 里, 否则客户端下拉根本选不到它
    const models = await (await fetch('http://127.0.0.1:8788/v1/models', { headers: A })).json()
    const inModels = !!(models && (models.data || []).some((m) => m.id === nm && m.owned_by === 'xiaoji-group'))
    // 排序侧: 组被认出来 + 候选数正好是成员数(2)
    const route = await (await fetch(`http://127.0.0.1:8788/api/route?model=${nm}`)).json()
    const expanded = !!(route && Array.isArray(route.group) && route.group.length === 2 && route.candidates === 2)
    // 真正发一发: 组名当 model 用, 必须走通; 响应头还要标出"这次用的是组"
    const chatResp = await fetch('http://127.0.0.1:8788/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json', ...A }, body: JSON.stringify({ model: nm, messages: [{ role: 'user', content: 'hi' }] }) })
    const chatBody = await chatResp.json().catch(() => null)
    const works = !!(chatBody && chatBody.choices && chatBody.choices[0].message.content === '你好世界')
    const grpHdr = chatResp.headers.get('x-xiaoji-group') === nm
    // 去重: "厂商/*" 与同厂商的具体模型重叠时只留一份(testp 共 2 个模型, 不能变成 3 个候选)
    await post(8788, '/api/groups', A, { name: nm, members: ['testp/*', 'testp/test-model'] })
    const route2 = await (await fetch(`http://127.0.0.1:8788/api/route?model=${nm}`)).json()
    const dedup = !!(route2 && route2.candidates === 2)
    check('路由组 建/列/进models/展开/可请求/去重', created && has && inModels && expanded && works && grpHdr && dedup,
      JSON.stringify({ created, has, inModels, expanded, works, grpHdr, dedup, cands: route && route.candidates, cands2: route2 && route2.candidates }))

    // 校验必须"配错就报错": auto 成员 / 嵌套组 / 组名撞别名, 三种都要 400
    const badAuto = await post(8788, '/api/groups', A, { name: 'proto-grp2', members: ['auto'] })
    const badNest = await post(8788, '/api/groups', A, { name: 'proto-grp2', members: [nm] })
    await post(8788, '/api/aliases', A, { name: 'proto-al', target: 'auto' })
    const badClash = await post(8788, '/api/groups', A, { name: 'proto-al', members: ['testp/test-model'] })
    const badAliasClash = await post(8788, '/api/aliases', A, { name: nm, target: 'auto' })
    check('路由组 拒绝 auto/嵌套/撞别名', badAuto.status === 400 && badNest.status === 400 && badClash.status === 400 && badAliasClash.status === 400,
      JSON.stringify({ auto: badAuto.status, nest: badNest.status, clash: badClash.status, aliasClash: badAliasClash.status }))

    // 别名指向组: 各解析一层, 应当天然可用(alias -> group -> 成员)
    await post(8788, '/api/aliases', A, { name: 'proto-al', target: nm })
    const viaAlias = await (await fetch('http://127.0.0.1:8788/api/route?model=proto-al')).json()
    check('别名指向路由组', !!(viaAlias && Array.isArray(viaAlias.group) && viaAlias.candidates === 2), JSON.stringify(viaAlias && { g: viaAlias.group, c: viaAlias.candidates }))

    // 收尾: 删干净, 别把临时配置留在测试目录
    await post(8788, '/api/aliases', A, { name: 'proto-al', target: '' })
    await post(8788, '/api/groups', A, { name: nm, members: [] })
    const after = await (await fetch('http://127.0.0.1:8788/api/groups')).json()
    const gone = !!(after && after.groups && !after.groups[nm])
    check('路由组 删除后不再展开', gone, JSON.stringify(after))
  }

  // ── OpenAI Responses (/v1/responses, 2026-10-17 新增) ──
  // 为什么值得单独测: Codex CLI 只认这个协议, 而它以前直接回 501。
  // 三件事必须成立 —— 形状对(object/status/output)、文本进 output_text、流式事件名对。
  r = await post(8788, '/v1/responses', A, { model: 'auto', input: 'hi' })
  check('responses non-stream shape', r.json && r.json.object === 'response' && r.json.status === 'completed'
    && r.json.output && r.json.output[0] && r.json.output[0].content[0].text === '你好世界'
    && r.json.output_text === '你好世界' && r.json.usage && r.json.usage.output_tokens > 0, r.text)

  {
    const resp = await fetch('http://127.0.0.1:8788/v1/responses', { method: 'POST', headers: { 'content-type': 'application/json', ...A }, body: JSON.stringify({ model: 'auto', input: 'hi', stream: true }) })
    const t = await resp.text()
    check('responses stream sse', resp.status === 200 && /response\.created/.test(t) && /response\.output_text\.delta/.test(t)
      && /你好/.test(t) && /response\.completed/.test(t) && /"status":"completed"/.test(t), t.slice(0, 400))
  }

  // 工具调用必须翻成**独立的 output_item**, 不是 message 里的 content block
  r = await post(8788, '/v1/responses', A, { model: 'testp/tool-model', input: '北京天气' })
  check('responses tool_call 是独立 output_item', r.json && Array.isArray(r.json.output)
    && r.json.output.some((o) => o.type === 'function_call' && o.name === 'get_weather' && /北京/.test(o.arguments)), r.text)

  // 数组形态的 input + instructions(Codex 实际发的是这种)
  r = await post(8788, '/v1/responses', A, {
    model: 'auto', instructions: '你是助手',
    input: [{ role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
  })
  check('responses 数组 input + instructions', r.json && r.json.output_text === '你好世界', r.text)

  // Gemini 非流式
  r = await post(8788, '/v1beta/models/auto:generateContent', { 'x-goog-api-key': GK }, { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] })
  check('gemini non-stream shape', r.json && r.json.candidates && r.json.candidates[0].content.parts[0].text === '你好世界' && r.json.usageMetadata.totalTokenCount === 15, r.text)

  // Gemini 流式
  {
    const resp = await fetch('http://127.0.0.1:8788/v1beta/models/auto:streamGenerateContent?key=' + GK, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ contents: [{ parts: [{ text: 'hi' }] }] }) })
    const t = await resp.text()
    check('gemini stream sse', /candidates/.test(t) && /你好/.test(t) && /世界/.test(t), t)
  }

  // Ollama chat 非流式
  r = await post(8788, '/api/chat', { authorization: 'Bearer ' + GK }, { model: 'auto', stream: false, messages: [{ role: 'user', content: 'hi' }] })
  check('ollama chat non-stream', r.json && r.json.message && r.json.message.content === '你好世界' && r.json.done === true, r.text)

  // Ollama chat 流式 NDJSON
  {
    const resp = await fetch('http://127.0.0.1:8788/api/chat', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + GK }, body: JSON.stringify({ model: 'auto', messages: [{ role: 'user', content: 'hi' }] }) })
    const t = await resp.text()
    const lines = t.trim().split('\n').map((l) => JSON.parse(l))
    check('ollama stream ndjson', lines.length >= 3 && lines.some((l) => l.message && l.message.content === '你好') && lines[lines.length - 1].done === true, t)
  }

  // Ollama generate
  r = await post(8788, '/api/generate', { authorization: 'Bearer ' + GK }, { model: 'auto', prompt: 'hi', stream: false })
  check('ollama generate', r.json && r.json.response === '你好世界' && r.json.done === true, r.text)

  // Ollama tags
  r = await post(8788, '/api/tags', A, {}) // GET via post helper won't work; do manual
  {
    const resp = await fetch('http://127.0.0.1:8788/api/tags', { headers: A })
    const j = await resp.json()
    check('ollama tags', j.models && j.models.some((m) => m.model === 'auto') && j.models.some((m) => m.model === 'testp/test-model'), JSON.stringify(j))
  }

  // count_tokens
  r = await post(8788, '/v1/messages/count_tokens', A, { messages: [{ role: 'user', content: 'hello world this is a test' }] })
  check('count_tokens', r.json && r.json.input_tokens > 0, r.text)

  // 鉴权拒绝
  r = await post(8788, '/v1/messages', { authorization: 'Bearer wrong' }, { model: 'auto', max_tokens: 10, messages: [] })
  check('auth 401', r.status === 401, r.text)
  r = await post(8788, '/api/chat', {}, { model: 'auto', messages: [] })
  check('ollama auth 401', r.status === 401, r.text)

  // ── 边界: 上游行为异常的五种形态 ──
  // 刻意放在最后: 这些用例会让被测供应商吃到模型级冷却(见 markFail), 不打扰上面的正常路径。
  console.log('-- 边界用例 --')
  const H = { 'content-type': 'application/json', ...A }
  const ask = async (model, extra) => {
    const t0 = Date.now()
    const resp = await fetch('http://127.0.0.1:8788/v1/chat/completions', {
      method: 'POST', headers: H, body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }], ...(extra || {}) }),
    })
    return { status: resp.status, text: await resp.text(), ms: Date.now() - t0 }
  }

  // ① 上游 200 + 空 body: 以前会被原样转发并记成功 —— 用户拿到空回答, 面板一片绿
  {
    const g = await ask('testp/empty-body')
    check('上游 200 空 body -> 502 且说明原因', g.status === 502 && /all_upstream_failed/.test(g.text) && /响应体为空/.test(g.text) && g.ms < 8000, `${g.ms}ms | ${g.text.slice(0, 220)}`)
  }
  // ② 上游 200 但正文是错误对象(有些厂商不用 4xx/5xx)
  {
    const g = await ask('testp/err200')
    check('上游 200 包着 error 体 -> 502', g.status === 502 && /错误对象/.test(g.text), `${g.ms}ms | ${g.text.slice(0, 220)}`)
  }
  // ②b 上游 200 + 合法 JSON 但**回答为空**(finish_reason=stop): 与前两条同族, 必须判失败换下一家
  {
    const g = await ask('testp/empty-answer')
    check('上游 200 空回答(finish_reason=stop) -> 502', g.status === 502 && /回答为空/.test(g.text), `${g.ms}ms | ${g.text.slice(0, 220)}`)
  }
  // ②c 反断言: 同样空回答但 finish_reason=length 是**合法**的(max_tokens 太小), 不能被误杀
  {
    const g = await ask('testp/empty-answer-length')
    check('空回答但 finish_reason=length 仍放行(不误杀)', g.status === 200 && !/回答为空/.test(g.text), `${g.ms}ms | ${g.text.slice(0, 220)}`)
  }
  // ③ 流式但不补 [DONE]: 内容照常送达, 不能因为缺结束标记就丢内容或挂死
  {
    const g = await ask('testp/sse-nodone', { stream: true })
    check('流式缺 [DONE] 仍把内容送达且不挂死', g.status === 200 && /你好/.test(g.text) && /世界/.test(g.text) && g.ms < 8000, `${g.ms}ms | ${g.text.slice(0, 220)}`)
  }
  // ④ 上游流到一半掐断连接: 客户端必须收到"流结束"而不是无限干等, 已收到的部分要保留
  {
    const g = await ask('testp/sse-cut', { stream: true })
    check('上游中途断开 -> 不挂死且保留已收到的内容', g.ms < 8000 && /半截/.test(g.text), `${g.ms}ms | ${g.text.slice(0, 220)}`)
  }
  // ⑤ 超大响应(6MB > readBody 的 4MB 上限): 截断后是非法 JSON, 必须被发现, 不能转发半截
  {
    const g = await ask('testp/huge')
    check('超大响应被 4MB 上限截断 -> 502 而不是转发半截 JSON', g.status === 502 && /截断/.test(g.text) && g.ms < 25000, `${g.ms}ms | ${g.text.slice(0, 220)}`)
  }
  // ⑥ 流式 200 + SSE 里塞 error(回归 2026-10-05: Kilo→Nvidia 过载被当成功透传)
  //    判据: 不能是"200 把错误流转发给客户端", 必须判失败; 链上只有它 -> 502 且说明原因。
  {
    const g = await ask('testp/sse-err200', { stream: true })
    check('流式 200 但 SSE 里是 error -> 判失败换下一家(不是透传)',
      g.status === 502 && /all_upstream_failed/.test(g.text) && /流式响应是错误/.test(g.text) && !/Service temporarily overloaded.*choices/s.test(g.text) && g.ms < 8000,
      `${g.ms}ms | ${g.text.slice(0, 260)}`)
  }
  // ⑦ 流式中途才报错(首段正常): 客户端已经拿到开头了, 没法再换家 —— 但**统计与学习必须正确**:
  //    usage_log 要记 ok:false(而不是 ok:true), 并且该模型要吃一次冷却(下条请求别再撞它)。
  {
    const g = await ask('testp/sse-err-mid', { stream: true })
    await sleep(1500)   // usage_log 有 1200ms 写盘防抖(见 saveUsage), 等它落盘再读
    let usage = [], cfg = {}
    try { usage = JSON.parse(fs.readFileSync(path.join(DIR, 'usage_log.json'), 'utf8')) } catch {}
    try { cfg = JSON.parse(fs.readFileSync(path.join(DIR, 'config.json'), 'utf8')) } catch {}
    const rec = Array.isArray(usage) ? usage.find((r) => r && r.model === 'sse-err-mid') : null
    const prov = (cfg.providers || [])[0] || {}
    const cooled = !!((prov.modelCooldown || {})['sse-err-mid'])
    check('流式中途报错 -> 记失败(不是 ok:true) 且冷却该模型',
      g.status === 200 && /开头几个字/.test(g.text) && !!rec && rec.ok === false && /overloaded/i.test(rec.reason || '') && cooled,
      `status=${g.status} rec=${JSON.stringify(rec)} cooled=${cooled}`)
  }

  // ⑧ "请求太大" -> 归 ctxtoolong 且**记住当时的请求规模**(2026-10-06)
  //    背景: 10-05 真实数据里 4 次失败有 2 次是 `groq/openai/gpt-oss-120b` 的 413,
  //    每次都要白等一个完整往返才换下一家。容量记忆让之后**同样规模**的请求直接跳过它。
  //    这里断言的是"记录"这一步(端到端); "跳过"的判据由 modelCtxTooBig 的纯函数测试守着。
  {
    const big = 'x'.repeat(60000)
    const g = await ask('testp/ctx413', { messages: [{ role: 'user', content: big }] })
    await sleep(1500)   // 同上: 等 config 写盘
    let cfg = {}
    try { cfg = JSON.parse(fs.readFileSync(path.join(DIR, 'config.json'), 'utf8')) } catch {}
    const prov = (cfg.providers || [])[0] || {}
    const lim = (prov.ctxLimit || {})['ctx413']
    check('413 请求过大 -> 记进 ctxLimit(容量记忆) 且规模被记下',
      g.status === 502 && /413/.test(g.text) && !!lim && lim.chars >= 60000,
      `status=${g.status} lim=${JSON.stringify(lim)} text=${g.text.slice(0, 200)}`)
  }

  // ⑧b 容量判据(纯函数): 只挡"本次规模 >= 记录规模 × 0.8"的请求 —— 留 20% 余量, 免得卡在
  //     临界值上反复横跳(打一次→跳过→又打); 小请求**必须照常去试它**, 没有记录更不能跳。
  //     从源码里抽函数来跑, 而不是重写一遍判据 —— 重写就等于测了个假的(和实现分叉也不报错)。
  {
    const src = fs.readFileSync(path.join(DIR, 'server.mjs'), 'utf8')
    const fnSrc = src.match(/const CTX_LIMIT_TTL_MS[\s\S]*?function modelCtxTooBig[\s\S]*?\n}/)[0]
    const tooBig = new Function(fnSrc + '\nreturn modelCtxTooBig;')()
    const P = { ctxLimit: { m: { at: new Date().toISOString(), chars: 50000 } } }
    check('容量判据: 同规模跳过 · 小请求照试 · 无记录不跳 · 过期自愈',
      tooBig(P, 'm', 60000) === true && tooBig(P, 'm', 40000) === true &&
      tooBig(P, 'm', 39999) === false && tooBig({}, 'm', 99999) === false &&
      tooBig({ ctxLimit: { m: { at: new Date(Date.now() - 31 * 86400000).toISOString(), chars: 50000 } } }, 'm', 99999) === false,
      `60k=${tooBig(P, 'm', 60000)} 40k=${tooBig(P, 'm', 40000)} 39.9k=${tooBig(P, 'm', 39999)} 无记录=${tooBig({}, 'm', 99999)}`)
  }

  // ⑧c 停更熔断(纯函数 + 接线): 源自己声明的清单日期超过 SOURCE_STALE_DAYS 就该整源不合并。
  //     起因: awesomefree 停在 2026-08-21 却一直挂着, 把 `gemini-2.5-pro`(已收费)当免费、
  //     把 5 个早已下架的 OpenRouter 模型留在名单里 —— "拉得到"不等于"它是新的"。
  //     判据同样从源码抽, 不重写: 重写一份等于测了个假的。
  {
    const src = fs.readFileSync(path.join(DIR, 'server.mjs'), 'utf8')
    const constSrc = (src.match(/const SOURCE_STALE_DAYS = \d+/) || [])[0] || ''
    const fnSrc = (src.match(/function sourceStaleDays[\s\S]*?\n}/) || [])[0] || ''
    check('停更熔断: 判据函数可从源码抽出', !!constSrc && !!fnSrc, `const=${constSrc} fn=${fnSrc ? 'ok' : 'MISSING'}`)
    if (constSrc && fnSrc) {
      const M = new Function(constSrc + '\n' + fnSrc + '\nreturn { SOURCE_STALE_DAYS, sourceStaleDays };')()
      const now = Date.parse('2026-10-06T12:00:00Z')   // 固定"现在", 别让用例随真实时间漂移
      const d = (s) => M.sourceStaleDays(s, now)
      check('停更熔断: 46 天前=停更 · 今天=不停更 · 14 天=不停更(边界) · 15 天=停更 · 空/乱码=不停更',
        M.SOURCE_STALE_DAYS === 14 &&
        d('2026-08-21') === 46 && d('2026-10-06') === 0 &&
        d('2026-09-22') === 14 && d('2026-09-21') === 15 &&
        d('') === 0 && d('v2.1') === 0 && d(null) === 0,
        `SD=${M.SOURCE_STALE_DAYS} 08-21=${d('2026-08-21')} 10-06=${d('2026-10-06')} 09-22=${d('2026-09-22')} 09-21=${d('2026-09-21')} 空=${d('')} 乱码=${d('v2.1')}`)
    }
    // 接线断言: 熔断必须真的在合并循环里"跳过本轮", 而不只是算了个数摆着
    check('停更熔断: 已接进同步循环(过期即 continue, 不参与合并)',
      /sourceStaleDays\(_sd\)/.test(src) && /_ageDays > SOURCE_STALE_DAYS/.test(src) && /本轮不参与合并/.test(src),
      `调用=${/sourceStaleDays\(_sd\)/.test(src)} 比较=${/_ageDays > SOURCE_STALE_DAYS/.test(src)} 文案=${/本轮不参与合并/.test(src)}`)
  }

  console.log(`\n== ${pass} passed, ${fail} failed ==`)
  gw.kill(); fake.close(); process.exit(fail ? 1 : 0)
}
main().catch((e) => { console.error('HARNESS ERROR', e); gw.kill(); process.exit(1) })
