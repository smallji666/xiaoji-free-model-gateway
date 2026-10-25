// quota-reload-check.cjs —— 两个"回答用户疑问"的功能的端到端回归:
//   ① 上游配额头采集(recordQuota): 把 `x-ratelimit-*` 记下来, 让界面能回答"今天还剩多少"
//   ② config.json 热重载: 手工改了配置不重启也生效
//
// ⚠ 这两个功能最贵的不是"能不能用", 而是**它们各自会怎么错**, 所以本套件的重点在反断言:
//   ① 配额: 上游没回配额头时**不能**写空对象(否则界面上的额度会一会儿有一会儿没)
//   ② 热重载: **绝不能**把运行时状态(冷却 / 拉黑 / 质量窗口)换成磁盘上那份更旧的快照 ——
//      那等于把防扣费防线重置回出厂状态; 也**绝不能**把手工新增的供应商直接塞进池子 ——
//      那会绕过免费校验闸门, 让未校验的收费模型进池。
//
// 端口 8817/8818 是专属区间(见 run-all.cjs 的端口分配表)。
const { spawn } = require('child_process')
const fs = require('fs')
const path = require('path')
const http = require('http')

const NODE = process.execPath
const HERE = __dirname
const SB = path.join(HERE, 'sb-quota')
const ROOT = (() => { const _fs = require('fs'), _p = require('path'); let d = _p.dirname(__dirname); for (let i = 0; i < 6; i++) { if (_fs.existsSync(_p.join(d, 'server.mjs'))) return d; d = _p.dirname(d) } return _p.join(__dirname, '..') })()
const GW_PORT = 8817
const UP_PORT = 8818
const GW_KEY = 'freegw-quota-test-0000000000000000'
const CFG = path.join(SB, 'config.json')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let pass = 0, fail = 0
let lastResp = ''
const ok = (c, m) => {
  if (c) { pass++; console.log('  PASS  ' + m) }
  else { fail++; console.log('  FAIL  ' + m); if (lastResp) console.log('    ↳ 最近响应: ' + lastResp.replace(/\s+/g, ' ').slice(0, 300)) }
}

