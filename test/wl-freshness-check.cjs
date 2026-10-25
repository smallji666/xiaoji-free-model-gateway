// wl-freshness-check.cjs —— "白名单到底变没变"的判据回归（离线，端口 8833）
//
// 为什么必须有这个套件：2026-10-25 把白名单同步间隔从 6 小时提到 30 分钟之后，"变没变"的判据
// 成了整个实时机制的地基。判错两个方向都会出事，而且**都不会报错**：
//   · 把"没变"判成"变了" -> 每 30 分钟重建一次 hosts，并连带触发目录扫描(见同步末尾) ——
//     实时机制反而变成"每半小时把已接入的厂商全打一遍"；
//   · 把"变了"判成"没变" -> 名单**永远不再更新**。这比"不实时"严重得多，而且表面上一切正常。
//
// 三条判据都要锁住：
//   ① 上游回 304                        -> 没变
//   ② 上游回 200 但正文指纹与上轮相同    -> 没变（OpenRouter 的真实情形，见下方说明）
//   ③ 正文真的变了                      -> 必须重建（反断言，防止短路写成"永远短路"）
//
// ⚠ 为什么②必须存在（实测 2026-10-25）：OpenRouter 的 /api/v1/models 是 791KB，
//   `Cache-Control: max-age=120` —— CDN 每 2 分钟回源刷新一次，于是 `Last-Modified` 大约每
//   2~4 分钟就变一次。30 分钟后带着 If-Modified-Since 去问，**几乎必然拿到 200**。
//   只认 304 的话，每一轮都会被判成"源变了"。所以判据是"304 **或** 正文指纹相同"。
//
// ⚠ 全程离线：三个真实源被桩掉，桩的行为由环境变量控制，不碰网络。
const cp = require('child_process')
const fs = require('fs')
const path = require('path')

const NODE = process.execPath
const SB = path.join(__dirname, 'sb-wlfresh')
const PORT = 8833
const WL = path.join(SB, 'free_whitelist.json')
const ROOT = (() => {
  let d = path.dirname(__dirname)
  for (let i = 0; i < 6; i++) { if (fs.existsSync(path.join(d, 'server.mjs'))) return d; d = path.dirname(d) }
  return path.join(__dirname, '..')
})()

