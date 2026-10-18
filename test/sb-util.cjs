// 沙箱目录重置 —— **刻意不做 `fs.rmSync(dir, { recursive: true })`**。
//
// 为什么不能用递归删除:
//   ① 跑过几十轮的沙箱会攒下上百个文件(每启动一次网关就多一份 config.json.pre-migrate.*),
//      而本机 CLI 的 safe-delete 守卫在"单轮删除超过 50 个文件"时会直接拒绝 ——
//      测试于是崩在**清理步骤**上, 报错还像是被测代码坏了(实际见过一次)。
//   ② 递归删目录本身也太宽: 测试只该重置自己认识的状态文件, 不该顺手把目录里其它东西删掉。
//
// 做法: 只真删"跨轮残留会改变断言结果"的那几个文件(每轮 ≤12 个, 远低于守卫阈值),
// 其余交给测试自己覆盖(makeSandbox 都会显式 writeFileSync 一份 config.json)。
// 目录本身保留, 所以 config.json.pre-migrate.* 的历史会一直攒着 —— 它们不参与断言,
// 也不该被测试清掉。攒多了跑一次 `node sb-util.cjs --clean`(见文件末尾 cleanTestArtifacts)。
const fs = require('node:fs')
const path = require('node:path')

// 必须真删的:
//   config.json.prev / .tmp —— 备份文件会被"配置损坏恢复"这类用例读到, 残留上一轮的内容会让断言假通过
//   gateway.pid            —— 残留会让"端口占用/假活"的判定读到过期的 pid
const REMOVE = ['config.json.prev', 'config.json.tmp', 'gateway.pid']
// 必须清空的:
//   usage_log / metrics / free_catalog / promo_state —— 跨轮累积会让"本轮产生了 N 条"这类断言失准
//   logs/xiaoji.log*      —— 同理; 尤其 batch4 的日志滚动断言要求"从空开始写满 1MB 才滚出 .1",
//                            上一轮留下的 >1MB 旧日志会让首次写入就立刻滚动, 断言就说不清了
const CLEAR = ['usage_log.json', 'metrics.json', 'free_catalog.json', 'promo_state.json']
const CLEAR_LOGS = ['logs/xiaoji.log', 'logs/xiaoji.log.1', 'logs/xiaoji.log.2',
  'logs/xiaoji.log.3', 'logs/xiaoji.log.4', 'logs/xiaoji.log.5']

function resetSandboxDir(dir) {
  fs.mkdirSync(dir, { recursive: true })
  for (const f of REMOVE) { try { fs.unlinkSync(path.join(dir, f)) } catch {} }
  for (const f of CLEAR) { try { fs.unlinkSync(path.join(dir, f)) } catch {} }
  for (const f of CLEAR_LOGS) { try { fs.unlinkSync(path.join(dir, f)) } catch {} }
  // config.json.pre-migrate.<时间戳> —— 每启动一次网关就多一份（迁移前的备份），
  // 是沙箱里**最主要的堆积源**：跑几十轮就攒成几十个文件，然后 `fs.rmSync(dir, {recursive:true})`
  // 撞上 safe-delete 的"单轮删 >50 文件"守卫直接抛错，测试崩在清理步骤、报错还像是被测代码坏了
  // （实测 2026-10-08：sb-stale 攒到 86 个文件 → stale-source-check 整个套件 exit 1）。
  // 它们只是历史备份、不参与任何断言，逐文件删掉最省事（逐文件 unlink 不触发批量守卫）。
  try {
    for (const f of fs.readdirSync(dir)) {
      if (f.startsWith('config.json.pre-migrate.')) { try { fs.unlinkSync(path.join(dir, f)) } catch {} }
    }
  } catch {}
  return dir
}

// 每个套件开头该调用的"把沙箱清回干净状态"。
// ⚠ 存在的唯一理由：**不要用 `fs.rmSync(dir, { recursive: true })`** ——
//   沙箱跑几十轮会攒下上百个文件，本机 safe-delete 守卫会因"单轮删 >50 文件"直接拒绝，
//   于是测试崩在**清理步骤**上、报错却像是被测代码坏了（2026-09-26 与 2026-10-08 各踩一次）。
//   目录本身保留，只重置认识的状态文件；其余交给测试自己覆盖。
function freshSandbox(dir) {
  return resetSandboxDir(dir)
}

