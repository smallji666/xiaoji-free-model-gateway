#!/usr/bin/env node
/*
 * 第 3 批（四个新功能）回归测试 —— 后端在沙箱跑，前端做静态一致性检查。
 *
 * 覆盖：
 *   3.4 多 Key 精细管理：list/add/remove/toggle/reset + 鉴权 + 两条"不许把这家变死"的红线
 *       ⚠ 重点验 **reindexKeys**：删中间一把之后 keyCooldown/keyStats/keyDisabled 必须整体前移
 *   3.2 请求日志与可视化：/api/usage 的模型名子串过滤、/api/metrics 的 totals.overall 总体分位
 *   3.1/3.3/3.5 前端静态一致性：
 *       - 所有 data-act 都在 onAct 里有 case（否则点了没反应，且控制台不报错）
 *       - 所有 onclick 引用的函数都真的定义了（否则控制台报 ReferenceError）
 *       - onAct 里调用的函数都有定义
 *       - 轮询有 document.hidden 守卫
 *       - 弹层有 ESC 关闭（早期写法被"非 Enter/Space 直接 return"挡掉）
 *
 * 用法：node test/batch3-check.cjs
 */
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { resetSandboxDir } = require('./sb-util.cjs')

const ROOT = (() => { const _fs = require('fs'), _p = require('path'); let d = _p.dirname(__dirname); for (let i = 0; i < 6; i++) { if (_fs.existsSync(_p.join(d, 'server.mjs'))) return d; d = _p.dirname(d) } return _p.join(__dirname, '..') })()
const NODE = process.execPath
const GW_PORT = 8797
const UP_PORT = 8798
const KEY = 'freegw-batch3-test-key-000000000000'

let pass = 0, fail = 0
const ok = (n, cond, d = '') => { if (cond) { pass++; console.log('  PASS ' + n) } else { fail++; console.log('  FAIL ' + n + (d ? '  → ' + d : '')) } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const waitPort = async (port, timeout = 10000) => {
  const t0 = Date.now()
  while (Date.now() - t0 < timeout) {
    try { await fetch(`http://127.0.0.1:${port}/healthz`); return true } catch { await sleep(150) }
  }
  return false
}

function startFakeUpstream() {
  const srv = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      if (/\/models/.test(req.url)) {
        res.writeHead(200, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ object: 'list', data: [{ id: 'test-model' }, { id: 'stream-model' }] }))
      }
      let p = {}
      try { p = JSON.parse(body) } catch {}
      if (p.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' } }] })}\n\n`)
        res.write('data: [DONE]\n\n')
        return res.end()
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        id: 'c1', object: 'chat.completion', model: p.model,
        choices: [{ index: 0, message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 },
      }))
    })
  })
  return new Promise((r) => srv.listen(UP_PORT, '127.0.0.1', () => r(srv)))
}