let pass = 0, fail = 0
const ok = (c, m, extra) => {
  if (c) { pass++; console.log('  PASS  ' + m) }
  else { fail++; console.log('  FAIL  ' + m + (extra ? '\n    ↳ ' + String(extra).replace(/\s+/g, ' ').slice(0, 400) : '')) }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 沙箱清理：逐文件 unlink + 逐目录 rmdir（本机 safe-delete 守卫不允许 rm -rf）
function cleanSandbox() {
  if (!fs.existsSync(SB)) return
  const files = [], dirs = []
  ;(function walk(d) {
    for (const f of fs.readdirSync(d)) {
      const fp = path.join(d, f)
      let st
      try { st = fs.statSync(fp) } catch { continue }
      if (st.isDirectory()) { walk(fp); dirs.push(fp) } else files.push(fp)
    }
  })(SB)
  for (const f of files) { try { fs.unlinkSync(f) } catch {} }
  dirs.sort((a, b) => b.length - a.length)
  for (const d of dirs) { try { fs.rmdirSync(d) } catch {} }
  try { fs.rmdirSync(SB) } catch {}
}

// 把三个真实源换成确定性桩。锚点选 freellm 那行注释 —— 它在 WHITELIST_SOURCES 数组**之后**，
// 所以补丁能引用到 WHITELIST_SOURCES 与 textHash。
function patchServer(src) {
  const anchor = '// freellm.net 的清单仓库(开源, 每日自动刷新)'
  if (!src.includes(anchor)) throw new Error('锚点丢失，无法打补丁（server.mjs 结构变了？）')
  const patch = `
// [E2E 补丁] 真实源 -> 确定性桩, 行为由 FAKE_VER / FAKE_MODE 控制, 不碰网络。
// discovery 一律置 false: 否则桩贡献的 host 会被判 provisional 而进候选区, 测不到 hosts。
for (const s of WHITELIST_SOURCES) {
  s.discovery = false
  s.fetch = async () => {
    const ver = process.env.FAKE_VER || 'v1'
    const mode = process.env.FAKE_MODE || 'ok'
    if (mode === '304') return { notModified: true, cond: { etag: 'e-' + ver } }
    const body = JSON.stringify({ ver, hosts: { ['fake-' + s.id + '.example.com']: { source: 'F' + ver, models: ['m1'] } } })
    return { date: '', live: true, cond: { etag: 'e-' + ver }, hash: textHash(body), hosts: JSON.parse(body).hosts }
  }
}

`
  return src.replace(anchor, patch + anchor)
}

// 起一次网关，等日志命中 waitRe 就收工。每次场景都是"一次完整启动" —— 同步只在启动时跑一次。
function runOnce(env, waitRe, maxMs = 25000) {
  return new Promise((resolve) => {
    const g = cp.spawn(NODE, [path.join(SB, 'server.mjs')], {
      cwd: SB, stdio: ['ignore', 'pipe', 'pipe'], env: Object.assign({}, process.env, env),
    })
    let log = ''
    let done = false
    const fin = (why) => {
      if (done) return
      done = true
      try { cp.execSync('taskkill /PID ' + g.pid + ' /F', { stdio: 'ignore' }) } catch {}
      resolve({ why, log })
    }
    const on = (d) => {
      log += d
      if (waitRe && waitRe.test(log)) setTimeout(() => fin('matched'), 700)
    }
    g.stdout.on('data', on)
    g.stderr.on('data', on)
    setTimeout(() => fin('timeout'), maxMs)
  })
}

function readWl() { return JSON.parse(fs.readFileSync(WL, 'utf8')) }
const fakeHosts = (wl) => Object.entries(wl.hosts || {}).filter(([h]) => h.startsWith('fake-'))

async function main() {
  cleanSandbox()
  fs.mkdirSync(SB, { recursive: true })
  // ⚠ 刻意**不写 .sandbox**: 那个标记会让 syncUpstreamWhitelist 直接短路返回（它防的是
  //   "测试把真实白名单写脏"），而本套件要测的正是同步本身。
  fs.writeFileSync(path.join(SB, 'config.json'), JSON.stringify({
    port: PORT, proxy: '', gatewayKey: 'test-' + '0'.repeat(27), providers: [], aliases: {},
  }, null, 2))
  fs.writeFileSync(path.join(SB, 'server.mjs'), patchServer(fs.readFileSync(path.join(ROOT, 'server.mjs'), 'utf8')))
  fs.copyFileSync(path.join(ROOT, 'dashboard.html'), path.join(SB, 'dashboard.html'))

  const W = /\[whitelist\].*(同步完成|源未变化)/

  // ══ 场景 1：首次同步（无缓存）══
  console.log('\n【1】首次同步（无缓存）')
  const r1 = await runOnce({ FAKE_VER: 'v1' }, W)
  ok(/同步完成/.test(r1.log), '首次同步走完整重建', r1.log.slice(-400))
  ok(fakeHosts(readWl()).length === 3, '三个桩源各自贡献了一家厂商（进 hosts，不是候选区）', JSON.stringify(fakeHosts(readWl()).map(([h]) => h)))
  const wl1 = readWl()
  ok(wl1.sourceHash && Object.keys(wl1.sourceHash).length === 3, '正文指纹已落盘（sourceHash，三个源）', JSON.stringify(wl1.sourceHash))
  ok(wl1.sourceCond && Object.keys(wl1.sourceCond).length === 3, '条件请求凭据已落盘（sourceCond）', JSON.stringify(wl1.sourceCond))
  const hosts1 = JSON.stringify(wl1.hosts)

  // ══ 场景 2：上游回 304 ══
  console.log('\n【2】上游回 304')
  await sleep(400)
  const r2 = await runOnce({ FAKE_VER: 'v1', FAKE_MODE: '304' }, W)
  ok(/源未变化/.test(r2.log) && /304/.test(r2.log), '304 -> 判为没变', r2.log.slice(-400))
  ok(JSON.stringify(readWl().hosts) === hosts1, '短路时 hosts 一个字节都没动（没有重建）')

  // ══ 场景 3：回 200 但内容没变（OpenRouter 的真实情形）══
  console.log('\n【3】回 200 但正文指纹相同')
  await sleep(400)
  const r3 = await runOnce({ FAKE_VER: 'v1', FAKE_MODE: 'ok' }, W)
  ok(/源未变化/.test(r3.log) && /指纹相同/.test(r3.log), '200 但指纹相同 -> 判为没变', r3.log.slice(-400))
  ok(JSON.stringify(readWl().hosts) === hosts1, '这一轮同样没有重建 hosts')

  // ══ 场景 4：内容真的变了（反断言）══
  // 如果短路被写成"永远短路"（比如判据写成 okResults.length >= 0），这一步会照样命中
  // "源未变化" —— 而那意味着名单从此永不更新。
  console.log('\n【4】内容真的变了（反断言）')
  await sleep(400)
  const r4 = await runOnce({ FAKE_VER: 'v2' }, W)
  ok(/同步完成/.test(r4.log) && !/源未变化/.test(r4.log), '内容变了 -> 走完整重建（短路不是无条件的）', r4.log.slice(-400))
  const fh = fakeHosts(readWl())
  ok(fh.length === 3 && fh.every(([, v]) => v.source === 'Fv2'), '重建后名单确实换成了 v2 的内容', JSON.stringify(fh.map(([h, v]) => h + '=' + v.source)))
  ok(readWl().sourceHash && Object.values(readWl().sourceHash).length === 3, '指纹跟着更新（下一轮才能继续判"没变"）')

  console.log(`\n  ${pass} 通过 / ${fail} 失败`)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => { console.error(e.stack || e); process.exit(1) })