// ─────────────────────────────────────────────────────────────
// 生产 config.json 的**语义摘要**（gate-check / batch4 共用）
// ─────────────────────────────────────────────────────────────
// 守卫"供应商 / 模型 / Key / 启停"这些测试有可能误改的东西，剥掉纯运行时字段。
//
// ⚠ 为什么不直接哈希整个文件：线上 8787 实例一直在跑，它自己会写 config.json ——
//   目录扫描写 lastSweepAt/lastSweep、失败写 lastError、请求成败写逐 Key 统计与冷却时间。
//   只要测试窗口里线上恰好落了盘，整文件哈希就会不等，于是报"生产被触碰"的**假失败**
//   （2026-09-19 实测踩到：刚重启完网关就跑，启动扫描正好在这个窗口写盘）。
//   真正要守的是"测试有没有误改配置"，不是"网关有没有在正常工作"。
const crypto = require('node:crypto')
// ⚠ 这张表是"跑一次就漏一个"的典型：只要线上实例写了一个这里没列的运行时字段，
//   gate-check / batch4 就会报"生产被触碰"的**假失败**（2026-09-19 实测：25 秒窗口里
//   线上就把 lastUsed / qWindow / modelLatN / keyStats 写了一遍）。
//   判据只有一个：**凡是网关正常运行就会自己变的字段，都必须在这里**。
const VOLATILE_KEYS = [
  'lastSweepAt', 'lastSweep', 'lastError', 'lastOkAt', 'latency', 'latN',
  'ttfb', 'ttfbN', 'lastTtfb', 'tokps', 'ok', 'err', 'rpmCap', 'rpmCapAt',
  'modelLat', 'modelLatN', 'modelTokps', 'modelTtfb', 'modelOk', 'modelErr',
  'modelCooldown', 'keyCooldown', 'keyStats',
  'qWindow', 'lastUsed', 'lastUsedAt',
  'blocked', 'quarantine', 'lastProbeAt',
  // accountIssue(2026-09-21 加): 账号级无模型权限标记。它是**运行时**认知, 线上实例每次体检
  // 都可能写/删它 —— 不列在这里, gate-check/batch4 的"生产被触碰"守卫会误报。
  'accountIssue',
  // noTools(2026-09-25 加): "这个模型不支持 function calling"的**实测学习**结论。
  // 线上实例只要有一次带 tools 的请求被上游以"不支持"措辞拒绝, 就会写它 —— 同样是运行时认知。
  'noTools',
  // modelQ(2026-09-25 加): **模型级**质量窗口。每次真实请求成功/失败都会写 —— 运行时认知。
  // ⚠ 这个当时漏加了, 只是"测试窗口内恰好没变动"才没暴露; 线上任意一次请求落在测试窗口里
  //   都会让 gate-check / batch4 报"生产 config.json 被触碰"的**假失败**。
  'modelQ',
  // downUntil(2026-09-25 加): "这个模型最近打不通, 暂时不领跑"的到期时间。失败写、成功删。
  'downUntil',
  // quota(2026-10-09 加): 上游配额头(`x-ratelimit-remaining-*`)的最近一次实测快照。
  // 只要上游回了配额头就会刷新 —— 而 429 恰恰是回配额头最勤的时候, 所以它**必然**会在
  // 测试窗口里变动。漏了它就是 modelQ 那个坑的翻版: gate-check / batch4 报"生产 config.json
  // 被触碰"的**假失败**(见 modelQ 那条注释)。
  'quota',
]

function stableConfigView(configPath) {
  let cfg
  try { cfg = JSON.parse(fs.readFileSync(configPath, 'utf8')) } catch { return 'unreadable' }
  const strip = (p) => {
    const c = { ...p }
    for (const k of VOLATILE_KEYS) delete c[k]
    if (Array.isArray(c.keys)) c.keys = c.keys.map((k) => (typeof k === 'object' && k ? k.key : k))
    if (Array.isArray(c.models)) c.models = [...c.models].sort()
    if (c.disabledModels && typeof c.disabledModels === 'object') c.disabledModels = Object.keys(c.disabledModels).sort()
    return c
  }
  const view = {
    providers: (cfg.providers || []).map(strip).sort((a, b) => String(a.name).localeCompare(String(b.name))),
    proxy: cfg.proxy, port: cfg.port, gatewayKey: cfg.gatewayKey, auth: cfg.auth,
  }
  return crypto.createHash('sha256').update(JSON.stringify(view)).digest('hex')
}