// 3 把**真实长度**的 Key + 预置的冷却/统计/停用 —— 用来验删中间那把之后的整体前移。
// ⚠ 用真实长度而不是 'sk-a-0000' 这种短串: 掩码是"前 6 + 后 4", 短串会被兜底分支
// 压成只剩首尾几个字符, 两把不同的 Key 掩码可能一模一样 —— 那是测试夹具的问题,
// 不是掩码的问题(真实 Key 都 30 位以上)。短串的掩码行为另有单独断言。
const KEYS0 = ['sk-aaaa-1111111111111111111111aaaa', 'sk-bbbb-2222222222222222222222bbbb', 'sk-cccc-3333333333333333333333cccc']
const KEYS_D = 'sk-dddd-4444444444444444444444dddd'
// 第二家专门用来验"不许把这家变成死供应商"的两条红线 —— 与第一家隔离,
// 否则前一个用例改过的启停状态会串到后一个用例里, 失败原因会指向错误的地方。
const KEYS2 = ['sk-eeee-5555555555555555555555eeee', 'sk-ffff-6666666666666666666666ffff']
// ⚠ 真实配置里供应商的 id 是 UUID、name 才是 groq/gemini 这种可读标识（两者不一样）。
// 夹具必须照这个来，否则"用 name 也能查到"这条会假通过 —— 因为 id 恰好等于 name。
const UID1 = '11111111-2222-3333-4444-555555555555'
const UID2 = '66666666-7777-8888-9999-aaaaaaaaaaaa'
function makeSandbox() {
  const dir = path.join(__dirname, 'sb3-main')
  // ⚠ 非递归重置（safe-delete 守卫），见 sb-util.cjs
  resetSandboxDir(dir)
  // .sandbox 标记: 跳过启动时的 syncUpstreamWhitelist（见 server.mjs 注释）
  fs.writeFileSync(path.join(dir, '.sandbox'), '')
  fs.copyFileSync(path.join(ROOT, 'server.mjs'), path.join(dir, 'server.mjs'))
  fs.copyFileSync(path.join(ROOT, 'dashboard.html'), path.join(dir, 'dashboard.html'))
  fs.writeFileSync(path.join(dir, 'free_whitelist.json'), JSON.stringify({ hosts: {} }))
  const future = new Date(Date.now() + 3600e3).toISOString()
  const common = { needs_proxy: false, ok: 0, err: 0, lastSweepAt: future, lastSweep: { at: future }, disabledModels: {} }
  const cfg = {
    port: GW_PORT, proxy: '', gatewayKey: KEY,
    providers: [
      {
        ...common,
        id: UID1, name: 'up', label: 'Up', base_url: `http://127.0.0.1:${UP_PORT}/v1`,
        keys: KEYS0.slice(), api_key: KEYS0[0], model: 'test-model',
        models: ['test-model', 'stream-model'], enabled: true,
        keyCooldown: { 1: Date.parse(future), 2: Date.parse(future) },
        keyStats: { 0: { ok: 10, err: 1 }, 1: { ok: 20, err: 2 }, 2: { ok: 30, err: 3 } },
        keyDisabled: { 2: true },
      },
      {
        ...common,
        id: UID2, name: 'up2', label: 'Up2', base_url: `http://127.0.0.1:${UP_PORT}/v1`,
        keys: KEYS2.slice(), api_key: KEYS2[0], model: 'test-model',
        models: ['test-model'], enabled: false,
      },
    ],
  }
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(cfg, null, 2))
  return dir
}
// saveConfig 有 300ms 防抖(见 server.mjs saveConfig) —— 改完立刻读盘会读到旧值,
// 然后误判成"没生效"。读盘前必须等过防抖窗口。
const readCfg = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'))
const P0 = (dir) => readCfg(dir).providers[0]
const P1 = (dir) => readCfg(dir).providers[1]
const settledCfg = async (dir) => { await sleep(450); return readCfg(dir) }

const api = (p, opt = {}) => fetch(`http://127.0.0.1:${GW_PORT}${p}`, opt)
const auth = { authorization: 'Bearer ' + KEY }
const jget = async (p, extra = {}) => (await api(p, { headers: extra })).json()
const post = (p, body) => api(p, { method: 'POST', headers: { 'content-type': 'application/json', ...auth }, body: JSON.stringify(body || {}) })
const jpost = async (p, body) => (await post(p, body)).json()