// ── 假上游 ──
// 按**请求里的模型名**决定回不回配额头 —— 这样才能测出"没回的时候不能乱写"。
//   q-model   : 回一整套配额头(含 reset 的时长写法 "2m59.56s")
//   noq-model : 一个配额头都不回
// 沙箱供应商的全部模型 —— 假上游的 /models 与配置里的 models 共用这一份, 免得两处漂移。
const MODELS = ['q-model', 'noq-model', 'zero-model', 'tokzero-model', 'noreq-model']
let upHits = 0
const up = http.createServer((req, res) => {
  let body = ''
  req.on('data', (c) => { body += c })
  req.on('end', () => {
    if (req.url.includes('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      // ⚠ 这里**必须回非空列表**: 回空列表会让网关的目录扫描判定"该 Key 看不到任何模型"
      //   (accountIssue kind=no_models), 把整家踢出候选链 —— 一旦触发, 本套件后面的所有调用
      //   都会报 "模型不在可用池里"。原来本套件在启动后 6 秒内就跑完了, 所以一直没暴露;
      //   2026-10-25 加了【三】把总时长推到扫描之后, 当场踩到。
      return res.end(JSON.stringify({ object: 'list', data: MODELS.map((id) => ({ id, object: 'model' })) }))
    }
    upHits++
    const headers = { 'content-type': 'application/json' }
    if (/"model"\s*:\s*"q-model"/.test(body)) {
      headers['x-ratelimit-remaining-requests'] = '42'
      headers['x-ratelimit-limit-requests'] = '100'
      headers['x-ratelimit-reset-requests'] = '2m59.56s'   // 上游回的是**时长**不是秒数
      headers['x-ratelimit-remaining-tokens'] = '5000'
    } else if (/"model"\s*:\s*"zero-model"/.test(body)) {
      // 今天用完了: 剩 0 / 1000
      headers['x-ratelimit-remaining-requests'] = '0'
      headers['x-ratelimit-limit-requests'] = '1000'
    } else if (/"model"\s*:\s*"tokzero-model"/.test(body)) {
      // token 维度用完了, 请求数还很充裕 —— 用来证明两个维度都会看
      headers['x-ratelimit-remaining-requests'] = '900'
      headers['x-ratelimit-limit-requests'] = '1000'
      headers['x-ratelimit-remaining-tokens'] = '0'
      headers['x-ratelimit-limit-tokens'] = '100000'
    } else if (/"model"\s*:\s*"noreq-model"/.test(body)) {
      // 只回"剩几次"、不回上限 —— 分母未知, 不许瞎猜比例
      headers['x-ratelimit-remaining-requests'] = '5'
    }
    res.writeHead(200, headers)
    res.end(JSON.stringify({
      id: 'x', object: 'chat.completion', model: 'm',
      choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }))
  })
})

const procs = []
let gwLog = ''
function launch(args, cwd, label, cap) {
  const p = spawn(NODE, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
  p.stdout.on('data', (d) => { if (cap) gwLog += d })
  p.stderr.on('data', (d) => { if (cap) gwLog += d })
  procs.push(p)
  return p
}
function cleanup() { for (const p of procs) { try { p.kill() } catch {} } }
process.on('exit', cleanup)

function readCfg() { return JSON.parse(fs.readFileSync(CFG, 'utf8')) }
function writeCfg(c) { fs.writeFileSync(CFG, JSON.stringify(c, null, 2)) }

async function state() {
  const r = await fetch(`http://127.0.0.1:${GW_PORT}/api/state`)
  return r.json()
}
async function chat(model) {
  const r = await fetch(`http://127.0.0.1:${GW_PORT}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + GW_KEY },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }] }),
  })
  const text = await r.text()
  lastResp = text
  return { status: r.status, text }
}
// 等一次热重载落地。判据是**状态真的变了**, 不是"等了 N 毫秒" —— 后者在慢机器上必然偶发。
async function waitFor(fn, ms = 6000) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    try { if (await fn()) return true } catch {}
    await sleep(150)
  }
  return false
}

async function main() {
  const now = new Date().toISOString()
  fs.mkdirSync(SB, { recursive: true })
  for (const f of ['config.json.prev', 'config.json.tmp', 'gateway.pid', 'usage_log.json', 'metrics.json', 'free_catalog.json', 'promo_state.json']) {
    try { fs.unlinkSync(path.join(SB, f)) } catch {}
  }
  const base = {
    port: GW_PORT, proxy: '', gatewayKey: GW_KEY, maxConcurrent: 0,
    providers: [{
      id: 'q1', name: 'qco', label: 'QuotaCo', base_url: `http://127.0.0.1:${UP_PORT}/v1`,
      api_key: 'sk-x', keys: ['sk-x'], model: 'q-model', models: MODELS,
      needs_proxy: false, enabled: true, ok: 0, err: 0, cooldownUntil: 0, lastError: '', lastSweepAt: now,
    }],
  }
  writeCfg(base)
  fs.writeFileSync(path.join(SB, '.sandbox'), '')
  // ⚠ hosts 里必须**收录这 5 个模型**: 启动 3 秒后网关会跑一次目录扫描(refreshCatalog),
  //   而 judgeFree 对"没有白名单条目的厂商"只认名字里带 free 的模型 —— 于是这些沙箱模型
  //   会被判收费 -> 全部进 quarantine -> 后面每次调用都报"模型不在可用池里"。
  //   写进白名单(走 whitelist 层判定)才是它们"确实是免费模型"的正常表达。
  fs.writeFileSync(path.join(SB, 'free_whitelist.json'), JSON.stringify({
    list_date: now.slice(0, 10),
    fetched_at: now,
    sources: { local: now.slice(0, 10) },
    hosts: { '127.0.0.1': { source: 'local', models: MODELS } },
  }, null, 2))
  // ⚠ server.mjs 的路径全按 __dirname 解析(不是 cwd) —— 必须放同目录副本, 否则它会去读写生产那套文件。
  fs.copyFileSync(path.join(ROOT, 'server.mjs'), path.join(SB, 'server.mjs'))
  fs.copyFileSync(path.join(ROOT, 'dashboard.html'), path.join(SB, 'dashboard.html'))

  await new Promise((r) => up.listen(UP_PORT, '127.0.0.1', r))
  const gw = launch([path.join(SB, 'server.mjs')], SB, 'gw', true)
  const ready = await waitFor(async () => (await fetch(`http://127.0.0.1:${GW_PORT}/api/state`)).ok, 30000)
  if (!ready) { console.log('  FAIL  网关未在 30s 内就绪'); console.log(gwLog.slice(-800)); process.exit(1) }
  await sleep(1200)

  // ══ 一、上游配额头采集 ══
  console.log('\n【一】上游配额头采集')
  const r1 = await chat('q-model')
  ok(r1.status === 200, `带配额头的一次调用成功（HTTP ${r1.status}）`)
  // ⚠ 判据读**磁盘上的 config.json**而不是 /api/state: 后者是内存投影, 落盘才是"这条记录真的留下来了"。
  const diskQuota = await waitFor(() => { const q = readCfg().providers[0].quota; return q && q.remainreq === 42 }, 5000)
  const q = readCfg().providers[0].quota || {}
  ok(diskQuota, '配额头已落盘（providers[0].quota.remainreq === 42）')
  ok(q.limitreq === 100, 'limit-requests 解析正确（100）')
  ok(q.remaintok === 5000, 'remaining-tokens 解析正确（5000）')
  // 上游回的是 "2m59.56s" —— 必须解析成秒。不解析的话界面上会出现"重置 179.56 秒"这种没人看得懂的东西。
  ok(Math.abs((q.resetreq || 0) - 179.56) < 0.5, `reset 的时长写法已解析成秒（2m59.56s -> ${q.resetreq}s）`)
  ok(typeof q.at === 'string' && Date.now() - new Date(q.at).getTime() < 60000, '记录带上了采集时刻（界面据此判"这份数据有多旧"）')
  const st1 = await state()
  ok(st1.providers[0].quota && st1.providers[0].quota.remainreq === 42, '/api/state 里也能读到配额（仪表盘读的就是它）')

  // ── 反断言: 上游没回配额头时, 不能把上一次的真数据抹掉 ──
  const atBefore = q.at
  await chat('noq-model')
  await sleep(600)
  const after = readCfg().providers[0].quota || {}
  ok(after.remainreq === 42 && after.at === atBefore,
    '上游不回配额头时, 上一次的记录**不被清空/覆盖**（否则界面上的额度会一会儿有一会儿没）')

  // ══ 二、config.json 热重载 ══
  console.log('\n【二】config.json 热重载')
  await sleep(2500)   // 等网关自己的防抖落盘先结束, 免得和我们的手改打架

  // ① 纯配置字段: 改了要生效
  let c = readCfg()
  c.maxConcurrent = 7
  c.aliases = { qalias: 'q-model' }
  writeCfg(c)
  const applied = await waitFor(async () => (await state()).maxConcurrent === 7, 8000)
  ok(applied, '手工改的纯配置字段（maxConcurrent）已热生效')
  ok(/已热重载/.test(gwLog), '日志里明确记了"已热重载"（不是悄悄生效）')
  ok(/aliases/.test(gwLog), '别名表这类"不在仪表盘上的配置"也在热重载范围内')

  // ② 反断言: 运行时状态**绝不能被磁盘上那份旧快照覆盖**
  //    把文件里的运行时字段改成假值 + 同时改一个纯配置字段。改完只该看到纯配置生效。
  c = readCfg()
  c.maxConcurrent = 3
  c.providers[0].ok = 99999
  c.providers[0].cooldownUntil = 9999999999999
  c.providers[0].quota = { remainreq: 1, at: new Date().toISOString() }
  writeCfg(c)
  const applied2 = await waitFor(async () => (await state()).maxConcurrent === 3, 8000)
  ok(applied2, '第二轮热重载仍然生效（maxConcurrent -> 3）')
  const st2 = await state()
  const p0 = st2.providers[0]
  ok(p0.ok !== 99999, '运行时字段 ok **没有被文件里的假值覆盖**（内存值优先）')
  ok(!(p0.cooldownUntil > Date.now()), 'cooldownUntil **没有被文件里的假值覆盖** —— 冷却状态丢了等于防扣费防线重置')
  ok(p0.quota && p0.quota.remainreq === 42, '运行时字段 quota 同样以内存值优先（文件里那个假的 remainreq:1 没生效）')
  // 反过来: 纯配置字段是**要**跟着文件走的, 否则就不是热重载了
  ok(p0.enabled === true, '纯配置字段（enabled）仍按文件为准')

  // ③ 反断言: 手工新增的供应商**不能**被热重载直接塞进池子
  const nBefore = (await state()).providers.length
  c = readCfg()
  c.providers.push({
    id: 'q2', name: 'handwritten', label: 'HandWritten', base_url: `http://127.0.0.1:${UP_PORT}/v1`,
    api_key: 'sk-z', keys: ['sk-z'], model: 'q-model', models: ['q-model'], needs_proxy: false, enabled: true,
  })
  writeCfg(c)
  await sleep(2500)
  const nAfter = (await state()).providers.length
  ok(nAfter === nBefore, '手工新增的供应商**没有**被热重载塞进池子（它必须走免费校验闸门, 见下）')
  ok(/检测到新增供应商/.test(gwLog), '日志明确提示"新增的请重启"（而不是半吊子地放进去）')

  // ④ 自激保护: 网关自己写盘不该触发重载
  const reloadsBefore = (gwLog.match(/已热重载/g) || []).length
  await chat('q-model')            // 一次请求就会让网关写一次 config.json（markOk -> saveConfig）
  await sleep(3000)
  const reloadsAfter = (gwLog.match(/已热重载/g) || []).length
  ok(reloadsAfter === reloadsBefore,
    `网关自己写盘**不会**触发重载（自激保护: 请求前后都是 ${reloadsBefore} 次）—— 否则会形成"写→重载→写"死循环`)

  // ══ 三、上游自报的额度要参与排序 ══
  // 背景: recordQuota 采下来的 p.quota 长期只喂仪表盘("今天还剩多少"), 排序时**完全不用** ——
  // 于是"今天还剩 3 次"的家和"剩 900 次"的家在 load 项上同分, 路由照样把这一轮送过去撞 429。
  // 采了不用等于没采。这里从**排序真正用过的**分项反查(见 pickChain 的 partsW)。
  // ⚠ parts.load 是**加权后**的值(W.load = 0.10), 所以"不降权"对应 0.10、"保底"对应 0.02。
  console.log('\n【三】上游额度参与排序')
  const loadOf = async (model) => {
    const r = await fetch(`http://127.0.0.1:${GW_PORT}/api/route?model=${encodeURIComponent(model)}&n=8`)
    const j = await r.json()
    const t = (j.top || []).find((x) => x.model === model)
    return t ? t.parts.load : null
  }
  const near = (a, b) => a != null && Math.abs(a - b) < 0.005

  await chat('q-model')
  await sleep(400)
  const lNormal = await loadOf('q-model')
  ok(near(lNormal, 0.1), `额度充裕(42/100)不降权（load 分项 ${lNormal} ≈ 0.10）—— 按分钟限流的家长期停在高位, 不能因此吃亏`)

  await chat('zero-model')
  await sleep(400)
  const lZero = await loadOf('zero-model')
  ok(near(lZero, 0.02), `今天用尽(0/1000)被降权（load 分项 ${lZero} ≈ 0.02, 保底 0.2 而不是直接判死）`)
  ok(near(await loadOf('q-model'), 0.02),
    '额度是**供应商级**口径: 同一家换个模型, 该家仍按"已用尽"排序（这是正确的, 配额本来就归整家所有）')

  await chat('tokzero-model')
  await sleep(400)
  const lTok = await loadOf('tokzero-model')
  ok(near(lTok, 0.02), `token 维度用尽也降权（load 分项 ${lTok} ≈ 0.02）—— 请求数还充裕但 token 见底, 一样要让位`)

  await chat('noreq-model')
  await sleep(400)
  const lNoLim = await loadOf('noreq-model')
  ok(near(lNoLim, 0.1), `只回"剩 5 次"、不回上限时不猜比例（load 分项 ${lNoLim} ≈ 0.10）—— 分母未知就编数据比不判断更糟`)

  try { gw.kill() } catch {}
  console.log(`\n  ${pass} 通过 / ${fail} 失败`)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => { console.error(e.stack || e); cleanup(); process.exit(1) })