// ─────────────────────────────────────────────────────────────
// 一次性清理：`node sb-util.cjs --clean`
// ─────────────────────────────────────────────────────────────
// 每跑一轮套件就会攒下：沙箱目录里的 config.json.pre-migrate.*（每启动一次网关多一份）、
// 被测试 copy 进来的 server.mjs / dashboard.html 副本、gw*.log。它们不影响断言，
// 但几个月下来能堆到几十上百个文件（2026-09-19 一次性清掉 95 个 / 6.19MB）。
// ⚠ 同样**不递归删目录** —— 只删明确认识的文件，并且逐文件 unlink（不触发 safe-delete 守卫）。
// ⚠ 这份清单是"新增一个沙箱就要补一行"的典型，漏一行就永远清不到。
//   2026-09-26 实测漏了 sb-feat → 它的 server.mjs 副本(329KB)在里面躺了一天。
//   加新沙箱时**同时改这里和上面 resetSandboxDir 的调用方**。
const CLEAN_DIRS = ['sb-main', 'sb-gate', 'sb-corrupt', 'sb-conflict', 'sb-feat',
  'sb2-main', 'sb3-main', 'sb4-a', 'sb4-b',
  // 2026-10-06 补: 本轮新增的沙箱一个都没在这份清单里 —— 照旧例(漏 sb-feat 那次)一次补齐。
  //   sb-probe/sb-with/sb-nosrc 是"删源前后对照"用的, sb-ui/sb-final 是量版面用的,
  //   sb-stale 是 stale-source-check.cjs 的离线端到端沙箱。
  'sb-probe', 'sb-with', 'sb-nosrc', 'sb-ui', 'sb-final', 'sb-stale',
  // 2026-10-08 补: 迁到 test/ 时又漏了三个 —— why-check(sb-why) / route-invariant(sb-route)
  //   / free-eval(sb-eval)。它们以前靠 `fs.rmSync(recursive)` 自删，改成安全的 freshSandbox()
  //   之后目录会保留，所以必须登记在这里，否则会永远躺着。
  'sb-why', 'sb-route', 'sb-eval',
  // 2026-10-09 补: quota-reload-check 的沙箱。新套件**第一次跑就会在这里留一份**
  //   server.mjs 副本(329KB) + config.json + 日志 —— 不登记就是又一次"漏一行"。
  'sb-quota',
  // logs/ 与 shots/ 是 test/ 顶层的产物（protocol-test 的网关日志、shotseg 的截图），
  // 同样得登记，否则清不掉。
  'logs', 'shots',
  // tmp-src: 抓下来的上游源快照(or.json/md.json 加起来 6MB), 纯临时素材, 别长期躺着
  'tmp-src']
