#!/usr/bin/env node
/*
 * 建一个「整套运行态」的沙箱 —— 供所有需要**起真实网关**的测试 / 截图 / 量页面用。
 *
 * ⚠ 存在的唯一理由（2026-10-06 血泪）：**少复制一个文件就会量出假的版面**。
 *   实测：沙箱漏了 `usage_log.json` → 左列「模型使用记录」卡（JS 按数据切换 display）不渲染 →
 *   layout-check 把两列高度差量成 **423px（真实只有 12px）**，我差点据此把「免费池变动」
 *   搬出 grid 做一次大改；漏 `assets/` → 3 条 404 假 FAIL。
 *   清单固化在这里，别再手写。
 *
 * 用法: node test/sb-build.cjs [目标目录] [端口]
 *   默认 test/sb-ui / 8816
 *
 * 起网关（⚠ 必须与跑测试在**同一次 bash 调用**内 —— bash 调用一结束后台进程就被回收）:
 *   (cd <dir> && node server.mjs > gw.log 2>&1 &) && sleep 6 && \
 *     GW_PORT=<port> node test/layout-check.cjs
 *   收尾: taskkill //PID $(cat <dir>/gateway.pid) //F
 */
const fs = require('node:fs'), path = require('node:path')
const ROOT = (() => { const _fs = require('fs'), _p = require('path'); let d = _p.dirname(__dirname); for (let i = 0; i < 6; i++) { if (_fs.existsSync(_p.join(d, 'server.mjs'))) return d; d = _p.dirname(d) } return _p.join(__dirname, '..') })()
const SB = path.resolve(ROOT, process.argv[2] || 'test/sb-ui')
const { freshSandbox } = require('./sb-util.cjs')
const PORT = parseInt(process.argv[3] || '8816', 10)

// ⚠ 这份清单就是「完整运行态」的定义。加/减文件前先想清楚：少了它，哪张卡会不渲染、哪条断言会假 FAIL？
const COPY = ['server.mjs', 'dashboard.html', 'free_whitelist.json', 'free_catalog.json',
  'usage_log.json', 'metrics.json', 'promo_state.json']

freshSandbox(SB)
fs.mkdirSync(SB, { recursive: true })
const missing = []
for (const f of COPY) {
  const src = path.join(ROOT, f)
  if (fs.existsSync(src)) fs.copyFileSync(src, path.join(SB, f))
  else missing.push(f)
}
const assets = path.join(ROOT, 'assets')
if (fs.existsSync(assets)) fs.cpSync(assets, path.join(SB, 'assets'), { recursive: true })
else missing.push('assets/')

// config 只改端口，其余原样 —— 池子 / 学习到的延迟 / 冷却都是**真实的**，量出来的版面才有意义
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'))
cfg.port = PORT
fs.writeFileSync(path.join(SB, 'config.json'), JSON.stringify(cfg, null, 2))

console.log(`沙箱就绪 ${SB}（端口 ${PORT}）`)
console.log('  文件:', fs.readdirSync(SB).join(', '))
if (missing.length) console.warn('  ⚠ 缺失（会导致对应卡片不渲染 / 假 FAIL）:', missing.join(', '))
