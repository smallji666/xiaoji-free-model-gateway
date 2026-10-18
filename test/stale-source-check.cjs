#!/usr/bin/env node
/*
 * 停更熔断的端到端验证（离线、确定性）。
 *
 * 为什么不能只靠单测：单测只证明 `sourceStaleDays` 算得对 + 源码里有那句 `continue`。
 * "整源真的不合并"这件事只有在**跑一次真实同步**、再看落盘的 free_whitelist.json 才算证明。
 * 做法：把 3 个真实源的 fetch() 换成确定性桩（不碰网络），再追加一个"停更源"，
 *      然后启动网关、等它写完白名单、读文件断言。
 *
 * 期望：fresh-* 三家在 hosts 里；stale-fake.example.com **不在**；sources.fakesrc 带"已忽略"。
 */
const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process')
const T = __dirname
const ROOT = (() => { const _fs = require('fs'), _p = require('path'); let d = _p.dirname(__dirname); for (let i = 0; i < 6; i++) { if (_fs.existsSync(_p.join(d, 'server.mjs'))) return d; d = _p.dirname(d) } return _p.join(__dirname, '..') })()
const SB = path.join(T, 'sb-stale')
const { freshSandbox } = require('./sb-util.cjs')
const PORT = 8813
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  freshSandbox(SB)
  fs.mkdirSync(SB, { recursive: true })

  // 1) 复制运行态（与 sb-build.cjs 同一份清单）
  for (const f of ['dashboard.html', 'free_catalog.json', 'usage_log.json', 'metrics.json', 'promo_state.json']) {
    const s = path.join(ROOT, f); if (fs.existsSync(s)) fs.copyFileSync(s, path.join(SB, f))
  }
  fs.cpSync(path.join(ROOT, 'assets'), path.join(SB, 'assets'), { recursive: true })

  // 2) config: 只改端口 + 清空 providers（→ 不触发真实目录扫描, 全程离线）
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'))
  cfg.port = PORT
  cfg.providers = []
  fs.writeFileSync(path.join(SB, 'config.json'), JSON.stringify(cfg, null, 2))

  // 3) 打补丁版 server.mjs: 桩掉真实源 + 追加停更源
  let src = fs.readFileSync(path.join(ROOT, 'server.mjs'), 'utf8')
  const anchor = "// freellm.net 的清单仓库(开源, 每日自动刷新)"
  if (!src.includes(anchor)) { console.error('锚点丢失, 无法打补丁'); process.exit(2) }
  const patch = `
// [E2E 补丁] 真实源换确定性桩, 并追加一个"停更源"(清单日期 2026-08-01)
for (const s of WHITELIST_SOURCES) {
  s.fetch = async () => ({ date: '2026-10-06', hosts: { ['fresh-' + s.id + '.example.com']: { source: 'fresh-' + s.id, models: ['m1'] } } })
}
WHITELIST_SOURCES.push({
  id: 'fakesrc', name: '假停更源',
  async fetch() { return { date: '2026-08-01', hosts: { 'stale-fake.example.com': { source: 'StaleFake', models: ['stale-1', 'stale-2'] } } } },
})

`
  src = src.replace(anchor, patch + anchor)
  fs.writeFileSync(path.join(SB, 'server.mjs'), src)

  // 4) 启动 -> 等同步落盘 -> 读文件
  const gw = cp.spawn(process.execPath, ['server.mjs'], { cwd: SB, stdio: ['ignore', 'pipe', 'pipe'] })
  let log = ''
  gw.stdout.on('data', (d) => { log += d })
  gw.stderr.on('data', (d) => { log += d })

  const WL = path.join(SB, 'free_whitelist.json')
  let wl = null
  for (let i = 0; i < 40; i++) {
    await sleep(500)
    try {
      const j = JSON.parse(fs.readFileSync(WL, 'utf8'))
      if (j && j.sources && j.sources.fakesrc) { wl = j; break }
    } catch {}
  }
  // ⚠ 杀之前先等那行警告刷出来：网关是**先 `console.warn` 再落盘**，但 stderr 走的是异步管道 ——
  //   测试一看到白名单文件就把进程杀掉，可能把还在管道里的那行警告一起带走
  //   （2026-10-08 实测过一次偶发 FAIL：文件已落盘，日志却少一行）。
  //   这里只等"日志出现"，等不到就照常超时判 FAIL —— 是消除竞态，不是掩盖失败。
  for (let i = 0; i < 20 && !/本轮不参与合并/.test(log); i++) await sleep(150)
  try { gw.kill() } catch {}
  // Windows 上 SIGTERM 不一定能让 node 子进程立刻退出（本项目在 Windows 上本来就没有真信号），
  // 补一发硬杀兜底；类 Unix 上 gw.kill() 已经够了，且没有 taskkill 这个命令。
  if (process.platform === 'win32') {
    try { cp.execSync('taskkill /PID ' + gw.pid + ' /F', { stdio: 'ignore' }) } catch {}
  }

  if (!wl) { console.error('未拿到同步结果。日志:\n' + log.slice(-2000)); process.exit(1) }
  const hosts = Object.keys(wl.hosts || {})
  let pass = 0, fail = 0
  const ck = (n, ok, extra) => { console.log((ok ? 'PASS ' : 'FAIL ') + n + (ok ? '' : '  << ' + (extra || ''))); ok ? pass++ : fail++ }

  ck('新鲜源(2家)进入 hosts', ['fresh-openrouter.example.com', 'fresh-freellm.example.com'].every((h) => hosts.includes(h)), hosts.join(','))
  ck('停更源(2026-08-01)的厂商**没有**进入 hosts', !hosts.includes('stale-fake.example.com'), hosts.join(','))
  ck('停更源也没混进候选', !Object.keys(wl.candidates || {}).includes('stale-fake.example.com'), Object.keys(wl.candidates || {}).join(','))
  ck('源状态写明"已忽略"', /^2026-08-01 ⚠停更\d+天, 已忽略$/.test(String(wl.sources.fakesrc || '')), JSON.stringify(wl.sources))
  ck('新鲜源状态照常记日期', wl.sources.freellm === '2026-10-06', JSON.stringify(wl.sources))
  ck('日志里有一条明确警告', /本轮不参与合并/.test(log), log.slice(-800))
  console.log(`\n== ${pass} passed, ${fail} failed ==`)
  process.exit(fail ? 1 : 0)
}
main().catch((e) => { console.error('HARNESS ERROR', e); process.exit(1) })