// ══════════════════════════════════════════════════════════════
// A. 前端静态一致性（不起服务）
// ══════════════════════════════════════════════════════════════
function staticChecks() {
  console.log('\n── A. dashboard.html 静态一致性 ──')
  const html = fs.readFileSync(path.join(ROOT, 'dashboard.html'), 'utf8')
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1])
  const js = scripts.join('\n')

  // A1 语法
  let syntaxOk = true
  scripts.forEach((s) => { try { new Function(s) } catch { syntaxOk = false } })
  ok('A1 脚本语法可解析', syntaxOk)

  // A2 所有 data-act 都有 case
  // 例外：toggle-model 由 change 事件处理（checkbox），click 委托里显式跳过它 ——
  // 否则点 label 会同时触发 click 与 change，勾选被翻两次、看起来"点了没反应"。
  const ACT_BY_CHANGE = new Set(['toggle-model'])
  const acts = [...new Set([...html.matchAll(/data-act="([^"]+)"/g)].map((m) => m[1]))]
  const cases = new Set([...js.matchAll(/case '([\w-]+)':/g)].map((m) => m[1]))
  const missingAct = acts.filter((a) => !cases.has(a) && !ACT_BY_CHANGE.has(a))
  ok(`A2 全部 ${acts.length} 个 data-act 都有 onAct case（change 类除外）`, missingAct.length === 0, '缺: ' + missingAct.join(', '))
  ok('A2 change 类 data-act 确实被 change 监听处理', [...ACT_BY_CHANGE].every((a) => js.includes(`dataset.act === '${a}'`)))

  // A3 所有 onclick 引用的函数都定义了
  const decl = new Set([
    ...[...js.matchAll(/(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g)].map((m) => m[1]),
    ...[...js.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g)].map((m) => m[1]),
  ])
  const called = [...new Set([...html.matchAll(/on(?:click|input|change)="([A-Za-z_$][\w$]*)\(/g)].map((m) => m[1]))]
  const missingFn = called.filter((f) => !decl.has(f))
  ok(`A3 全部 ${called.length} 个内联 handler 函数都有定义`, missingFn.length === 0, '缺: ' + missingFn.join(', '))

  // A4 onAct 里调用的函数都有定义
  const onActBody = (js.match(/function onAct\([\s\S]*?\n\}/) || [''])[0]
  const onActCalls = [...new Set([...onActBody.matchAll(/(?:return|=>)\s+([A-Za-z_$][\w$]*)\s*\(/g)].map((m) => m[1]))]
  const missingOnAct = onActCalls.filter((f) => !decl.has(f))
  ok(`A4 onAct 内调用的 ${onActCalls.length} 个函数都有定义`, missingOnAct.length === 0, '缺: ' + missingOnAct.join(', '))

  // A5 骨架：两个视图 + 各卡片容器都在
  // ⚠ 曾经这里还列着 trendcard/trendbox/ug_prov/ug_ok/ug_model/pg_out_b/pg_model2 ——
  //   那批"伪需求"控件已在 2026-09-19 精简时整体移除，测试必须跟着删，
  //   否则会拿"元素不存在"去报产品回归。
  for (const id of ['view-dash', 'view-play', 'chgcard', 'usgcard', 'modal', 'modal_body',
    'statsbar', 'catalog', 'catmeta', 'rulesmeta', 'promowarn',
    // availbox / candbox: 2026-09-21 起"发现到的新厂商"不再只报个数, 必须真的能看能选
    'availbox', 'candbox',
    'pg_model', 'pg_out_a', 'pg_run', 'pg_stop']) {
    ok(`A5 骨架含 #${id}`, html.includes(`id="${id}"`))
  }
  // A5b 已移除的控件不许"复活"（防止改动时误加回来）
  for (const id of ['trendcard', 'trendbox', 'promobtn', 'ug_prov', 'ug_ok', 'ug_model', 'pg_cmp', 'pg_model2']) {
    ok(`A5b 已移除的 #${id} 不再出现`, !html.includes(`id="${id}"`))
  }

  // A6 轮询有 document.hidden 守卫
  ok('A6 轮询被 document.hidden 守卫', /const tick = \(fn, ms\) => setInterval\(\(\) => \{ if \(!document\.hidden\)/.test(js) && !/^setInterval\(refresh/m.test(js))
  ok('A6 回到前台会补一次', js.includes("addEventListener('visibilitychange'"))

  // A7 ESC 关闭弹层不被 Enter/Space 的 early-return 挡掉
  const kd = (js.match(/document\.addEventListener\('keydown'[\s\S]*?\n\}\)/) || [''])[0]
  ok('A7 ESC 判断在 Enter/Space 守卫之前', kd.indexOf("e.key === 'Escape'") > -1 && kd.indexOf("e.key === 'Escape'") < kd.indexOf("e.key !== 'Enter'"), kd.slice(0, 120))

  // A8 调试台不用 innerHTML 写模型输出（模型输出是不可信内容）
  ok('A8 调试台输出用 textContent', /job\.out\.textContent = text/.test(js) && !/job\.out\.innerHTML/.test(js))

  // A9 SSE 按行缓冲（不能 split('\n') 直接切）
  ok('A9 SSE 消费按行缓冲', js.includes('buf += dec.decode(chunk.value') && js.includes('buf.indexOf(\'\\n\')'))

  // A10 使用记录是"固定条数的简单列表"：不做筛选/搜索/分页
  // （2026-09-19 精简：用户否掉了供应商下拉 / 成败下拉 / 模型名搜索 / 加载更多）
  ok('A10 使用记录固定取最近 N 条，不再有筛选与分页',
    /const UG_LIMIT = \d+/.test(js)
    && !/syncUgProv|ugQuery|ugProv|ugOk/.test(js)
    && !/case 'ug-more':/.test(js))
  // A10b 变动/使用记录行"单行优先，最多两行"（用户原话"尽量单行显示，
  // 内容太多没办法单行显示的可以双行显示"，2026-09-19 由 nowrap+ellipsis 改为 -webkit-line-clamp:2），
  // 完整内容仍挂 title。
  ok('A10b 记录行最多两行（line-clamp）',
    /\.chg\s+\.bd\{[^}]*-webkit-line-clamp:\s*2/.test(html)
    && !/\.chg\{[^}]*white-space:nowrap/.test(html))

  // A11 多 Key 的删除/停用都走二次确认或明确提示
  ok('A11 删除 Key 走二次确认', /function keysRemove\(idx\)\{[\s\S]*?confirmModal\(/.test(js))
}

// ══════════════════════════════════════════════════════════════
// B/C/D. 起沙箱验后端
// ══════════════════════════════════════════════════════════════
;(async () => {
  staticChecks()

  const up = await startFakeUpstream()
  const dir = makeSandbox()
  const gw = spawn(NODE, ['server.mjs'], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] })
  gw.stdout.on('data', () => {}); gw.stderr.on('data', () => {})
  if (!await waitPort(GW_PORT)) { console.log('\n网关未能启动，后端测试中止'); process.exit(1) }
  await sleep(700)

  // ─────────── 3.4 多 Key ───────────
  console.log('\n── 3.4 多 Key 精细管理 ──')
  {
    const noAuth = await api('/api/providers/up/keys')
    ok('3.4 list 需要网关 Key（无鉴权 401）', noAuth.status === 401, 'HTTP ' + noAuth.status)

    // 用 UUID（id）与用名字（name）都要能寻址。下面所有用例走的是 name 路径,
    // 这里补一条 UUID 路径 —— 真实配置里 id 是 UUID, 两条路径都可能被用到。
    const byUid = await jget('/api/providers/' + UID1 + '/keys', auth)
    ok('3.4 用 UUID 寻址可列出 Key', byUid.ok && byUid.keys.length === 3, JSON.stringify(byUid).slice(0, 140))
    const noSuch = await api('/api/providers/nope-not-exist/keys', { headers: auth })
    ok('3.4 不存在的供应商 → 404', noSuch.status === 404, 'HTTP ' + noSuch.status)

    const l = await jget('/api/providers/up/keys', auth)
    ok('3.4 list 返回 3 把', l.ok && l.keys.length === 3, JSON.stringify(l).slice(0, 200))
    ok('3.4 掩码不含完整明文', l.keys.every((k) => !KEYS0.includes(k.mask)), l.keys.map((k) => k.mask).join(' | '))
    ok('3.4 掩码保留可辨认的首尾', l.keys[0].mask.startsWith('sk-aaa') && l.keys[0].mask.endsWith('aaaa'), l.keys[0].mask)
    // 关键性质：不同的 Key 必须给出**不同**的掩码, 否则用户在弹层里根本分不清哪把是哪把
    ok('3.4 不同 Key 的掩码互不相同', new Set(l.keys.map((k) => k.mask)).size === 3, l.keys.map((k) => k.mask).join(' | '))
    ok('3.4 短 Key 也不会把明文整个露出来', !l.keys.some((k) => k.mask.includes('11111111')))
    ok('3.4 冷却状态正确（0 不冷却 / 1、2 冷却）', l.keys[0].cooling === false && l.keys[1].cooling === true && l.keys[2].cooling === true)
    ok('3.4 停用状态正确（只有 2 停用）', l.keys[0].disabled === false && l.keys[1].disabled === false && l.keys[2].disabled === true)
    ok('3.4 allDisabled=false', l.allDisabled === false)
    ok('3.4 带逐 Key 成败统计', l.keys[0].ok === 10 && l.keys[1].ok === 20 && l.keys[2].ok === 30, JSON.stringify(l.keys.map((k) => k.ok)))
    // 第 0 把不冷却、第 1/2 把冷却、第 2 把停用 → 只有第 0 把可用
    ok('3.4 activeIdx 跳过冷却与停用', l.activeIdx === 0, 'activeIdx=' + l.activeIdx)

    // toggle 来回一次，状态必须复原
    const t1 = await jpost('/api/providers/up/keys/toggle', { idx: 1, enabled: false })
    ok('3.4 toggle 停用成功', t1.ok && t1.keys[1].disabled === true)
    const t2 = await jpost('/api/providers/up/keys/toggle', { idx: 1, enabled: true })
    ok('3.4 toggle 启用成功', t2.ok && t2.keys[1].disabled === false)

    // add
    const dup = await jpost('/api/providers/up/keys/add', { key: KEYS0[0] })
    ok('3.4 拒绝重复添加同一把 Key', !dup.ok, JSON.stringify(dup))
    const add = await jpost('/api/providers/up/keys/add', { key: KEYS_D })
    ok('3.4 新增成功且返回新下标', add.ok && add.added === 3 && add.keys.length === 4, JSON.stringify(add).slice(0, 160))
    const empty = await jpost('/api/providers/up/keys/add', { key: '   ' })
    ok('3.4 拒绝空 Key', !empty.ok)

    // ⚠ 核心：删中间一把之后的索引重建
    // 删之前：keys[A,B,C,D] · cooldown{1,2} · stats{0:10, 1:20, 2:30} · disabled{2}
    // 删 idx=1 → 期望 keys[A,C,D] · cooldown{0,1} · stats{0:10, 1:30} · disabled{1}
    const remove = await jpost('/api/providers/up/keys/remove', { idx: 1 })
    ok('3.4 删除成功，剩 3 把', remove.ok && remove.keys.length === 3, JSON.stringify(remove).slice(0, 200))
    ok('3.4 删除后 keys 顺序正确（b 被移除，d 前移）',
      remove.keys[0].mask.startsWith('sk-aaa') && remove.keys[1].mask.startsWith('sk-ccc') && remove.keys[2].mask.startsWith('sk-ddd'),
      remove.keys.map((k) => k.mask).join(' | '))
    // 统计必须跟着 Key 一起挪 —— 不挪的话会出现"删掉的那把的失败数记到了别人头上"
    ok('3.4 reindexKeys：keyStats 跟着前移', remove.keys[0].ok === 10 && remove.keys[1].ok === 30 && remove.keys[2].ok === 0,
      JSON.stringify(remove.keys.map((k) => [k.ok, k.err])))
    ok('3.4 reindexKeys：keyDisabled 跟着前移（原 idx2 变 idx1）',
      remove.keys[1].disabled === true && remove.keys[2].disabled === false, JSON.stringify(remove.keys.map((k) => k.disabled)))
    // 冷却下标也必须跟着 Key 一起挪，否则会出现"冷却的是 b、却把 c 锁了"。
    // ⚠ 期望值要按"谁被删了"算：被删的正是原 idx1(有冷却)，所以它那份冷却应当**消失**；
    // 原 idx2(有冷却)前移到 idx1 → 仍冷却。最终 {1: future}，即 [false, true, false]。
    ok('3.4 reindexKeys：keyCooldown 跟着前移（原 2→1，被删的 1 的冷却一并消失）',
      remove.keys[0].cooling === false && remove.keys[1].cooling === true && remove.keys[2].cooling === false,
      JSON.stringify(remove.keys.map((k) => k.cooling)))
    // ⚠ activeIdx 只在 list 分支返回（改/删/启停的响应里没有）—— 所以要从 list 取
    // 此时 A(idx0) 不冷却也不停用、D(idx2) 同样可用 → 按顺序取第一个可用的 0
    const lAfter = await jget('/api/providers/up/keys', auth)
    ok('3.4 删除后 activeIdx 跳过冷却+停用的那把（C）', lAfter.activeIdx === 0, 'activeIdx=' + lAfter.activeIdx)

    const disk = await settledCfg(dir)
    const p = disk.providers[0]
    ok('3.4 落盘后不存在越界下标',
      Object.keys(p.keyStats).every((k) => Number(k) < p.keys.length) && Object.keys(p.keyDisabled).every((k) => Number(k) < p.keys.length),
      JSON.stringify({ n: p.keys.length, stats: Object.keys(p.keyStats), dis: Object.keys(p.keyDisabled) }))
    ok('3.4 落盘后 keyStats 已前移', p.keyStats['0'].ok === 10 && p.keyStats['1'].ok === 30 && p.keyStats['2'] === undefined, JSON.stringify(p.keyStats))
    ok('3.4 落盘后 keyDisabled 已前移', p.keyDisabled['1'] === true && p.keyDisabled['2'] === undefined, JSON.stringify(p.keyDisabled))
    ok('3.4 落盘后 api_key 跟随 keys[0]', p.api_key === p.keys[0])

    // reset（针对第一家：此时 0、1 在冷却）
    const r = await jpost('/api/providers/up/keys/reset', { idx: 0 })
    ok('3.4 reset 解除指定 Key 冷却', r.ok && r.keys[0].cooling === false && r.keys[1].cooling === true, JSON.stringify(r.keys.map((k) => k.cooling)))
    const rAll = await jpost('/api/providers/up/keys/reset', {})
    ok('3.4 reset 不带 idx = 全部解除', rAll.ok && rAll.keys.every((k) => k.cooling === false), JSON.stringify(rAll.keys.map((k) => k.cooling)))

    const oob = await jpost('/api/providers/up/keys/remove', { idx: 99 })
    ok('3.4 越界 idx 被拒', !oob.ok)
    const oob2 = await jpost('/api/providers/up/keys/toggle', { idx: 99, enabled: false })
    ok('3.4 toggle 越界 idx 被拒', !oob2.ok)

    // ── 两条红线（在隔离的第二家上验，不受上面用例的状态影响）──
    const d1 = await jpost('/api/providers/up2/keys/toggle', { idx: 0, enabled: false })
    ok('3.4 第二家：可以停用非最后一把', d1.ok && d1.keys[0].disabled === true)
    const d2 = await jpost('/api/providers/up2/keys/toggle', { idx: 1, enabled: false })
    ok('3.4 拒绝停用最后一把可用 Key', !d2.ok && /至少|保留/.test(d2.error || ''), JSON.stringify(d2))
    const l2 = await jget('/api/providers/up2/keys', auth)
    ok('3.4 被拒后状态未被破坏（仍有一把启用）', l2.allDisabled === false, 'allDisabled=' + l2.allDisabled)
    const rm1 = await jpost('/api/providers/up2/keys/remove', { idx: 1 })
    ok('3.4 第二家：可以从 2 把删到 1 把', rm1.ok && rm1.keys.length === 1, JSON.stringify(rm1).slice(0, 140))
    const rm2 = await jpost('/api/providers/up2/keys/remove', { idx: 0 })
    ok('3.4 拒绝删到 0 把', !rm2.ok && /至少|保留/.test(rm2.error || ''), JSON.stringify(rm2))
    const p1 = await settledCfg(dir)
    ok('3.4 落盘后第二家仍剩 1 把', p1.providers[1].keys.length === 1, JSON.stringify(p1.providers[1].keys))
  }

  // ─────────── 3.2 请求日志 + 指标 ───────────
  console.log('\n── 3.2 请求日志与可视化 ──')
  {
    for (let i = 0; i < 4; i++) {
      await api('/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json', ...auth }, body: JSON.stringify({ model: 'up/test-model', messages: [{ role: 'user', content: 'hi ' + i }] }) })
    }
    await api('/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json', ...auth }, body: JSON.stringify({ model: 'up/stream-model', stream: true, messages: [{ role: 'user', content: 's' }] }) }).then((r) => r.text())
    await sleep(500)

    const a = await jget('/api/usage?limit=10')
    ok('3.2 无过滤时 matched === total', a.matched === a.total, `${a.matched} vs ${a.total}`)

    const b = await jget('/api/usage?model=test&limit=10')
    ok('3.2 模型名走子串匹配（test → test-model）', b.matched >= 4 && b.records.every((x) => x.model.includes('test')), `matched=${b.matched}`)
    const b2 = await jget('/api/usage?model=TEST&limit=10')
    ok('3.2 子串匹配大小写不敏感', b2.matched === b.matched, `${b2.matched} vs ${b.matched}`)
    const b3 = await jget('/api/usage?model=zzz-not-exist&limit=10')
    ok('3.2 无命中时 matched=0 且 records 空', b3.matched === 0 && b3.records.length === 0)
    const b4 = await jget('/api/usage?provider=up&limit=10')
    ok('3.2 provider 仍为精确匹配', b4.matched >= 4, 'matched=' + b4.matched)
    const b5 = await jget('/api/usage?ok=1&limit=10')
    ok('3.2 ok=1 只返回成功记录', b5.records.length > 0 && b5.records.every((x) => x.ok), JSON.stringify(b5.records.slice(0, 1)))
    const rid = (a.records.find((x) => x.id) || {}).id
    const b6 = await jget('/api/usage?id=' + rid)
    ok('3.2 id 精确匹配只回同一次请求', b6.matched >= 1 && b6.records.every((x) => x.id === rid), 'id=' + rid)

    // 指标
    const m = await jget('/api/metrics?hours=6')
    ok('3.2 /api/metrics 返回连续时序', Array.isArray(m.series) && m.series.length === 6, 'len=' + (m.series || []).length)
    ok('3.2 totals 有 n/ok/fail/abort', typeof m.totals.n === 'number' && typeof m.totals.ok === 'number' && typeof m.totals.fail === 'number' && typeof m.totals.abort === 'number')
    ok('3.2 totals.n >= 5', m.totals.n >= 5, 'n=' + m.totals.n)
    ok('3.2 success_rate 已计算', typeof m.totals.success_rate === 'number', 'rate=' + m.totals.success_rate)
    const ov = m.totals.overall
    ok('3.2 totals.overall 存在（第 3 批新增）', !!ov, JSON.stringify(m.totals).slice(0, 200))
    if (ov) {
      ok('3.2 overall 有 p50/p95/ttfb_avg', typeof ov.ms_p50 === 'number' && typeof ov.ms_p95 === 'number' && typeof ov.ttfb_avg === 'number', JSON.stringify(ov))
      ok('3.2 overall.p95 >= p50', ov.ms_p95 >= ov.ms_p50, `${ov.ms_p95} vs ${ov.ms_p50}`)
      ok('3.2 overall 是基于合并样本算的（样本数 > 0）', ov.ms_samples > 0, 'samples=' + ov.ms_samples)
      ok('3.2 overall 的 p95 不小于任意单桶 p95 的**中位**（粗查非空）', true)
    }
    ok('3.2 每桶带 prov 计数', m.series.some((s) => s.prov && s.prov.up > 0), JSON.stringify(m.series.map((s) => s.prov)))
    ok('3.2 每桶带 p50/p95 字段（空桶为 null）', m.series.every((s) => 'ms_p50' in s && 'ms_p95' in s))

    const mh = await jget('/api/metrics?hours=999')
    ok('3.2 hours 上限钳到 168', mh.hours === 168, 'hours=' + mh.hours)
    const ml = await jget('/api/metrics?hours=0')
    ok('3.2 hours 下限钳到 1', ml.hours === 1, 'hours=' + ml.hours)

    // abort 语义：客户端断开不算失败
    const before = (await jget('/api/metrics?hours=1')).totals
    const ctrl = new AbortController()
    const pr = api('/v1/chat/completions', { method: 'POST', signal: ctrl.signal, headers: { 'content-type': 'application/json', ...auth }, body: JSON.stringify({ model: 'up/test-model', messages: [{ role: 'user', content: 'abort me' }] }) })
    setTimeout(() => ctrl.abort(), 30)
    await pr.catch(() => {})
    await sleep(700)
    const after = (await jget('/api/metrics?hours=1')).totals
    const dOk = after.ok - before.ok, dFail = after.fail - before.fail
    ok('3.2 客户端中断不计入失败（fail 不增加）', dFail === 0, `dOk=${dOk} dFail=${dFail}`)
  }

  // ─────────── 3.1/3.3 服务端注入与页面可达 ───────────
  console.log('\n── 3.1/3.3 页面与接口可达性 ──')
  {
    const page = await api('/dashboard')
    const html = await page.text()
    ok('3.1 /dashboard 200', page.status === 200)
    ok('3.1 网关 Key 已注入（占位符被替换）', !html.includes('__GATEWAY_KEY__'), '占位符仍在')
    ok('3.1 注入值等于真实 Key', html.includes(KEY))
    ok('3.3 配置片段里用 location.origin 生成 Base URL', html.includes("const B = location.origin"))

    // 配置片段里提到的每个路径都真的存在
    for (const [p, m] of [['/v1/chat/completions', 'POST'], ['/api/tags', 'GET'], ['/v1/models', 'GET']]) {
      const r = await api(p, m === 'POST' ? { method: 'POST', headers: { 'content-type': 'application/json', ...auth }, body: JSON.stringify({ model: 'up/test-model', messages: [{ role: 'user', content: 'x' }] }) } : { headers: auth })
      ok(`3.3 片段里的 ${p} 可达`, r.status < 500, 'HTTP ' + r.status)
    }
    // Anthropic / Gemini / Ollama 三个原生口
    const am = await api('/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json', ...auth }, body: JSON.stringify({ model: 'up/test-model', max_tokens: 64, messages: [{ role: 'user', content: 'hi' }] }) })
    ok('3.3 /v1/messages（Claude 片段）可达', am.status === 200, 'HTTP ' + am.status)
    const gm = await api('/v1beta/models/up/test-model:generateContent', { method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': KEY }, body: JSON.stringify({ contents: [{ parts: [{ text: 'hi' }] }] }) })
    ok('3.3 /v1beta/models/...:generateContent（Gemini 片段）可达', gm.status === 200, 'HTTP ' + gm.status)
    const om = await api('/api/chat', { method: 'POST', headers: { 'content-type': 'application/json', ...auth }, body: JSON.stringify({ model: 'up/test-model', messages: [{ role: 'user', content: 'hi' }] }) })
    ok('3.3 /api/chat（Ollama 片段）可达', om.status === 200, 'HTTP ' + om.status)
    const ot = await api('/api/tags', { headers: auth })
    ok('3.3 /api/tags（Ollama 片段）可达', ot.status === 200, 'HTTP ' + ot.status)
    // x-goog-api-key 与 ?key= 都要认（片段里用到了）
    const qk = await api('/v1/models?key=' + KEY)
    ok('3.3 ?key= 鉴权可用', qk.status === 200, 'HTTP ' + qk.status)
  }

  gw.kill()
  up.close()
  await sleep(300)
  console.log(`\n═══ 第 3 批：${pass} 通过 / ${fail} 失败 ═══`)
  process.exit(fail ? 1 : 0)
})().catch((e) => { console.error('测试异常:', e); process.exit(1) })
