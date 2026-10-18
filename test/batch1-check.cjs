#!/usr/bin/env node
/*
 * 第 1 批（安全与数据完整性）回归测试 —— 全部在沙箱跑，不碰生产 8787。
 *
 * 覆盖：
 *   1.1 /api/state 不再明文回传网关 Key；仪表盘 HTML 正确注入完整 Key
 *   1.2 config.json 损坏时不再静默覆盖：备份 + 从 .prev 恢复 + configRecovered 告警
 *   1.3 原子写：高频写盘过程中 config.json 始终可 JSON.parse
 *   1.5 端口占用时明确退出（exit code 1），而不是"假活"
 *   1.7 超大请求体返 413（而不是连接被重置）
 *   1.8 SSRF：云元数据/私网拒绝，环回放行
 *   1.9 客户端断开 → 上游请求真的被掐断（假上游能观察到 close）
 *   1.10 定时器 unref：SIGTERM 后进程能退出且退出前落盘
 *
 * 用法：node test/batch1-check.cjs
 */
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { resetSandboxDir } = require('./sb-util.cjs')

const ROOT = (() => { const _fs = require('fs'), _p = require('path'); let d = _p.dirname(__dirname); for (let i = 0; i < 6; i++) { if (_fs.existsSync(_p.join(d, 'server.mjs'))) return d; d = _p.dirname(d) } return _p.join(__dirname, '..') })()
const NODE = process.execPath
const GW_PORT = 8793
const UP_PORT = 8794
const KEY = 'freegw-batch1-test-key-000000000000'

let pass = 0, fail = 0
const ok = (n, cond, d = '') => { if (cond) { pass++; console.log('  PASS ' + n) } else { fail++; console.log('  FAIL ' + n + (d ? '  → ' + d : '')) } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const waitPort = async (port, timeout = 8000) => {
  const t0 = Date.now()
  while (Date.now() - t0 < timeout) {
    try { await fetch(`http://127.0.0.1:${port}/healthz`); return true } catch { await sleep(150) }
  }
  return false
}

// ── 假上游：能流式吐字，并记录"客户端是否断开" ──
let upstreamClosed = 0
function startFakeUpstream() {
  const srv = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      if (/\/models/.test(req.url)) {
        res.writeHead(200, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ object: 'list', data: [{ id: 'test-model' }] }))
      }
      // 慢速 SSE：一直吐到被掐断为止
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      let n = 0
      const timer = setInterval(() => {
        n++
        try { res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'tok' + n } }] })}\n\n`) } catch {}
        if (n > 200) { clearInterval(timer); try { res.write('data: [DONE]\n\n'); res.end() } catch {} }
      }, 120)
      const onGone = () => { upstreamClosed++; clearInterval(timer) }
      res.on('close', onGone)
      req.on('close', onGone)
    })
  })
  return new Promise((r) => srv.listen(UP_PORT, '127.0.0.1', () => r(srv)))
}

// ── 沙箱：复制当前 server.mjs + dashboard.html，写一份指向假上游的配置 ──
function makeSandbox(name, cfgOverride = {}) {
  const dir = path.join(__dirname, 'sb-' + name)
  // ⚠ 不能 fs.rmSync(dir, {recursive:true})：本机 safe-delete 守卫会因"单轮删 >50 文件"直接拒绝，
  //    测试就崩在清理步骤上，报错还像是被测代码坏了。用非递归重置，见 sb-util.cjs。
  resetSandboxDir(dir)
  // .sandbox 标记: 让 server.mjs 启动时跳过 syncUpstreamWhitelist, 否则真实同步会
  // 把这个空白名单覆盖成含 api.groq.com / openrouter.ai 这种真域名的真实名单,
  // 影响后续依赖"沙箱 base_url=127.0.0.1 不在白名单"的测试断言。
  fs.writeFileSync(path.join(dir, '.sandbox'), '')
  fs.copyFileSync(path.join(ROOT, 'server.mjs'), path.join(dir, 'server.mjs'))
  fs.copyFileSync(path.join(ROOT, 'dashboard.html'), path.join(dir, 'dashboard.html'))
  fs.writeFileSync(path.join(dir, 'free_whitelist.json'), JSON.stringify({ hosts: {} }))
  const cfg = Object.assign({
    port: GW_PORT,
    proxy: '',
    gatewayKey: KEY,
    providers: [{
      id: 'up', name: 'up', label: 'Up', base_url: `http://127.0.0.1:${UP_PORT}/v1`,
      keys: ['sk-up'], api_key: 'sk-up', model: 'test-model', models: ['test-model'],
      needs_proxy: false, enabled: true, ok: 0, err: 0,
      lastSweepAt: '2026-09-18T00:00:00.000Z', lastSweep: { at: '2026-09-18T00:00:00.000Z' },
      disabledModels: {},
    }],
  }, cfgOverride)
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(cfg, null, 2))
  return dir
}
function spawnGw(dir, port = GW_PORT) {
  const p = spawn(NODE, ['server.mjs'], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] })
  p.stdout.on('data', () => {})
  p.stderr.on('data', () => {})
  p.gwPort = port
  return p
}