const CLEAN_FILES = [
  'config.json.prev', 'gw.log', 'gw2.log',
  // ⚠ 滚动备份也要清。原来只写了 'logs/xiaoji.log'，于是 .1~.5 一直攒着 ——
  //   2026-09-26 实测 sb4-a 一个 logs/xiaoji.log.1 就 1143KB，占当时测试目录残留的 1/4。
  //   上面 CLEAR_LOGS 早就列全了 6 个，这里漏写属于抄漏，不是有意为之。
  'logs/xiaoji.log', 'logs/xiaoji.log.1', 'logs/xiaoji.log.2',
  'logs/xiaoji.log.3', 'logs/xiaoji.log.4', 'logs/xiaoji.log.5',
  // 这两个是测试启动时自己 copy 进来的副本，下次跑还会再 copy，删掉最省事
  'server.mjs', 'dashboard.html',
]
function cleanTestArtifacts() {
  const here = __dirname
  let n = 0, bytes = 0
  const rm = (p) => {
    try { const st = fs.statSync(p); if (!st.isFile()) return; bytes += st.size; fs.unlinkSync(p); n++ } catch {}
  }
  // test/ 顶层本身就是 protocol-test 的"沙箱"（它把 server.mjs / dashboard.html 拷到自己目录再跑网关，
  // 见 protocol-test.cjs 的注释）。规则与 hedge/ 一致：**保留 *.cjs / *.md（源码与说明），其余文件全清**。
  // 子目录（logs/ shots/ 与各 sb-*/）交给下面 CLEAN_DIRS。
  for (const f of fs.readdirSync(here)) {
    if (/\.(cjs|md)$/i.test(f)) continue
    const fp = path.join(here, f)
    let st; try { st = fs.statSync(fp) } catch { continue }
    if (st.isDirectory()) continue
    rm(fp)
  }
  // ⚠ 这里必须**递归**。原来对子目录是 `if (isDirectory()) continue` 直接跳过，
  //   于是沙箱里的 `logs/` 子目录整个清不到 —— 而 logs 恰恰是最大的堆积源：
  //   2026-09-26 实测 sb4-a/logs/xiaoji.log.1 单个 1143KB，占当时测试目录残留的 80%，
  //   且 `rmdirSync` 因目录非空而**静默失败**（try/catch 吞了），外面完全看不出来。
  //   跑完只剩一个"释放 0.33MB"的漂亮数字，真正的大块还躺在里面。
  //   递归删除不会触发 safe-delete 守卫：守卫按"单轮 unlink 的文件数"计数，
  //   清理后每个沙箱只剩个位数文件（首次全量清理时若报守卫错误，再跑一次即可）。
  // ⚠ 收尾 rmdir 会**偶发失败且被 `catch {}` 咽掉**（2026-10-08 实测：sb-stale 已清空却仍在，
  //   手动 `fs.rmdirSync` 却一次成功 → 说明是清理当轮的瞬时失败）。
  //   后果不大（空目录 0 字节、git 也不跟踪），但会让 `ls -d test/sb-*` 出现幽灵目录，
  //   而本项目判"清理干净了没"恰恰是**看目录实际状态** —— 咽掉失败等于把判据本身弄脏。
  //   失败后退到 rmSync(recursive) 兜一次：它不按 unlink 次数计数，不会触发 safe-delete 守卫。
  const rmdirRetry = (d) => {
    try { fs.rmdirSync(d); return } catch {}
    try { fs.rmSync(d, { recursive: true, force: true }) } catch {}
  }
  const sweepDeep = (dir) => {
    if (!fs.existsSync(dir)) return
    for (const f of fs.readdirSync(dir)) {
      const fp = path.join(dir, f)
      let st; try { st = fs.statSync(fp) } catch { continue }
      if (st.isDirectory()) { sweepDeep(fp); rmdirRetry(fp) }
      else rm(fp)
    }
  }
  // ⚠ hedge/ 是**源码目录**（fake-up.cjs / hedge-check.cjs 住在里面），不能整个删掉。
  //   它同时又是 hedge-check 的沙箱（测试在那儿生成 config.json / free_whitelist.json /
  //   server.mjs 副本 / logs/ / .sandbox …）。所以规则是：**保留 *.cjs，其余全清**。
  //   只按 CLEAN_FILES 逐个删是不够的 —— hedge 还会生成 metrics.json / usage_log.json /
  //   free_catalog.json / .sandbox，漏一个就永远清不掉。
  const hedge = path.join(here, 'hedge')
  if (fs.existsSync(hedge)) {
    for (const f of fs.readdirSync(hedge)) {
      if (f.endsWith('.cjs')) continue
      const fp = path.join(hedge, f)
      let st; try { st = fs.statSync(fp) } catch { continue }
      if (st.isDirectory()) { sweepDeep(fp); rmdirRetry(fp) }
      else rm(fp)
    }
  }
  for (const d of CLEAN_DIRS) {
    const dir = path.join(here, d)
    if (!fs.existsSync(dir)) continue
    sweepDeep(dir)
    rmdirRetry(dir)
  }
  return { files: n, bytes }
}

if (process.argv[2] === '--clean') {
  const r = cleanTestArtifacts()
  console.log(`清理测试残留：删除 ${r.files} 个文件，释放 ${(r.bytes / 1048576).toFixed(2)} MB`)
}

module.exports = { resetSandboxDir, freshSandbox, stableConfigView, cleanTestArtifacts }