const api = (p, opt = {}) => fetch(`http://127.0.0.1:${GW_PORT}${p}`, opt)

;(async () => {
  const up = await startFakeUpstream()
  const dir = makeSandbox('main')
  const gw = spawnGw(dir)
  if (!await waitPort(GW_PORT)) { console.log('网关未能启动，测试中止'); process.exit(1) }
  await sleep(500)

  console.log('\n── 1.1 /api/state 不再泄 Key ──')
  {
    const st = await (await api('/api/state')).json()
    ok('1.1 /api/state 不含明文 Key', st.gatewayKey !== KEY, '实际=' + st.gatewayKey)
    ok('1.1 /api/state 回掩码', /…/.test(st.gatewayKey || ''), '实际=' + st.gatewayKey)
    ok('1.1 响应体全文搜不到明文 Key', !JSON.stringify(st).includes(KEY))
    const html = await (await api('/')).text()
    ok('1.1 仪表盘注入了完整 Key', html.includes(`window.__GK__='${KEY}'`))
    ok('1.1 仪表盘无残留占位符', !html.includes('__GATEWAY_KEY__'))
  }

  console.log('\n── 2.6 未实现端点回 501 而不是 404 ──')
  {
    // ⚠ /v1/responses 于 2026-10-17 实现(Codex CLI 只认这个协议), 已从这张表移出 ——
    //   它现在会真的走路由链, 拿空 body 打过去得到的是 502(上游全失败)而不是 501。
    const eps = ['/v1/embeddings', '/v1/completions', '/v1/audio/transcriptions',
      '/v1/images/generations', '/v1/moderations', '/v1/rerank', '/v1/batches', '/v1/models/gpt-4o', '/v1beta/models']
    let bad = []
    for (const e of eps) {
      const r = await api(e, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + KEY }, body: '{}' })
      if (r.status !== 501) bad.push(e + '=' + r.status)
    }
    ok(`2.6 ${eps.length} 个未实现端点全部 501`, bad.length === 0, bad.join(', '))
    const j = await (await api('/v1/embeddings', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + KEY }, body: '{}' })).json()
    ok('2.6 501 带 code=not_implemented', j.error && j.error.code === 'not_implemented')
    const r404 = await api('/v1/nonexistent', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + KEY }, body: '{}' })
    ok('2.6 真正写错的路径仍回 404', r404.status === 404, '实际=' + r404.status)
  }

  console.log('\n── 1.7 请求体超限返 413 ──')
  {
    const big = 'x'.repeat(5 * 1024 * 1024)
    let status = 0, err = ''
    try {
      const r = await api('/v1/chat/completions', {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + KEY },
        body: JSON.stringify({ model: 'auto', messages: [{ role: 'user', content: big }] }),
      })
      status = r.status
    } catch (e) { err = e.message }
    ok('1.7 超大请求体返 413（不是连接被重置）', status === 413, '实际=' + status + (err ? ' err=' + err : ''))
  }

  console.log('\n── 1.8 SSRF 校验 ──')
  {
    const add = async (u) => {
      const r = await api('/api/providers', {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + KEY },
        body: JSON.stringify({ name: 's' + Math.random().toString(36).slice(2, 8), label: 's', base_url: u, api_key: 'k', models: ['m'] }),
      })
      return { s: r.status, b: await r.text() }
    }
    const meta = await add('http://169.254.169.254/latest/meta-data')
    ok('1.8 云元数据地址被拒', meta.s >= 400 && /元数据/.test(meta.b), meta.s + ' ' + meta.b.slice(0, 100))
    const priv = await add('http://192.168.1.10:8000/v1')
    ok('1.8 私网 192.168.x 被拒', priv.s >= 400 && /内网/.test(priv.b), priv.s)
    const priv10 = await add('http://10.0.0.5/v1')
    ok('1.8 私网 10.x 被拒', priv10.s >= 400, priv10.s)
    const lo = await add(`http://127.0.0.1:${UP_PORT}/v1`)
    ok('1.8 环回 127.0.0.1 放行（本地模型/沙箱要用）', lo.s < 400, lo.s + ' ' + lo.b.slice(0, 100))
  }

  console.log('\n── 1.9 客户端断开 → 上游真的被掐断 ──')
  {
    upstreamClosed = 0
    const ac = new AbortController()
    const p = fetch(`http://127.0.0.1:${GW_PORT}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + KEY },
      body: JSON.stringify({ model: 'auto', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
      signal: ac.signal,
    }).then((r) => r.body.getReader()).then(async (rd) => { await rd.read(); await rd.read() }).catch(() => {})
    await sleep(900)          // 等流开始
    ac.abort()                // 模拟"用户点了停止"
    await p.catch(() => {})
    await sleep(1200)         // 给网关一点时间把上游掐掉
    ok('1.9 断开后上游请求被中止（假上游观察到 close）', upstreamClosed > 0, 'upstreamClosed=' + upstreamClosed)
  }

  console.log('\n── 1.3 原子写：高频写盘下配置始终可解析 ──')
  {
    let bad = 0
    for (let i = 0; i < 12; i++) {
      // 触发写盘：切一个模型的勾选状态
      await api('/api/providers/up/modeltoggle', {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + KEY },
        body: JSON.stringify({ model: 'test-model', enabled: i % 2 === 0 }),
      }).catch(() => {})
      await sleep(60)
      try { JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')) } catch (e) { bad++ }
    }
    ok('1.3 写入过程中 config.json 始终可解析', bad === 0, bad + ' 次解析失败')
    ok('1.3 生成了 config.json.prev 备份', fs.existsSync(path.join(dir, 'config.json.prev')))
  }

  console.log('\n── 1.10 SIGTERM 后能退出且退出前落盘 ──')
  {
    gw.kill('SIGTERM')
    const exited = await Promise.race([
      new Promise((r) => gw.once('exit', (code) => r(code === 0 || code === null ? 'ok' : 'code' + code))),
      sleep(5000).then(() => 'timeout'),
    ])
    ok('1.10 SIGTERM 后进程自行退出（定时器已 unref）', exited !== 'timeout', '结果=' + exited)
    const cfg = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'))
    ok('1.10 退出时配置已落盘（configVersion=2）', cfg.configVersion === 2, '实际=' + cfg.configVersion)
    ok('1.12 迁移留下了备份', fs.readdirSync(dir).some((f) => f.startsWith('config.json.pre-migrate.')))
    // ⚠ 这两条是"反向断言": 迁移**不该**删它们。
    // lastSweepAt 是防扣费闸门的承重字段(只在真的验到上游时才写, 仪表盘靠它算新鲜度);
    // api_key 是代码在维护的活镜像(改 Key 时会 p.api_key = p.keys[0] 写回)。
    // 曾一度把它们当"冗余字段"删掉, 是错的 —— 留着断言防止再犯。
    ok('1.12 迁移未删 lastSweepAt（闸门承重字段）', 'lastSweepAt' in cfg.providers[0], Object.keys(cfg.providers[0]).join(','))
    ok('1.12 迁移未删 api_key（代码维护的活镜像）', 'api_key' in cfg.providers[0])
    // ⚠ Windows 上 child.kill('SIGTERM') 是硬杀(TerminateProcess), 不走 JS 的 exit 钩子,
    // 所以这里不能断言 pid 文件被删除 —— 那是 Windows 平台限制, 不是回归。
    // 能验的是: pid 文件确实写出过、且内容是启动它的那个进程。
    const pidFile = path.join(dir, 'gateway.pid')
    if (fs.existsSync(pidFile)) {
      ok('1.5 gateway.pid 内容为该实例 PID', Number(fs.readFileSync(pidFile, 'utf8')) === gw.pid, 'pid=' + fs.readFileSync(pidFile, 'utf8') + ' 期望=' + gw.pid)
    } else {
      ok('1.5 gateway.pid 已被优雅退出清理', true)
    }
  }

  console.log('\n── 1.5 端口占用 → 明确退出（不是假活）──')
  {
    const d2 = makeSandbox('conflict', { port: GW_PORT })
    const a = spawnGw(d2)
    if (!await waitPort(GW_PORT)) { ok('1.5 前置实例启动', false); } else {
      const b = spawn(NODE, ['server.mjs'], { cwd: d2, stdio: ['ignore', 'pipe', 'pipe'] })
      let stderr = ''
      b.stderr.on('data', (c) => { stderr += c })
      // 窗口给到 15s，不是随手放大 —— Windows 上 node 冷启动（首次加载 6MB server.mjs，
      // 多半还叠加杀软实时扫描）实测要 9.7s 才走到 EADDRINUSE 退出，热启动只要 1.7s。
      // 原来的 6s 在冷缓存时必然超时，会让这条用例随机变红 —— 而"一直红着的闸门"正是本项目最反对的东西。
      const code = await Promise.race([
        new Promise((r) => b.once('exit', (c) => r(c))),
        sleep(15000).then(() => 'timeout'),
      ])
      ok('1.5 端口冲突的第二个实例以非零码退出', code === 1, '退出码=' + code)
      ok('1.5 日志给出了明确指引', /已被占用/.test(stderr), stderr.slice(0, 120))
      a.kill('SIGTERM')
    }
  }

  console.log('\n── 1.2 配置损坏 → 备份 + 从 .prev 恢复，不再静默清空 ──')
  {
    const d3 = makeSandbox('corrupt')
    // 先跑一次让它写出 .prev（原子写会留上一份）
    const g1 = spawnGw(d3)
    if (!await waitPort(GW_PORT)) { ok('1.2 前置实例启动', false) }
    else {
      await sleep(400)
      g1.kill('SIGTERM')
      await sleep(600)
    }
    // 制造损坏：截断成半截 JSON
    const good = fs.readFileSync(path.join(d3, 'config.json'), 'utf8')
    fs.writeFileSync(path.join(d3, 'config.json'), good.slice(0, Math.floor(good.length / 2)))
    const g2 = spawn(NODE, ['server.mjs'], { cwd: d3, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    g2.stdout.on('data', (c) => { out += c })
    g2.stderr.on('data', (c) => { out += c })
    if (!await waitPort(GW_PORT)) { ok('1.2 损坏配置下仍能启动', false) }
    else {
      const st = await (await api('/api/state')).json()
      ok('1.2 启动未崩（损坏配置不致命）', true)
      ok('1.2 /api/state 回传 configRecovered 告警', !!st.configRecovered, JSON.stringify(st.configRecovered))
      ok('1.2 供应商没被清空（从 .prev 恢复）', st.providers.length > 0, 'providers=' + st.providers.length)
      ok('1.2 损坏文件已留档', fs.readdirSync(d3).some((f) => f.includes('.corrupt.')), fs.readdirSync(d3).join(','))
      ok('1.2 日志明确说明已备份', /配置解析失败/.test(out), out.slice(0, 200))
    }
    g2.kill('SIGTERM')
  }

  up.close()
  console.log(`\n================ 第 1 批：${pass} 通过 / ${fail} 失败 ================`)
  process.exit(fail ? 1 : 0)
})().catch((e) => { console.error('测试脚本异常:', e); process.exit(1) })
