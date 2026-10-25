// 小鸡免费模型 XiaoJi Free Model - 本地免费大模型聚合网关
// 用法: node server.mjs  (零依赖, Node >= 18)
import http from 'node:http'
import https from 'node:https'
import tls from 'node:tls'
import net from 'node:net'
import { PassThrough } from 'node:stream'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CONFIG_PATH = path.join(__dirname, 'config.json')
const DASHBOARD_PATH = path.join(__dirname, 'dashboard.html')
const CATALOG_PATH = path.join(__dirname, 'free_catalog.json')

// 版本号: 单一事实来源是 package.json（发布时打的 git tag 与它对齐）。
// ⚠ 读不到就退回占位符 —— 分发包/技能包里可能没有 package.json, 绝不能因此起不来。
let VERSION = '0.0.0-dev'
try {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'))
  if (pkg && typeof pkg.version === 'string') VERSION = pkg.version
} catch { /* 没有 package.json 就用占位符, 不阻断启动 */ }


// ══════════════════════════════════════════════════════════════════════════
// 章节索引 —— 改代码前先在这里定位。
// ⚠ **本表刻意不写行号**（2026-10-04 踩过）：行号是"起点"不是契约，改动几行后必漂 ——
//   实测上一版索引的 20 个行号**全部**漂了（+370 ~ +1959 行），读的人照着跳全跳错。
//   正确用法：**直接搜下面的章节标题**（`// ──── 标题 ────` 是分节的锚），
//   或搜 `function 名`。这两类锚点不随行数变化，永远不会过期。
// ══════════════════════════════════════════════════════════════════════════
// ── 基础设施 ──
//   · 仪表盘 HTML 缓存              dashboardHtml()
//   · 日志: 分级 + 按大小滚动        （slog/log 相关）
//   · 落盘工具                      writeJsonAtomic()
//   ── 配置（顶部 CONFIG_PATH / 默认结构 DEFAULTS / loadConfig / saveConfig）──

// ── 免费判定 —— 钱袋子核心，动之前先读这一组 ──
//   · 免费模型判定与推荐规则          metaIsFree() / judgeFree() / isRecommended()
//   · 限时免费活动标注(人工兜底)      PROMO 常量
//   · 限时活动公告页自动巡检          （公告页巡检）

// ── 厂商与路由 ──
//   · 多 Key 与速率学习              pickKeyIdx() / recentReqs() / markOk() / markFail()
//   · 厂商接入点目录                 VENDOR_DIR
//   · 候选厂商的可读名               （厂商名映射，无同名函数）
//   · 配置结构迁移                   migrateConfig()
//   · 路由: 构建候选链               pickChain() / attemptChain()
//   · 模型别名(客户端熟名字 -> 免费池)  MODEL_ALIAS

// ── 上游通信 ──
//   · HTTPS-over-CONNECT 代理隧道    getTunnelAgent() / _tunnelAgents
//   · 向上游转发                     forward() / isAnonProvider() / authHeaderFor()
//   · 协议适配层: Anthropic / Gemini / Ollama 原生格式 <-> OpenAI   sanitizePayload() 及各 to*()

// ── 可观测性 ──
//   · 统计                          STATS
//   · 模型使用记录(仪表盘「模型使用记录」板块)   recordUsage() / saveUsage()
//   · 请求级指标(仪表盘图表的唯一数据源)        recordMetrics() / saveMetrics()

// ── 接口层 ──
//   · 管理接口鉴权模式(结构预留)      adminAuthed()
//   · /v1/chat/completions          handleChat()
//   · 工具                          （各小工具函数）
//   · 管理 API                      /api/state 等路由
//   · 入站并发闸门                   SEM/QUEUE_MAX（返 503）
//   · HTTP 服务                     createServer()
//   · 健康检查: 存活 vs 就绪         /healthz


// ---------------- 仪表盘 HTML 缓存 ----------------
// 页面 ~201KB(磁盘字节; UTF-8 中文注释多，字符数约 149K), 每次请求都 readFileSync +
// 全局正则替换一遍(替换会再分配一个同尺寸字符串)。
// ⚠ 数字复核(2026-10-04): 改为**实测口径** —— 冷路径(缓存失效时重读+替换)约 11ms,
//   **热路径(命中 mtime 缓存) 实测 p50 = 2.4ms / 201KB**, 是全网关最重的只读路径
//   (其它接口 0.7~4.7ms)。缓存本身有效, 不用动。
// 用 mtime 做失效判据, 所以改完 dashboard.html **不用重启网关**就能立刻生效;
// ⚠ 判据里必须同时带上 gatewayKey —— 换 Key 时 HTML 的 mtime 不变, 只按 mtime 会一直发旧 Key。
let _dashCache = { mtimeMs: -1, key: null, html: '' }
function dashboardHtml() {
  let mtimeMs = -1
  try { mtimeMs = fs.statSync(DASHBOARD_PATH).mtimeMs } catch {}
  if (mtimeMs === _dashCache.mtimeMs && CFG.gatewayKey === _dashCache.key) return _dashCache.html
  const raw = fs.readFileSync(DASHBOARD_PATH, 'utf8')
  // ⚠ 必须用全局替换: 文件里 __GATEWAY_KEY__ 出现两次(注释里一次、script 里一次),
  // 用字符串形式 replace 只会换掉第一个 —— 结果是"注释被替换、真正的 Key 没注入"。
  const html = raw.replace(/__GATEWAY_KEY__/g, CFG.gatewayKey)
  _dashCache = { mtimeMs, key: CFG.gatewayKey, html }
  return html
}

// ---------------- 日志: 分级 + 按大小滚动 ----------------
// 背景: 原来只有"启动时原地截断一次"(保留末尾 512KB), 两个问题:
//   ① 进程长期运行期间日志无限增长(启动脚本用 >> 追加, 没人管);
//   ② 截断是**原地丢弃**, 出事前后那段最关键的日志直接没了, 而且没有历史可比对。
// 现在由服务端自己持有日志文件: 超限就滚动, 保留 LOG_KEEP 份历史。
//
// 实现方式是**在 console 层做 tee**, 而不是把上百个 console.log 调用点全改一遍:
//   调用点照旧写 console.log/warn/error → 级别直接由方法决定(info/warn/error),
//   再原样透传给真正的 stdout/stderr → 手动 `node server.mjs` 时终端照样能看。
// 为什么必须自己持有文件: 启动脚本原来是 `>> server.log` 重定向, 文件句柄握在 cmd 手里,
//   而 Windows 上被占用的文件不能 rename —— 服务端既滚动不了也截不准, 只能原地截断丢历史。
//   现在改成服务端自己写(启动脚本不再重定向), 滚动就只是 close → rename → reopen。
const LOG_DIR = path.join(__dirname, 'logs')
const LOG_FILE = path.join(LOG_DIR, 'xiaoji.log')
const LOG_MAX = 1024 * 1024   // 单份上限 1MB
const LOG_KEEP = 5            // 最多保留 5 份历史(xiaoji.log.1 ~ .5)
let logFd = null
let logSize = 0
function logOpen() {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true })
    try { logSize = fs.statSync(LOG_FILE).size } catch { logSize = 0 }
    logFd = fs.openSync(LOG_FILE, 'a')
  } catch { logFd = null }   // 磁盘/权限问题绝不能让网关起不来, 退化成"只打终端"
}
function logRoll() {
  try { if (logFd !== null) fs.closeSync(logFd) } catch {}   // 必须先松手才能改名
  logFd = null
  try { fs.rmSync(`${LOG_FILE}.${LOG_KEEP}`, { force: true }) } catch {}
  for (let i = LOG_KEEP - 1; i >= 1; i--) {
    try { fs.renameSync(`${LOG_FILE}.${i}`, `${LOG_FILE}.${i + 1}`) } catch {}
  }
  try { fs.renameSync(LOG_FILE, `${LOG_FILE}.1`) } catch {}
  logOpen()
}
function fmtLogArg(a) {
  if (typeof a === 'string') return a
  if (a && a.stack) return a.stack
  try { return JSON.stringify(a) } catch { return String(a) }
}
// 返回写好的整行(含级别与时间戳), 供 tee 到真实 stdout/stderr
function logWrite(level, args) {
  const line = `${new Date().toISOString().replace('T', ' ').slice(0, 23)} ${level} ${args.map(fmtLogArg).join(' ')}`
  if (logFd !== null) {
    try {
      fs.writeSync(logFd, line + '\n')
      logSize += Buffer.byteLength(line) + 1
      if (logSize >= LOG_MAX) logRoll()
    } catch { /* 写失败不抛: 日志系统自己坏了不能把网关带走 */ }
  }
  return line
}
{
  logOpen()
  const real = { log: console.log.bind(console), warn: console.warn.bind(console), error: console.error.bind(console) }
  const wrap = (level, fn) => (...args) => {
    const line = logWrite(level, args)
    try { fn(line) } catch { /* 终端/管道已关(父进程没了)时不要抛 */ }
  }
  console.log = wrap('INFO ', real.log)
  console.warn = wrap('WARN ', real.warn)
  console.error = wrap('ERROR', real.error)
}

// ---------------- 落盘工具 ----------------
// 所有 JSON 状态文件统一走原子写: 先写 .tmp → 把现有文件复制成 .prev 备份 → rename 覆盖。
// 为什么必须这样:
//   ① writeFileSync 直写在写入中途断电/被杀进程会留下半截 JSON, 下次启动解析失败。
//      而 config.json 解析失败一旦被"静默重写成空配置", 等于 7 家真实 API Key 一次性全丢。
//   ② .prev 是"上一份完好文件", 损坏时可以从它恢复(见 loadConfig)。
// renameSync 在 Windows 上是覆盖语义(MoveFileEx), 是原子的。
//
// cfgQuietUntil —— 热重载的静默窗口(见下面的"config.json 热重载"整段)。
// ⚠ 声明在这里(而不是放在热重载那段里)是因为**写入点**就是这里: 把"我刚刚自己写了盘"
//   这件事记在写函数里, 才能把**所有**写 config.json 的路径一次兜住(防抖落盘 / 导入配置 / 迁移),
//   漏掉任何一条都会形成"写→重载→写"的自激循环。
let cfgQuietUntil = 0
function writeJsonAtomic(p, obj, pretty = 2) {
  if (p === CONFIG_PATH) cfgQuietUntil = Date.now() + 1200
  const tmp = p + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(obj, null, pretty))
  try { fs.copyFileSync(p, p + '.prev') } catch {}
  fs.renameSync(tmp, p)
}

// /v1/models 的 30 秒内存缓存。客户端(Cursor / Cherry Studio / Continue)启动时会连打十几次
// 这个接口, 每次都要遍历 7 家 × 上百个模型再序列化一遍, 纯属浪费。
// ⚠ 必须可失效: config 一改动(勾选/取消模型)就置 at=0, 否则用户点了保存还要等 30 秒才生效,
// 会以为"改了没用"。失效点放在**管理写接口**入口(handleAdmin 的非 GET 请求), 一处收口 ——
// ⚠ 绝不能挂在 saveConfig 里: markOk/markFail 每次请求成败都会调 saveConfig, 那样等于
// 每个请求都清一次缓存, 缓存直接失效(= 白做)。
const MODELS_CACHE = { at: 0, body: null }
const MODELS_TTL_MS = 30000

// ---------------- 免费模型判定与推荐规则 ----------------
// 判定优先级(2026-09-13 重做, 起因: "flash 结尾≠免费"把智谱收费模型误判进池, 有扣费风险):
//   ① 上游价格元数据(明确 free/收费) → ② 每日同步的社区免费白名单(封闭集合, 名单外=收费)
//   → ③ "Key 可见即可免费"类厂商(groq/cerebras 等, 免费 plan 的 key 根本看不到收费模型)
//   → ④ 兜底启发式规则(仅对无白名单的自定义厂商生效, 宁可漏判不可错判)
// 白名单每天从多个上游源自动同步一次(见下方 WHITELIST_SOURCES), 厂商改名/上新跟得上。
const RULESET = {
  version: '2026.09b',
  verified_at: '2026-09-13',
  review_days: 2,             // 白名单每日自动同步; 超过 2 天没同步上(断网等)才提醒
  source: '上游价格元数据 + 每日多源同步免费白名单(OpenRouter 官方 :free / freellm.net 每日实测 / models.dev 厂商发现) + 厂商官方免费额度公告',
}
const WHITELIST_PATH = path.join(__dirname, 'free_whitelist.json')
const PROMO_STATE_PATH = path.join(__dirname, 'promo_state.json')
// 白名单多源。合并策略: 各源模型取并集, 但一律过 DENY_FREE + NON_CHAT_RE + pricing 校验,
// 宁可漏判不可错判; openFree/hybrid 判定仍由本地人工核实集合(OPEN_FREE_HOSTS/HYBRID_HOSTS)说了算,
// 名单只提供 models 集合。任一源挂掉不影响其它源; 全挂才沿用本地缓存。
//
// ⚠ 判"某个源是不是停更"看的是**它自己声明的清单日期**, 不是"我们有没有拉到它" ——
//   停更的仓库照样每天 HTTP 200 拉得下来, 内容却停在几个月前。这正是下面两条移除记录的共同原因,
//   也是 SOURCE_STALE_DAYS 熔断要解决的问题(见 syncUpstreamWhitelist): 光把日期显示在仪表盘上
//   没用, 必须真的不给它合并 —— 否则一份 08-21 的名单会一直往池子里塞"早就收费了"的模型。
// 清单正文的指纹 —— 用来判断"源到底变没变"。
// ⚠ 为什么需要它, 而不是只靠 304: 实测(2026-10-25) OpenRouter 的 `Last-Modified` 大约每
//   2 分钟就变一次(Cache-Control: max-age=120, CDN 每 120s 回源刷新), 所以 30 分钟后带着
//   If-Modified-Since 去问, 几乎必然拿到 200 —— 但**正文可能一个字节都没变**(连采三次
//   md5 完全相同)。只靠 304 的话, 每一轮都会被判成"源变了", 于是每 30 分钟重建一次 hosts
//   并连带扫一遍上游, 实时机制反而变成"每半小时打一遍所有已接入厂商"。
//   所以判据是: 304 **或** 正文指纹与上一轮相同 -> 视为没变。
const textHash = (t) => crypto.createHash('sha256').update(String(t || '')).digest('hex')
const WHITELIST_SOURCES = [
  // ⚠ 2026-09-25 移除了 mnfst(awesome-free-llm-apis 社区) 源。用户原话："它早就停更了还用它干嘛？留着误导人"。
  //   该源自 2026-08-21 起停更，却一直挂在源列表里，仪表盘上顶着"社区 08-21⚠停更"。
  //   移除前的实测对比（2026-09-25，脚本拉两源逐 host 比对）：
  //     · 它独有的厂商只剩 2 家（Mistral / HuggingFace），已迁进 MANUAL_WHITELIST；
  //     · 其余 13 家与 freellm 完全重合 —— 它给的模型名更多，但全是 08-21 的旧数据，
  //       且没有任何"每日实测"背书（freellm 要求速率列写明具体免费额度才收）。
  //   删掉之后权威源 = freellm + OpenRouter，交叉印证（provisional 转正）能力不受影响。
  //
  // ⚠ 2026-10-06 移除了 awesomefree(bhardwajRahul/awesome-free-llm-apis 的 data.json) 源。
  //   用户原话: "那些早已停更的免费模型如果现在收费了, 那不就被坑了"。它 2026-08-21 起就没再刷新
  //   (GitHub Action 停了), 却一直挂着 —— 实测它当时给的名单里:
  //     · `gemini-2.5-pro` 被当成免费 —— 而 Google 免费层早已不含 Pro, 是靠 DENY_FREE 硬挡才没进池;
  //     · 12 个 OpenRouter 模型里有 5 个(openai/gpt-oss-20b:free、inclusionai/ling-3.0-flash:free、
  //       nvidia/nemotron-3-nano-30b-a3b:free、nvidia/nemotron-nano-9b-v2:free、
  //       nvidia/nemotron-nano-12b-v2-vl:free) 早就从 OpenRouter 下架了, 还在名单里 -> 调用必 404 空转。
  //   **这就是"停更源"的真实代价: 不是少给了什么, 而是持续给错的东西。**
  //   移除前实测(对照沙箱, 同一时刻): 厂商数 26 -> 26 一家不少, 候选 50 -> 50 一个不少;
  //   已接入的 9 家里没有任何一家因它消失, 也没有任何一个池内模型因它消失
  //   (kilo/openrouter 的池子全是 `why=meta` 判进来的, gemini 那 3 个走 hybrid 规则兜底)。
  //   唯一代价是名单里少 75 个"源独有、无任何活源背书"的模型名 —— 按"宁可漏判不可错判", 不收。
  {
    id: 'openrouter', name: 'OpenRouter 官方 :free',
    async fetch(cond) {
      // ── 条件请求 ──
      // 这份清单实测 791KB(未压缩), 而它是**实时源**: 内容随时会变, 不能靠"最小间隔"降频。
      // 每 30 分钟轮询一次 = 一天 38MB —— 必须靠 304 把"没变"的轮次压成几百字节。
      // 实测(2026-10-25): 带 If-Modified-Since 稳定返回 304 Not Modified, 正文零字节。
      // ⚠ 它**没有 ETag**, 只有 Last-Modified —— 所以这里认 lastModified 而不是 etag。
      const h = { accept: 'application/json', 'user-agent': 'xiaoji-free-gateway' }
      if (cond && cond.lastModified) h['if-modified-since'] = cond.lastModified
      const r = await fetchTextAuto('https://openrouter.ai/api/v1/models', h)
      if (r.status === 304) return { notModified: true, cond: { lastModified: cond.lastModified } }
      if (r.status !== 200) throw new Error(`HTTP ${r.status}`)
      const data = JSON.parse(r.text)
      const list = data.data || data.models || []
      const models = []
      for (const m of list) {
        const id = String(m.id || '')
        if (!/:free$/i.test(id)) continue                         // 只信 OpenRouter 的 :free 硬标记
        const pr = m.pricing
        if (pr && typeof pr === 'object') {                       // 双保险: :free 但 pricing 非 0 的一律不收
          const vals = ['prompt', 'completion'].map((k) => pr[k]).filter((v) => v !== undefined && v !== null && v !== '').map(Number)
          if (vals.length && !vals.every((n) => n === 0)) continue
        }
        models.push(normId(id))
      }
      // ⚠ 这里刻意**不回 date**。曾经拿"最新一个 :free 模型的 created 时间"当清单日期显示,
      // 于是仪表盘上永远写着"名单 09-10"—— 而白名单其实每天都同步成功(实测: OR 当天照常返回
      // 22 个 :free, 最新那个就是 09-10 上新的)。那个日期只是"最后一个免费模型出现的时间",
      // 不是名单版本。OpenRouter 是实时接口, 每次拉到的都是当下状态, 没有版本日期可言。
      return { date: '', live: true, cond: { lastModified: r.headers['last-modified'] || '' }, hash: textHash(r.text), hosts: models.length ? { 'openrouter.ai': { source: 'OpenRouter', models } } : {} }
    },
  },
  {
    // 厂商发现源(2026-09-19 加): mnfst 社区仓 2026-08-21 起停更, 它是唯一能贡献"多家新厂商"的源,
    // 停更后白名单实际被固化在 21 家 —— 用户反馈"厂家名单不应是固死的那些"正是这个缺口。
    // models.dev 收录 222 家 provider(带 base_url + 模型 cost + 输出模态), 按 cost 全 0 筛出
    // 58 家免费厂商 / 512 个模型, 其中 49 家是现有白名单里没有的。
    //
    // ⚠ 但它**只能当发现源, 不能当免费判定源**: 交叉验证(2026-09-19)发现它把
    //   dashscope(阿里云百炼)标了 2 个"免费", 实为新人赠送 100 万 tokens、非长期免费档;
    //   kenari.id 甚至标了 claude-sonnet-4-6 等 55 个。反过来它对 groq/mistral/cohere
    //   这些真有免费档的却没标(漏判)。所以:
    //   ① 只补"白名单里还没有的新厂商", 绝不给已收录厂商塞模型(见合并处的 discovery 守卫);
    //   ② 它是 live 源, 每次同步都是当下状态, 不提供清单版本日期。
    // 防扣费不依赖它: 新厂商只作候选展示, 用户添加后仍要过 sweepPool 全池实测, 实测不免费会被拉黑。
    // ⚠ 2026-09-25 修: 这里原来漏了 `discovery: true` —— 标记只写在了 fetch() 的**返回值**上
    //   (见下方 return 里的 discovery: true, 供合并逻辑判 provisional 用), 而上面挑 activeSources 的
    //   `WHITELIST_SOURCES.filter((s) => !(s.discovery && skipDiscovery))` 读的是**源对象**的属性,
    //   于是 s.discovery 恒为 undefined、降频永不生效: 每轮同步都把 4.7MB 拉一遍(实测直连 25s+
    //   才拿到 794KB 截断体, 耗尽 60s 超时后才回退代理), 整轮同步因此固定在 ~63s。
    //   20h 降频(DISCOVERY_MIN_MS)的注释写得很清楚, 但被这个漏标记架空了。
    id: 'modelsdev', name: 'models.dev(厂商发现)', discovery: true,
    async fetch(cond) {
      // ── 条件请求 ──
      // 实测 5,936,378 字节(≈5.9MB)。虽然它按 DISCOVERY_MIN_MS 降到约一天一次,
      // 但"发现源"的价值全在"市面上新冒出哪家免费厂商"—— 用 ETag 让"没变"的轮次
      // 只回一个 304(实测稳定), 才有底气把发现间隔从 20h 往下调。
      // ⚠ 它有 ETag 但**没有**可用的 Last-Modified, 所以认 etag。
      const h = { accept: 'application/json', 'user-agent': 'xiaoji-free-gateway' }
      if (cond && cond.etag) h['if-none-match'] = cond.etag
      // 4.7MB 的大清单, 默认 20s 不够(实测需 20~40s) —— 必须单独放宽到 60s
      const r = await fetchTextAuto('https://models.dev/api.json', h, 60000)
      if (r.status === 304) return { notModified: true, cond: { etag: cond.etag } }
      if (r.status !== 200) throw new Error(`HTTP ${r.status}`)
      const data = JSON.parse(r.text)
      const hosts = {}
      for (const p of Object.values(data || {})) {
        if (!p || !p.api) continue
        let host; try { host = new URL(p.api).hostname } catch { continue }
        // ⚠ 本地/内网地址一律不收。白名单按 base_url 的 hostname 匹配(不看端口),
        //   放进 127.0.0.1 这种会被当成真上游, 沙箱测试尤其会被污染(2026-09-19 已有教训)。
        if (!host || !host.includes('.') || LOCAL_HOST_RE.test(host)) continue
        const models = []
        for (const [mid, m] of Object.entries(p.models || {})) {
          if (!m || typeof m !== 'object') continue
          const c = m.cost
          // 必须**明确标价 0**: 没 cost 字段的一律当信息不足跳过(宁可漏判不可错判)
          if (!c || Number(c.input) !== 0 || Number(c.output) !== 0) continue
          // 必须能输出文字 —— 语音/嵌入/图像生成进了池也用不了
          const out = (m.modalities && m.modalities.output) || []
          if (!out.includes('text')) continue
          models.push(normId(mid))
        }
        // 下面的 DENY_FREE / NON_CHAT_RE 由合并处统一套, 这里不重复判
        if (models.length) hosts[host] = { source: p.name || host, models }
      }
      if (!Object.keys(hosts).length) throw new Error('未筛出任何免费厂商')
      return { date: '', live: true, discovery: true, cond: { etag: r.headers.etag || '' }, hash: textHash(r.text), hosts }
    },
  },
  {
    // 新鲜度源(2026-09-19 加): freellm.net 每天从各厂商 API 重拉 + 实时请求验证(打了 Verified
    // 徽标 = 真发过请求拿到响应), 仓库 README 里带当天日期。它只有 38KB, 比 models.dev 的
    // 4.7MB 便宜两个数量级, 所以**不降频**, 跟着白名单每 6 小时走。
    //
    // ⚠ 它的 PERMANENT_FREE 表也有误判, 判据藏在「速率限制」列里(2026-09-19 逐行核对):
    //     DeepSeek `Dynamic` / xAI `Credit-based` / 阿里 `Tiered by region` —— 这些是"列在目录里",
    //     不是免费档。所以本源**只收写明具体免费速率的条目**(见 FREELLM_RATE_OK_RE),
    //     宁可漏收也不把计费模型放进池子。
    // ⚠ 它的「无需信用卡」列**不等于**我们的 openFree: openFree 语义是"免费 key 只能看到免费模型",
    //   而 freellm 的"No"只是不用绑卡(LLM7 实测仍要 key)。所以本源一律不下 openFree 结论。
    id: 'freellm', name: 'freellm.net(每日实测)',
    async fetch(cond) {
      // ── 条件请求 ──
      // GitHub raw 支持 ETag(且不消耗 API 配额)。它只有 38KB, 省不了多少流量,
      // 但 304 能让"没变"的轮次连正文解析都跳过 —— 高频轮询时这才是主要开销。
      // ⚠ 拿不到 etag(某些代理会剥掉响应头)就退回无条件请求, 不影响功能。
      const h = { accept: 'text/plain', 'user-agent': 'xiaoji-free-gateway' }
      if (cond && cond.etag) h['if-none-match'] = cond.etag
      const r = await fetchTextAuto(FREELLM_URL, h, 30000)
      if (r.status === 304) return { notModified: true, cond: { etag: cond.etag } }
      if (r.status !== 200) throw new Error(`HTTP ${r.status}`)
      const md = r.text
      const sec = (n) => { const m = md.match(new RegExp(`<!-- BEGIN_${n} -->([\\s\\S]*?)<!-- END_${n} -->`)); return m ? m[1] : '' }
      const rows = (b) => b.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('|'))
        .map((l) => l.split('|').map((c) => c.trim())).filter((c) => c.length > 3)
      // 厂商 -> base URL(只有写了接入点才能进白名单, 光有个名字没用)
      const baseOf = {}
      for (const c of rows(sec('QUICK_REF'))) {
        const bu = (c[2] || '').match(/`([^`]+)`/)
        if (c[1] && bu) baseOf[c[1]] = bu[1]
      }
      // 厂商 -> 免费模型数(只当"有没有免费档"的闸门, 具体模型名走 BEST_MODELS)
      const freeCnt = {}
      for (const c of rows(sec('PERMANENT_FREE'))) {
        const n = parseInt(c[2], 10)
        if (c[1] && !isNaN(n)) freeCnt[c[1]] = n
      }
      // 厂商 -> 实测过的真实模型 ID(带速率列, 用来剔掉计费条目)
      const modelsOf = {}
      let lastProv = ''
      for (const c of rows(sec('BEST_MODELS'))) {
        if (c[1]) lastProv = c[1]
        const prov = lastProv
        const id = (c[3] || '').match(/`([^`]+)`/)
        if (!prov || !id) continue
        const rate = c[5] || ''
        if (FREELLM_PAID_RATE_RE.test(rate)) continue      // 计费口径(credit-based/dynamic/tiered)一律不收
        if (!FREELLM_RATE_OK_RE.test(rate)) continue       // 没写具体免费速率 = 信息不足, 不收
        ;(modelsOf[prov] = modelsOf[prov] || []).push(normId(id[1]))
      }
      const hosts = {}
      for (const [prov, cnt] of Object.entries(freeCnt)) {
        if (!cnt) continue
        const bu = baseOf[prov]
        if (!bu) continue                                   // 没接入点(如 Cline)跳过
        const ids = (modelsOf[prov] || []).filter(Boolean)
        if (!ids.length) continue                           // 免费档没被速率证据坐实 -> 不进名单
        let host; try { host = new URL(bu).hostname } catch { continue }
        if (!host || !host.includes('.') || LOCAL_HOST_RE.test(host)) continue
        hosts[host] = { source: prov, models: ids }
      }
      if (!Object.keys(hosts).length) throw new Error('未筛出任何免费厂商')
      // 取 README 里自动写的刷新日期(形如 "Last updated: 2026-09-19")当清单版本
      const dm = md.match(/Last updated:\s*(\d{4}-\d{2}-\d{2})/)
      return { date: dm ? dm[1] : '', cond: { etag: r.headers.etag || '' }, hash: textHash(r.text), hosts }
    },
  },
]

// freellm.net 的清单仓库(开源, 每日自动刷新)
const FREELLM_URL = 'https://raw.githubusercontent.com/open-free-llm-api/awesome-freellm-apis/main/README.md'
// 计费口径: 出现这些词说明它只是"列在目录里", 不是免费档。
// ⚠ 写成裸 `credit` 而非 `credit[- ]based`: 实测 xAI 的 grok-2 速率列是 "$25/month free credits"
//   —— 每月赠送额度不是免费档, 但字符串里有 "free" 会被下面的 OK 正则放行(2026-09-19 真漏过)。
// ⚠ 反过来这里**不能**写裸 `tier`: OpenRouter 的 "200 req/day (free tier)" 是真免费档, 会被误杀。
const FREELLM_PAID_RATE_RE = /(credit|dynamic|tiered|paid|top-?up|purchase|billing|see provider)/i
// 免费速率证据: 必须写明具体限额(RPM/RPD/每天/每小时)或明说 free/anonymous/fair-use/limit
const FREELLM_RATE_OK_RE = /(\d.*(rpm|rpd|req|request|day|hour|hr|min|week|token)|free|anonymous|anon|fair[- ]use|limit)/i

// 本地/内网/回环地址 —— 任何上游清单源给的 host 命中这些一律丢弃, 不能进白名单。
const LOCAL_HOST_RE = /^(localhost|127\.|0\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[::1\]|::1)/i

// "免费 plan 的 key 只能看到免费模型"型厂商 —— 可见即可用, 不锁封闭名单。
// ⚠ 2026-09-14 逐家复核政策后收缩: cerebras(7/21 取消永久免费档改 $5 试用金需绑卡)、
//   longcat(6/30 取消每日免费额度改一次性赠送+按量计费) 均已移出本集合 —— 它们的 key 视野
//   不再等于免费, 继续 openFree 会把付费模型放进池子 = 扣费风险。
// ⚠ ModelScope 不在此列: 它是「每天250魔粒」计费, 名单外的模型会消耗积分, 必须走封闭名单。
const OPEN_FREE_HOSTS = new Set([
  'api.groq.com', 'developer.amd.com.cn',
  'integrate.api.nvidia.com', 'api.kilo.ai', 'api.llm7.io', 'oai.endpoints.kepler.ai.cloud.ovh.net',
])
// 混合模式厂商: 白名单收录慢于厂商上新(gemini preview 每周都有), 名单外再用厂商公开口径的规则兜底
const HYBRID_HOSTS = new Set(['generativelanguage.googleapis.com'])
// 清单里没有、但口径明确的厂商(每日同步时手工并入白名单文件)
const MANUAL_WHITELIST = {
  'api.longcat.chat': { source: 'Meituan LongCat(2026-06 起取消每日免费额度, 一次性赠送不算常态免费)', models: [], openFree: false, force: true },
  'api.groq.com': { source: 'Groq', models: [], openFree: true },
  'api.cloudflare.com': { source: 'Cloudflare Workers AI(封闭名单, 防止烧穿 neuron 额度)', models: ['@cf/meta/llama-3.3-70b-instruct-fp8-fast', '@cf/meta/llama-4-scout-17b-16e-instruct', '@cf/openai/gpt-oss-120b', '@cf/google/gemma-4-26b-a4b-it', '@cf/zai-org/glm-4.7-flash', '@cf/mistralai/mistral-small-3.1-24b-instruct', '@cf/deepseek-ai/deepseek-r1-distill-qwen-32b', '@cf/meta/llama-3.1-8b-instruct'], openFree: false },
  // ModelScope: 每天 250 魔粒额度制, 名单外模型照样扣魔粒甚至转收费 -> 必须封闭名单(与上方注释一致)
  'api-inference.modelscope.cn': { source: 'ModelScope', models: [], openFree: false },
  'integrate.api.nvidia.com': { source: 'NVIDIA NIM', models: [], openFree: true },
  // AMD 端点元数据实测: output=["ocr"] 的 MinerU 会被 NON_CHAT_RE 排除; 聊天模型靠 openFree 视野放行
  'developer.amd.com.cn': { source: 'AMD Radeon Cloud', models: ['DeepSeek-V4-Flash', 'DeepSeek-V4-Flash-Vision-Exp', 'MiniCPM5-2B', 'Qwen3.8-Flash-Next'], openFree: true },
  // Cerebras: 2026-07-21 起取消永久免费档(改 $5 一次性试用金, 需绑支付方式) -> 转封闭名单口径,
  // models 留空 = 名单外一律不进池; force 覆盖社区源(该源仍把它标为 openFree, 是错的)。
  // 若日后实测某模型确认可免费调用再手工加回 models。
  'api.cerebras.ai': { source: 'Cerebras Cloud(2026-07 起无永久免费档, 封闭名单)' , models: [], openFree: false, force: true },
  // Empero: 德国研究实验室的免Key公益端点, 不扣钱但 prompt 会被脱敏记录用于训练开源模型。
  // ⚠ 2026-09-21 实测该端点已换模型: /v1/models 现在只返回 `Qwen/Qwen3.8-27B-FP8`
  //   (别名 free / qwen3.8-27b-fp8 / ridge), 旧的 glm-5.3-flash 一律 404 model_not_found。
  //   名单跟着改成实测 id —— 名单写错名字的代价不是"漏判", 而是这家永远 404 空转:
  //   isFree 认不出任何模型 -> 扫描 total=0 -> 池子里却还留着旧名字 -> 每条请求都撞 404。
  //   官方换模型频繁, 这是必然事件; 靠 accountIssue + 每日复审兜底(见 markFail/scanProvider)。
  //   force=true: 防社区源日后收录时误标 openFree(参考 cerebras 教训)。
  'free.empero.org': { source: 'Empero 公益端点(免Key, prompt会被记录训练; 封闭名单)', models: ['Qwen/Qwen3.8-27B-FP8'], openFree: false, force: true },
  // 商汤 SenseNova Token Plan: 公测期 0 元/月(手机号注册免绑卡), 三模型每5小时 1500/1500/150~500 次独立计量。
  // 社区清单未收录 -> force 手工口径; 公测无截止日期, 正式版将商业化, 届时靠 401/403/quota 错误分类自动出池。
  // ⚠ 2026-09-21 修正: 这里原先写的是**文档页上的中文名**(`SenseNova U1 Fast` 之类), 而 isFree 是拿
  //   `normId(modelId)` 精确比对的 —— 中文名永远匹配不上真实 id, 结果是"名单写着 3 个, 实际一个都放不进来",
  //   仪表盘上表现为「名单 3」和「不在免费池 8」自相矛盾。现在改用**从端点 /v1/models 真实观测到的 id**。
  'token.sensenova.cn': { source: '商汤日日新 Token Plan(公测免费, 未绑卡=无扣费通道)', models: ['sensenova-6.7-flash-lite', 'sensenova-6.8-flash-lite', 'sensenova-u1-fast', 'sensenova-u1.5-fast', 'sensenova-u1.5-lite', 'deepseek-v4-flash', 'glm-5.2', 'kimi-k3'], openFree: false, force: true },
  // 以下两家原先只由 mnfst 源贡献。该源 2026-08-21 停更、2026-09-25 被移除，而这两家
  // 都没出现在 freellm / models.dev 里 —— 所以按手工名单接手，白名单不缩水。
  // 模型 id 取自移除前白名单里的**实际观测值**（不是文档页上的展示名，见上方 SenseNova 教训）。
  // openFree 保持 false：这两家的 /v1/models 会列出收费模型，只能走封闭名单。
  // ⚠ source 字符串会**原样显示在仪表盘的厂商目录里** —— 所以只写厂商名，别的都别塞。
  //   2026-09-25 修正：原来写的是「Mistral AI(手工名单)」/「Hugging Face(手工名单)」，
  //   "手工名单" 对用户同样是内部黑话（和 mnfst 一样会被问"那是啥"），已去掉。
  //   "这份名单不会自动更新" 这件事如果要提示，该挂在白名单新鲜度那一行，不该塞进厂商名。
  'api.mistral.ai': { source: 'Mistral AI', models: ['codestral-2508', 'ministral-14b-2512', 'ministral-3b-2512', 'ministral-8b-2512', 'mistral-large-2512', 'mistral-medium-3-5', 'mistral-small-2603'], openFree: false },
  'router.huggingface.co': { source: 'Hugging Face', models: ['Qwen/Qwen2.5-Coder-7B-Instruct', 'Qwen/Qwen2.5-7B-Instruct', 'google/gemma-3-4b-it', 'meta-llama/Llama-3.1-8B-Instruct', 'microsoft/phi-4'], openFree: false },
}

// openFree 否决表: 上游源标了 openFree、但实测不满足前提的厂商, 一律按封闭名单处理。
// openFree 的语义是"该厂商的 Key 看不到收费模型"(Groq 免费 plan 确实如此), 放行名单外模型才安全。
// 2026-09-18 逐家实测 /v1/models 后发现这几家不成立 —— 它们会把付费模型一起列出来:
//   · api.kilo.ai              379 个模型中 348 个定价>0、8 个负定价(聚合了上游全量, 调用真扣费)
//   · integrate.api.nvidia.com 82 个模型全部没有 pricing 字段 -> metaIsFree 只能返回 null
//   · api.llm7.io              47 个模型同样无 pricing
// 后两家的 meta 判不出收费(null), 若保留 openFree 就会被无条件判成"免费" —— 静默扣费口子。
// 关闭后这些厂商仍可用, 只是只走每日同步的封闭名单(白名单内的免费模型照常进池, 不误伤)。
// ⚠ 新增厂商进 OPEN_FREE_HOSTS 前, 先确认它的 /v1/models 不会返回付费模型。
const OPEN_FREE_DENY = new Set([
  'api.kilo.ai',
  'integrate.api.nvidia.com',
  'api.llm7.io',
])

let _whitelist = null
let _wlMtime = 0
function loadWhitelist() {
  // 按 mtime 感知外部修改(每日同步写盘/手工订正), 避免缓存旧名单
try {
      const st = fs.statSync(WHITELIST_PATH)
      if (_whitelist && st.mtimeMs === _wlMtime) return _whitelist
      _whitelist = JSON.parse(fs.readFileSync(WHITELIST_PATH, 'utf8'))
      _wlMtime = st.mtimeMs
    // 在这里(而不是只在每日同步时)套否决表: 名单文件可能被手工改过、或同步这轮还没跑,
    // 每次读取都修正一遍, 保证 isFree 拿到的 openFree 口径永远是对的。
    if (_whitelist && _whitelist.hosts) {
      for (const h of OPEN_FREE_DENY) if (_whitelist.hosts[h]) _whitelist.hosts[h].openFree = false
    }
    // 巡检剔除(2026-09-19): 上游源声明的免费模型, 若在该厂商端点真实的 /models 里**根本
    // 不存在**, 每次读取都剔掉。挂在读取而不是只在巡检时改一次 —— 否则下一轮每日同步
    // 会把源的原话原样加回来, 剔除白做。用户原话: "不能它写什么我们就信什么"。
    // 方向是宁可漏判: 端点自己列出的模型表才是权威, 源多写的那些一律不收。
    if (_whitelist && _whitelist.hosts && _whitelist.probe) {
      const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '')
      for (const [h, pr] of Object.entries(_whitelist.probe)) {
        const e = _whitelist.hosts[h]
        if (!e || !e.models || !pr || !(pr.missing || []).length) continue
        const drop = new Set((pr.missing || []).map(norm))
        const before = e.models.length
        e.models = e.models.filter((m) => !drop.has(norm(m)))
        if (e.models.length !== before) e.trimmed = before - e.models.length
      }
    }
  } catch (e) {
    // 白名单文件缺失是正常的(首次启动还没同步); 但"文件在、却读不出来"必须留痕,
    // 否则 isFree 会静默退化成"什么都判不免费", 表现为整个池子空了却查不出原因。
    if (fs.existsSync(WHITELIST_PATH)) console.warn('[whitelist] 读取失败:', (e && e.message) || e)
    else _whitelist = null
  }
  return _whitelist
}
function saveWhitelist(w) {
  _whitelist = w
  writeJsonAtomic(WHITELIST_PATH, w)
}

// 名单巡检周期(小时)。白名单同步是 6 小时, 巡检跑一天一次就够 —— 端点存亡和模型增删
// 不会在几小时内变, 而它是"零 Key 的旁证", 频次再高也只是多打一堆 401。
//
// ⚠ 2026-10-18 改成 6 小时, 用户原话: "白名单的厂家项目需要自动测试自动添加, 不要等我"。
//   24 小时一次意味着"今天新冒出来的免费端点要等到明天才可能进池", 而白名单源每 6 小时就会
//   变一轮 —— 巡检比它慢 4 倍, 候选池就永远在追上一轮的旧账。改成与白名单同步同频(6h)。
//   代价实测可接受: 53 家候选一轮约 4 分钟(mapLimit 4 并发), 一天 4 轮。
const PATROL_INTERVAL_H = 6

// ── 实时采集的节奏（2026-10-25）──
// 目标: "新免费厂商 / 新免费模型"最多半小时内被发现, 而**打上游的请求量不增**。
// 做到这一点的关键不是"扫得更勤", 而是分层 ——
//   · 源层(OpenRouter / models.dev / freellm)是静态 JSON, 支持条件请求: 没变就回 304(几百字节),
//     所以可以 30 分钟一轮;
//   · 上游厂商层(/v1/models)会被限流, 只在"源真的变了"或到了兜底周期才扫。
// 反过来说: 若去掉条件请求, 30 分钟一轮就是一天 38MB(OpenRouter 单次 791KB) + 每半小时把
// 已接入厂商全打一遍 —— 那是"看起来实时, 实际在被厂商限流"。
const WHITELIST_SYNC_MS = 30 * 60 * 1000
// 目录扫描(打上游 /v1/models)的兜底周期。白名单有实质变动时会立刻提前触发(见同步末尾),
// 这个定时器只负责"源一直没变、但厂商自己上新了模型"这种情况 —— 那种变化源里根本看不到。
// 30 分钟是有意的: 它扫的是**已接入**的几家(通常 5~15 家), /v1/models 是很轻的请求。
// 若某家对 /v1/models 也限流, 把这里调大即可: 这条独立于白名单同步, 改它不影响实时性主路径。
const CATALOG_REFRESH_MS = 30 * 60 * 1000

// 免 Key 端点转正时, 单家最多收多少个模型。
// 为什么需要上限: 聚合器(实测 nano-gpt 列出 622 个、llmgateway 296 个)一旦免 Key 可调用,
// 不加限就会把 auto 池一次撑爆 —— 池子大小直接决定目录扫描耗时与路由选择成本。
const ANON_MODEL_CAP = 40

// 每家候选最多试几个模型(免 Key 调通即转正)。
// ⚠ 2026-10-18 由 3 提到 8: 原来只试前 3 个聊天模型, 而端点往往"前几个模型要 Key、后面某个
//   免 Key"(实测今天的巡检结果: 可匿名列模型 7 家, 只有 1 家试出可调用)。试 3 个等于把
//   后面那些本来能转正的端点判死, 用户看到的就是"候选一直不涨"。
//   顺序上优先"名字像免费档"的模型(free/flash/lite/mini/turbo), 提高命中率。
const ANON_PROBE_TRIES = 8
const FREE_HINT_RE = /(^|[-_/:.])(free|flash|lite|mini|small|turbo|nano|fast|instant)([-_/:.]|$)/i

// 名单巡检(2026-09-19 用户要求: "虽然你拉了 freellm 的, 但是每个都还要经过每天实测的,
// 不能它写什么我们就信什么")。
//
// 已配置的 7 家由 sweepPool 做全池实测(拿真实响应判定免费), 这里只管**没配 Key 的**厂商:
// 没有 Key 就**无法证明**某家免费, 但可以**证伪** ——
//   ① 端点连不通 / 返回的不是 JSON  -> endpoint_dead: 名单上写的"免费"是空头支票
//   ② 端点要 Key(401/403)          -> needs_key: 端点活着, 但免费与否仍只是源的声称
//   ③ 端点能匿名列出模型            -> 拿真实模型表交叉核对, 源声明却查无此模型的**剔除**
// 结果按 host 存进 free_whitelist.json 的 probe 字段(由 loadWhitelist 每次读时套用剔除),
// 仪表盘据此显示"实测结论", 用户能一眼看出哪些是真跑过、哪些只是抄来的。
// 无 Key 探测一个"模型列表"端点。返回 state:
//   listed     = 匿名就能列出模型(证据最强, 可交叉核对源声明)
//   needs_key  = 401/403, 端点活着但要 Key(证明厂商真实存在, 免费与否仍只是源的说法)
//   exists     = 端点活着(405/400/5xx), 但**不提供模型列表**接口。厂商真实存在, 只是没法交叉核对模型名
//   no_list    = 其它状态码(404…)。⚠ 只说明"这些路径都没有模型列表", **不能说厂商死了**
//   unreachable= 连不通 / 不是 HTTP
async function probeBaseModels(base) {
  try {
    const r = await fetchTextAuto(base + '/models', { accept: 'application/json', 'user-agent': 'xiaoji-free-gateway' }, 12000)
    if (r.status === 200) {
      let arr = null, isJson = true
      try { const j = JSON.parse(r.text); arr = Array.isArray(j) ? j : (j.data || j.models || []) } catch { isJson = false }
      if (Array.isArray(arr) && arr.length) {
        const live = arr.map((x) => (typeof x === 'string' ? x : (x.id || x.model || ''))).filter(Boolean)
        return { state: 'listed', detail: '', live }
      }
      // ⚠ 200 但**返回的不是 JSON** 不能算"端点活着要 Key" —— 那是打到了官网页面。
      //   实测 zenmux.ai/models 返回 200 HTML, 过去会被读成"需 Key", 于是提前停止探测,
      //   错过了真正的 API 路径 zenmux.ai/api/v1(返 401)。必须区分开。
      if (!isJson) return { state: 'no_list', detail: 'HTTP 200 但返回的不是 JSON（疑似官网页面, 不是 API）' }
      return { state: 'needs_key', detail: 'HTTP 200 但无模型列表' }
    }
    if (r.status === 401 || r.status === 403) return { state: 'needs_key', detail: `HTTP ${r.status}` }
    return { state: 'no_list', detail: `HTTP ${r.status}` }
  } catch (e) {
    return { state: 'unreachable', detail: String((e && e.message) || e).slice(0, 60) }
  }
}
// 依次试多条路径。只有探到 `listed`(最强证据)才提前收工; `needs_key` 只当**备选**记下来继续找 ——
// 否则一条"看起来活着但不是真 API"的路径会让我们提前停止, 错过后面真正的接入点(zenmux 那次)。
// ⚠ 为什么要试多条(2026-09-22 实测踩到): 源里只有 hostname, 我们过去一律拼 `/v1/models`,
//   于是把"路径猜错"误报成"端点不通/没有模型列表"。实测 token-plan.cn-beijing.maas.aliyuncs.com
//   在 /v1/models 返 404, 换 /compatible-mode/v1/models 就返 401(端点明明活着)。
//   apiBase 一并回传 —— 仪表盘据此回填**能用的** base_url, 而不是继续猜 /v1。
// 路径列表(按"命中概率 × 代价"排)。`/coding/v1` 是 2026-09-22 实测加进来的:
//   api.kimi.com 在常见 5 条路径全 404, 但 `/coding/v1/models` 返 401 —— Kimi 的编程套餐就在这个前缀下。
const PROBE_PATHS = ['/v1/models', '/models', '/api/v1/models', '/openai/v1/models', '/compatible-mode/v1/models', '/coding/v1/models', '/api/models']
// 源里的"免费变体"后缀: 数据源常用 `:free` / `-free` / `:online` 标免费档, 而端点 /models 里
// 只有基名。不剥掉就会把"同一个模型的免费档"误判成"端点查无此模型" —— 实测 Requesty 声明的
// 11 个**全部**中招、Poe 的 3 个全中招, 会平白把好人报成"数据不准"。
// ⚠ 剥掉后比较是**更宽松**的口径: 只证明"这个模型家族在端点上存在", 不证明免费档还在 ——
//   对 hosts 侧(探到 listed 会真删模型)这正是要的"宁可漏判不可错判"。
const FREE_VARIANT_RE = /[:@_-]?(free|online|basic|trial)$/i
const stripFreeVariant = (s) => String(s || '').replace(FREE_VARIANT_RE, '')
async function probeModelsEndpoint(bases) {
  let best = null, last = { state: 'unreachable', detail: '未探测' }, saw404 = false
  for (const base of bases) {
    const r = await probeBaseModels(base)
    if (r.state === 'listed') return Object.assign({}, r, { apiBase: base })
    if (r.state === 'needs_key') { if (!best) best = Object.assign({}, r, { apiBase: base }); continue }
    if (/HTTP 404/.test(r.detail || '')) saw404 = true
    last = r
  }
  if (best) return best
  // 模型列表一条都没探到 —— 再问一次"这个端点到底活着吗"。
  // ⚠ 为什么需要这一步(2026-09-22 实测): 有些 OpenAI 兼容网关**根本不实现 `GET /models`**,
  //   但 `/chat/completions` 是活的。只探模型列表就会把它们一律塞进"接入点待确认"，
  //   而那一档的语义是"名单上的 host 可能是空头支票" —— 对它们来说是**误判**。
  //   实测: apis.iflow.cn 的 `/v1/chat/completions` 返 405(路径在, 只是不收 GET);
  //         api.nova.amazon.com 的 `/v1/chat/completions` 返 500。
  const lv = []
  for (const base of bases) {
    const l = await probeBaseLiveness(base, saw404)
    if (l) lv.push(Object.assign({}, l, { apiBase: base }))
  }
  const nk = lv.find((x) => x.state === 'needs_key')     // 401/403 证据最强, 优先
  if (nk) return nk
  if (lv.length) return lv[0]
  return last
}
// 端点存活探测: 只看 `/chat/completions` 的**状态码**, 不发有效载荷(拿不到 200 也无所谓)。
//   401/403 = 明确要 Key; 400/405 = 路径存在(只是不接受 GET / 参数不对);
//   5xx 只在**同一轮见过 404** 时才算 —— 否则一个"对任何路径都 500"的坏网关会被误判成"厂商存在"
//   (钱袋子原则: 宁可漏判, 不可错判)。判不了就返回 null, 不硬凑结论。
async function probeBaseLiveness(base, saw404) {
  try {
    const r = await fetchTextAuto(base + '/chat/completions', { accept: 'application/json', 'user-agent': 'xiaoji-free-gateway' }, 12000)
    const s = r.status
    if (s === 401 || s === 403) return { state: 'needs_key', detail: `HTTP ${s}（/chat/completions）` }
    if (s === 400 || s === 405) return { state: 'exists', detail: `HTTP ${s}（/chat/completions 路径存在, 但不收 GET）` }
    if (s >= 500 && saw404) return { state: 'exists', detail: `HTTP ${s}（同轮其它路径返 404, 说明该服务认得路径）` }
    return null
  } catch { return null }
}

// ── 匿名可调用实测(2026-09-30 加) ────────────────────────────────────────────
// 为什么必须有这一步:
//   `/models` 能匿名列出, 只说明"这个端点不校验**读**权限"; 真正决定能不能用的是
//   `/chat/completions` 免 Key 调不调得通。调通 = 该端点对匿名开放
//   = **我们手上没有账号 = 根本没有扣费通道** —— 这是唯一能零风险扩容的通道。
//   有账号的厂商永远只能说"源声称免费"(它的闸门是 sweepPool 全池实测);
//   免 Key 厂商则是"实测即证明", 与钱袋子原则不冲突: 它压根没有钱袋子。
// ⚠ 判据刻意严格: 必须 HTTP 200 **且** choices[0].message.content 非空。
//   401/402/403/429/5xx 一律不算 —— 429 尤其不能读成"可用", 那是被限流而非被允许。
// ⚠ 实测踩到(2026-09-30): OVH(oai.endpoints.kepler.ai.cloud.ovh.net) 的 /models 匿名列出
//   24 个模型、VENDOR_DIR 里也早写着"免 Key 匿名 2 RPM", 但它一直躺在 candidates 里 ——
//   OPEN_FREE_HOSTS 标了它, 而 openFree 只在 whitelistFor() 命中时才会被读到,
//   不在 hosts 里就等于这个标记**从未生效**。24 个免费模型(含 gpt-oss-120b)白躺。
function httpPostText(u, headers, body, timeoutMs, agent) {
  return new Promise((resolve, reject) => {
    const mod = u.protocol === 'https:' ? https : http
    const total = timeoutMs || 20000
    const payload = Buffer.from(String(body || ''), 'utf8')
    let timer
    const r = mod.request({
      hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search, method: 'POST', agent,
      headers: Object.assign({ 'content-length': payload.length }, headers || {}),
    }, (res) => {
      // 与 httpGetText 同样把 timer 续成"响应体超时": 否则响应体读取没有超时保护
      clearTimeout(timer)
      timer = setTimeout(() => r.destroy(new Error('POST 响应体读取超时')), total)
      readBody(res, 256 * 1024)
        .then((t) => { clearTimeout(timer); resolve({ status: res.statusCode, text: t, headers: res.headers }) })
        .catch((e) => { clearTimeout(timer); reject(e) })
    })
    timer = setTimeout(() => r.destroy(new Error('POST 超时')), total)
    r.on('error', (e) => { clearTimeout(timer); reject(e) })
    r.end(payload)
  })
}
async function postTextAuto(urlStr, headers, body, timeoutMs) {
  const u = new URL(urlStr)
  const t = Number(timeoutMs) > 0 ? Number(timeoutMs) : 15000
  try { return await httpPostText(u, headers, body, t) }
  catch (e1) {
    if (!CFG.proxy) throw e1
    return httpPostText(u, headers, body, Math.max(t, 20000), getTunnelAgent(CFG.proxy))
  }
}
// 不带任何 Key 发一条最小 chat 请求。tryList = 取自端点**真实列出**的模型 id(优先聊天模型)。
// 逐个试到成功为止(有些端点只对部分模型开放匿名)。返回 { ok, status, model, detail }。
async function probeAnonChat(base, tryList) {
  const list = (tryList || []).filter(Boolean).slice(0, ANON_PROBE_TRIES)
  if (!list.length) return { ok: false, status: 0, detail: '端点未列出可用于试探的聊天模型' }
  let last = { ok: false, status: 0, detail: '未试' }
  let authFails = 0   // 连续"要鉴权"的模型数, 达到 3 判定整家需 Key(见下方 401/403 分支)
  for (const m of list) {
    try {
      const body = JSON.stringify({ model: m, messages: [{ role: 'user', content: 'hi' }], max_tokens: 1 })
      const r = await postTextAuto(base + '/chat/completions',
        { 'content-type': 'application/json', accept: 'application/json', 'user-agent': 'xiaoji-free-gateway' }, body, 15000)
      // ⚠ 2026-10-18: 401/403/429 的处理要分开看, 不能一刀切 continue 或一刀切 break。
      //   · 429 = 端点限流, 继续试只会更糟 -> 立即停手。
      //   · 401/403 = 这个模型要鉴权。**不能立即停**: 有些端点对部分模型开放匿名
      //     (免 Key 的 flash 能调、premium 要 Key), 一刀切 break 会把这类端点判死。
      //     但也不能一路试满 8 个 —— 实测当天 18 家"可匿名列模型"的候选全是 401/403,
      //     盲试会让巡检从 3 分钟涨到 8.5 分钟, 白打几百个注定失败的请求。
      //     折中: 连续 3 个都要鉴权就认定"整家需 Key", 停手。
      if (r.status === 429) {
        return { ok: false, status: 429, detail: 'HTTP 429（端点已限流，停止后续试探）' }
      }
      if (r.status === 401 || r.status === 403) {
        authFails++
        last = { ok: false, status: r.status, detail: `HTTP ${r.status}` }
        if (authFails >= 3) {
          return { ok: false, status: r.status, detail: `HTTP ${r.status}（连续 3 个模型都要鉴权，判定端点需 Key，停止后续试探）` }
        }
        continue
      }
      if (r.status !== 200) { last = { ok: false, status: r.status, detail: `HTTP ${r.status}` }; continue }
      let j = null
      try { j = JSON.parse(r.text) } catch { last = { ok: false, status: 200, detail: 'HTTP 200 但响应不是 JSON' }; continue }
      const c = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content
      if (typeof c === 'string' && c.trim()) return { ok: true, status: 200, model: m, detail: '匿名调用成功（无 Key 返回 200 且有内容）' }
      last = { ok: false, status: 200, detail: 'HTTP 200 但 content 为空' }
    } catch (e) {
      last = { ok: false, status: 0, detail: String((e && e.message) || e).slice(0, 60) }
    }
  }
  return last
}
// 从端点列出的真实模型表里挑"能拿来试探"的: 优先聊天模型, 排掉硬排除表命中的。
const anonProbePick = (live) => (live || [])
  .filter((x) => x && modelRouteType(x, null).chat && !DENY_FREE.some((re) => re.test(String(x))))
  .map((x, i) => ({ x, i, hint: FREE_HINT_RE.test(String(x)) ? 1 : 0 }))
  .sort((a, b) => (b.hint - a.hint) || (a.i - b.i))
  .slice(0, ANON_PROBE_TRIES)
  .map((o) => o.x)

// 把"免 Key 实测通过"的端点并入正式名单。
// 抽成纯函数(不碰网络/文件)是为了能单独测 —— 这段直接决定"谁进池", 属于钱袋子路径。
// 语义: 已在名单里的只补 anon 标记(不覆盖它的模型表); 新转正的建条目; 两者都从候选区移除。
function applyAnonPromotions(hosts, candidates, anonPromote, at) {
  let promoted = 0
  for (const [h, v] of Object.entries(anonPromote || {})) {
    const prev = hosts[h]
    if (prev) {
      prev.anon = true; prev.anonAt = at; prev.anonModel = v.anonModel
    } else {
      hosts[h] = {
        source: v.source || h,
        models: (v.models && v.models.length) ? v.models : [],
        openFree: false, hybrid: false,
        anon: true, anonAt: at, anonModel: v.anonModel,
      }
      promoted++
    }
    // 转正后必须从候选区移除 —— 否则同一家会同时出现在"正式名单"和"候选"两处,
    // 仪表盘上看起来像两家(OVH 这种"两个名单都有"的就会撞上)。
    if (candidates && candidates[h]) delete candidates[h]
  }
  return promoted
}

// ── 代理可达性探测(60s 缓存) ──────────────────────────────────────────────
// 为什么值得单独探一次: 上游清单源里必须走代理的那几个(OpenRouter / freellm), 代理没开时
// 一律 ECONNREFUSED —— 而界面只会显示"部分源拉取失败", 用户看到的是"网关坏了"。
// 实测这是最高频的失败原因(2026-09-30 复现: 3 个源里 2 个失败, 原因全是环回代理地址拒连),
// 而红线里早就写着"用户报目录全是失败, 第一件事是看代理在不在听" —— 那就不该让用户自己去猜。
// 与其让人从 ECONNREFUSED 里读, 不如直接把"代理没在听"说出来。
let _proxyAlive = { at: 0, ok: null, addr: '' }
async function probeProxyAlive() {
  if (!CFG.proxy) return { configured: false, ok: null, addr: '' }
  const raw = String(CFG.proxy)
  if (Date.now() - _proxyAlive.at < 60000 && _proxyAlive.addr === raw) {
    return { configured: true, ok: _proxyAlive.ok, addr: raw }
  }
  let host = ''
  let port = 0
  try {
    const u = new URL(/^[a-z]+:\/\//i.test(raw) ? raw : 'http://' + raw)
    host = u.hostname
    port = Number(u.port || (u.protocol === 'https:' ? 443 : 80))
  } catch { return { configured: true, ok: null, addr: raw, error: '代理地址无法解析' } }
  // 只做 TCP 连通性判断, 不发任何 HTTP 请求 —— 目的是回答"端口在不在听", 不是"代理能不能翻墙"。
  const ok = await new Promise((resolve) => {
    const s = net.connect({ host, port, timeout: 1500 })
    const done = (v) => { try { s.destroy() } catch {} ; resolve(v) }
    s.on('connect', () => done(true))
    s.on('error', () => done(false))
    s.on('timeout', () => done(false))
  })
  _proxyAlive = { at: Date.now(), ok, addr: `${host}:${port}` }
  return { configured: true, ok, addr: `${host}:${port}` }
}

async function patrolWhitelist() {
  // 沙箱短路: 别在测试里打真上游(与 syncUpstreamWhitelist 同样处理)
  try {
    if (fs.existsSync(path.join(process.cwd(), '.sandbox')) || fs.existsSync(path.join(__dirname, '.sandbox'))) return
  } catch {}
  // ⚠ 必须等同步跑完: 同步会重建 hosts(把源的原话写回), 巡检若在它之前动手,
  //   读到的还是上一轮的表 —— 实测启动 20s 巡检 vs 启动同步撞车, NVIDIA 剔到 8 个
  //   又被写回 14 个, 白跑一轮。这里最多等 2 分钟。
  for (let i = 0; i < 24 && _wlSyncing; i++) await new Promise((r) => setTimeout(r, 5000))
  if (_wlSyncing) { console.warn('[patrol] 白名单同步迟迟未完, 本轮巡检跳过'); return }
  const wl = loadWhitelist()
  if (!wl || !wl.hosts) return
  const configured = new Set()
  for (const p of CFG.providers || []) {
    try { const h = new URL(normalizeBaseUrl(p.base_url)).hostname; if (h) configured.add(h) } catch {}
  }
  const at = new Date().toISOString()
  const probe = Object.assign({}, wl.probe)
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '')
  let dead = 0, keyed = 0, listed = 0, trimmedHosts = 0, trimmedModels = 0, anonOk = 0
  const drops = {}   // host -> Set(归一化后的待剔除模型名), 落盘前要重新套一遍(见下方竞态说明)
  for (const [host, entry] of Object.entries(wl.hosts)) {
    if (configured.has(host)) continue                 // 已配置的走 sweepPool 全池实测, 不重复
    const claimed = (entry && entry.models) || []
    if (!claimed.length) continue
    const dir = VENDOR_DIR[host]
    const base = String((dir && dir.base_url) || `https://${host}/v1`).replace(/\/+$/, '')
    // ⚠ 接入点带占位符的(如 Cloudflare 的 <ACCOUNT_ID>)根本没法探测 —— 硬探只会拿到 405,
    //   然后被误报成"端点不通"。这类直接跳过, 别给它下任何结论。
    if (/<[A-Z_]+>/.test(base)) { probe[host] = { at, state: 'skip', detail: '接入点含占位符, 无法探测' }; continue }
    // ⚠ hosts 侧**只用配置好的那一条 base_url**(VENDOR_DIR 里人工核实过), 不试替代路径 ——
    //   因为这里探到 listed 会**真删模型**(见下面的 missing 逻辑), 换一条路径去核对就等于用
    //   另一个端点给白名单下结论, 有误删"真免费模型"的风险。多路径只用在候选侧(候选不删模型)。
    // ⚠ 404/405/522… 一律记 `no_list` 而**不是**"端点不通": 实测 ollama.com / ai21 的 404
    //   只是 /models 路径不对, 厂商活得好好的 —— 断言它死了是谎报状态。
    const pr0 = await probeBaseModels(base)
    const state = pr0.state, detail = pr0.detail, live = pr0.live || null
    // 端点能列出模型 -> 拿它当权威, 核对源声明的 ID
    let missing = []
    if (live) {
      listed++
      // ⚠ 只有当端点列的模型**不少于**源声明的数量时, "查无此模型"才算是证据 ——
      //   若端点只列了 4 个而源声明 7 个, 大概率是端点分页/只列部分, 据此剔除是冤枉好人
      //   (实测 aionlabs 就属这种)。拿不动的刀别硬削, 这种只标记不删。
      if (live.length >= claimed.length) {
        const liveSet = new Set(live.map((x) => norm(stripFreeVariant(x))))
        missing = claimed.filter((m) => !liveSet.has(norm(stripFreeVariant(m))))
        if (missing.length) {
          trimmedHosts++; trimmedModels += missing.length
          // 直接改写 hosts 里的模型表, 让文件与运行时口径一致(loadWhitelist 里的过滤是兜底)
          entry.models = claimed.filter((m) => !missing.includes(m))
          drops[host] = new Set(missing.map(norm))
        }
      }
    }
    // 匿名可调用实测: 端点能匿名列出模型时才试(它至少不校验读权限, 有戏)。
    // 调通 -> 该端点免 Key 可用; 这条记录会被 judgeFree 当作"实测证明"读(见 anonFree 出口)。
    let anon = null
    if (state === 'listed' && live && live.length) {
      anon = await probeAnonChat(base, anonProbePick(live))
      if (anon.ok) { anonOk++; console.log(`[patrol] ${host}: 免 Key 实测可调用（试通模型 ${anon.model}）`) }
    }
    probe[host] = { at, state, detail, listedCount: live ? live.length : 0, missing: missing.slice(0, 30), missingCount: missing.length, unverifiable: !!(live && live.length < claimed.length), anon: anon ? { ok: anon.ok, model: anon.model || '', detail: anon.detail } : undefined }
    if (state === 'unreachable') dead++
    else if (state === 'needs_key') keyed++
  }

  // ── 候选厂商无 Key 巡检(2026-09-22 新增) ──
  // 起因(用户): "候选的厂家为什么你不测试呢, 必须得我提供 key?"
  // 属实是缺口: 上面那个循环只走 wl.hosts(封闭名单), 47 家候选**从来没验过**,
  // 面板上只有一个名字 —— 用户没法判断"信子准吗", 而这正是他最初的问题。
  // 不用 Key 也能测出很多(实测 47 家 × 多路径, 全程无 Key):
  //   9 家能匿名列出模型 · 21 家端点确认活着但要 Key · 17 家所有路径都不通。
  // 能匿名列模型的那批还能**交叉核对源声明** —— 实测 kenari.id 源声明 52 个里 9 个端点查无
  //   (deepseek-v4-flash:free / gemini-3-5-flash / glm-5-1 …), 正好证实了它的"数据可疑"。
  // ⚠ 与 hosts 的关键区别: 候选**只记录、不删模型**。候选不参与路由与免费判定, 删了没有安全收益,
  //   反而会让"候选 N 家"悄悄缩水; 把"源声明 N 个 / 端点查无 M 个"如实摆出来更有用。
  const candEntries = Object.entries(wl.candidates || {})
    .filter(([h, v]) => ((v && v.models) || []).length > 0 && !configured.has(h))
  let candListed = 0, candKeyed = 0, candExists = 0, candBad = 0, candTrimmed = 0, candAnonOk = 0
  // host -> 待转正的免 Key 端点(只有**实测调通**的才会写进来), 落盘时并入 hosts
  const anonPromote = {}
  await mapLimit(candEntries, 4, async ([host, entry]) => {
    const claimed = (entry && entry.models) || []
    // 候选没有 VENDOR_DIR 条目, base_url 只能靠探: 把常见路径都试一遍
    const bases = PROBE_PATHS.map((p) => `https://${host}${p.replace(/\/models$/, '')}`)
    const r = await probeModelsEndpoint(bases)
    let missing = [], unverifiable = false, anon = null
    if (r.state === 'listed' && Array.isArray(r.live)) {
      candListed++
      // 与 hosts 同一条判定: 端点列的模型**不少于**源声明时才敢说"查无此模型"
      // (端点分页/只列部分时, 据此剔除是冤枉好人 —— 那种只标 unverifiable)
      if (r.live.length >= claimed.length) {
        const liveSet = new Set(r.live.map((x) => norm(stripFreeVariant(x))))
        missing = claimed.filter((m) => !liveSet.has(norm(stripFreeVariant(m))))
        if (missing.length) candTrimmed++
      } else unverifiable = true
      // ── 免 Key 实测 -> 自动转正(本模块唯一的"零风险扩容"通道) ──
      // 免 Key = 无账号 = 无扣费通道, 所以实测调通即可直接进正式名单。
      // ⚠ 有 Key 的候选**永远不能**自动转正 —— 源声称的免费不构成证据,
      //   必须等用户接入后由 sweepPool 全池实测(那条路径才碰得到钱袋子)。
      anon = await probeAnonChat(r.apiBase || `https://${host}/v1`, anonProbePick(r.live))
      if (anon.ok) {
        candAnonOk++
        // 模型取端点**真实列出**的聊天模型, 上限 ANON_MODEL_CAP —— 防止聚合器
        // (实测 nano-gpt 列出 622 个、llmgateway 296 个)把池子一次撑爆。
        const pick = r.live.filter((x) => x && modelRouteType(x, null).chat && !DENY_FREE.some((re) => re.test(String(x))))
        anonPromote[host] = { source: (entry.source || host), models: pick.slice(0, ANON_MODEL_CAP), anonModel: anon.model || '' }
      }
    } else if (r.state === 'needs_key') candKeyed++
    else if (r.state === 'exists') candExists++
    else candBad++
    probe[host] = {
      at, state: r.state, detail: r.detail || '',
      apiBase: r.apiBase || '',                     // 探通的那条 API 根, 供仪表盘回填能用的 base_url
      listedCount: (r.live && r.live.length) || 0,
      missing: missing.slice(0, 30), missingCount: missing.length,
      unverifiable, candidate: true,
      anon: anon ? { ok: anon.ok, model: anon.model || '', detail: anon.detail } : undefined,
    }
  })
  if (candEntries.length) {
    console.log(`[patrol] 候选无 Key 巡检: 可匿名列模型 ${candListed} · 免Key可调用 ${candAnonOk} · 需Key ${candKeyed} · 端点存在 ${candExists} · 路径不通 ${candBad}`
      + `（共 ${candEntries.length} 家${candTrimmed ? `; ${candTrimmed} 家源声明里有端点查无的模型` : ''}）`)
  }

  // ⚠ 竞态: 巡检要跑几十秒(每家一个请求), 期间每日同步可能刚好跑完 —— 它会**重建 hosts**,
  //   把源的原话(含刚剔除的模型)原样写回。若这里直接 save 旧的 wl 对象, 剔除就白做了
  //   (实测: 启动 20s 巡检 vs 启动同步撞车, NVIDIA 剔到 8 个又被写回 14 个)。
  //   所以落盘前重新读一次, 把剔除套到**最新**的 hosts 上; probe 也一并写回。
  const fresh = loadWhitelist()
  const base = (fresh && fresh.hosts) ? fresh : wl
  for (const [h, set] of Object.entries(drops)) {
    const e = base.hosts[h]
    if (!e || !e.models) continue
    e.models = e.models.filter((m) => !set.has(norm(m)))
  }
  // ── 免 Key 实测可调用 -> 并入正式名单 ──────────────────────────────────
  // 依据是**实测**(无 Key 真拿到 200 + content), 比任何"源声称"都硬;
  // 且免 Key 端点没有账号 => 没有扣费通道 => 不存在静默扣费, 钱袋子原则明确允许这条扩容路径。
  // 具体合并规则(含"已在名单里只补标记""转正后从候选区移除")见 applyAnonPromotions。
  if (!base.candidates) base.candidates = {}
  const promoted = applyAnonPromotions(base.hosts, base.candidates, anonPromote, at)
  // hosts 侧巡检也探到的免 Key 端点: 补标记(它本来就在名单里, 只是过去这个事实没被记下来)
  for (const [h, p] of Object.entries(probe)) {
    if (p && p.anon && p.anon.ok && base.hosts[h] && !base.hosts[h].anon) {
      base.hosts[h].anon = true; base.hosts[h].anonAt = at; base.hosts[h].anonModel = p.anon.model || ''
    }
  }
  saveWhitelist(Object.assign({}, base, { probe }))
  console.log(`[patrol] ${at} 名单巡检完成: 需Key ${keyed} · 连不上 ${dead} · 可匿名列模型 ${listed} · 免Key可调用 ${anonOk}`
    + `（其中 ${trimmedHosts} 家有 ${trimmedModels} 个"源声明但端点查无此模型"已剔除）`)
  if (promoted || candAnonOk) {
    console.log(`[patrol] 免 Key 实测转正: ${promoted} 家候选进入正式名单, 另有 ${candAnonOk - promoted} 家已在名单中已补标记`)
    if (CFG.providers.length) refreshCatalogSafe().catch((e) => console.error('[catalog]', e.message))
  }
}
// 按 base_url 的 hostname 找该厂商的白名单条目
function whitelistFor(p) {
  const w = loadWhitelist()
  if (!w || !w.hosts || !p || !p.base_url) return null
  let host
  try { host = new URL(p.base_url).hostname } catch { return null }
  return w.hosts[host] || null
}
const normId = (id) => String(id || '').replace(/^models\//, '')
// ⚠ 2026-10-18 新增, 起因: 用户"免费厂家和模型很久没变" → 实测 OVHcloud 22 个模型 0 个进池。
//   根因是**大小写**: 社区源(freellm/models.dev)给的模型名统一小写, 而上游常见 CamelCase
//   (OVH 返回 `Meta-Llama-3_3-70B-Instruct` / `Qwen3.5-397B-A17B`, 白名单里是小写),
//   原来 normId 只去 `models/` 前缀就精确比对 -> 一个都匹配不上 -> 整家被判 closed-list 清空,
//   池子被掏空后 config 里只留下"目录扫描未发现其仍在免费池（可见 24 个模型）"的隔离记录。
//   只用于**判定**; 真正发出去的模型名仍用上游原始 id, 小写化不影响请求。
const sameId = (a, b) => normId(a).toLowerCase() === normId(b).toLowerCase()

// 通用 GET (JSON 文本), 先直连、失败且有代理则走代理隧道
function httpGetText(u, headers, timeoutMs, agent) {
  return new Promise((resolve, reject) => {
    const mod = u.protocol === 'https:' ? https : http
    const total = timeoutMs || 20000
    let timer
    const r = mod.request({
      hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search, method: 'GET', headers: headers || {}, agent,
    }, (res) => {
      // ⚠ 响应头到了**不能只 clearTimeout** —— 那样响应体读取就完全没有超时保护了。
      //   大响应体(如 models.dev 的 4.7MB)一旦传输中断/极慢, readBody 会永久挂起,
      //   外层 Promise.allSettled 永远不 settle, 表现为"同步无声无息地消失":
      //   日志一片空白、fetched_at 不更新、进程却活得好好的(2026-09-19 真踩, 查了很久)。
      //   改成把同一个 timer 续成"响应体超时", 并且给 readBody 补 catch(原来只 then,
      //   readBody 抛错会变成永远 pending)。
      clearTimeout(timer)
      timer = setTimeout(() => r.destroy(new Error('GET 响应体读取超时')), total)
      readBody(res, 8 * 1024 * 1024)
        .then((t) => { clearTimeout(timer); resolve({ status: res.statusCode, text: t, headers: res.headers }) })
        .catch((e) => { clearTimeout(timer); reject(e) })
    })
    timer = setTimeout(() => r.destroy(new Error('GET 超时')), total)
    r.on('error', (e) => { clearTimeout(timer); reject(e) })
    r.end()
  })
}
// timeoutMs 可选: 省略时走默认 15s(直连) / 20s(代理)。
// ⚠ 大体积清单必须单独给更长的超时 —— models.dev 的 api.json 有 4.7MB, 20s 拉不完会
//   静默超时失败, 该源被记成"拉取失败"而本地却毫无察觉(2026-09-19 实测踩到)。
//   不传参的调用方行为完全不变。
async function fetchTextAuto(urlStr, headers, timeoutMs) {
  const u = new URL(urlStr)
  const t = Number(timeoutMs) > 0 ? Number(timeoutMs) : 15000
  try { return await httpGetText(u, headers, t) }
  catch (e1) {
    if (!CFG.proxy) throw e1
    return httpGetText(u, headers, Math.max(t, 20000), getTunnelAgent(CFG.proxy))
  }
}
// 每日同步: 拉多个上游免费清单源(并集), 生成按 hostname 索引的封闭白名单
// 原则: 任何源的模型都要过 DENY_FREE 硬排除 + NON_CHAT_RE + 输出模态检查, 宁可漏判不可错判。
//
// 沙箱短路: 测试在 sb-gate / sb-main / sb4-a 等目录里放一个 .sandbox 空文件就跳过本轮同步。
// 否则启动同步会把测试精心构造的"含 127.0.0.1 这条假上游"的 free_whitelist.json 覆盖成
// 真实白名单（里面只有 api.groq.com / openrouter.ai 这种真域名），whitelistFor(假上游) 就
// 返回 null，free-gate 掉到 FREE_RULES['groq'] = () => true，"manual-paid-x" 一类手动
// 填的收费模型就被放行 → gate-check 5b "新填的手动模型被隔离 -> []" 假失败
// （2026-09-19 真踩：sync 在 600ms 启动窗口内有时赶上、有时没赶上，测试就成了间歇性 flake）。
// 发现源(models.dev)单独降频用的最小间隔。
// 它一次 5.9MB、实测拉完要 20s~3min, 而"市面上有哪些免费厂商"不会半小时变一次。
// ⚠ 2026-10-25 由 20h 降到 4h: 加上 ETag 条件请求之后, "没变"的轮次只回一个 304,
//   真正的下载次数等于**源真实变化的次数**, 与轮询间隔无关。所以间隔可以缩短, 代价可控;
//   而 20h 意味着"今天新冒出来的免费厂商要等到明天才进候选区"。
// ⚠ 跳过该源的轮次沿用上一轮候选 —— `candidates` 本身就是缓存, 不需要再存一份。
const DISCOVERY_MIN_MS = 4 * 3600 * 1000

// 源清单的**停更熔断**: 源自己声明的清单日期超过这个天数, 整源不参与本轮合并。
// 起因(用户原话, 2026-10-06): "那些早已停更的免费模型如果现在收费了, 那不就被坑了"。
// 一个停更的仓库照样天天 HTTP 200 拉得下来, 所以"拉到了"不等于"它是新的" —— 必须拿它自己
// 声明的日期判。实测 awesomefree 停在 2026-08-21 却仍把 `gemini-2.5-pro`(已收费)当免费、
// 把 5 个早已下架的 OpenRouter 模型留在名单里(调用必 404)。这类源留着不是"少给", 是"给错的"。
// ⚠ 只对**带版本日期的源**生效; live 源(OpenRouter/models.dev)每次拉的都是当下状态, 天然豁免;
//   日期解析不出来的也豁免 —— 宁可漏熔断, 不可因格式变动误伤一个正常源(漏熔断的兜底见
//   patrolWhitelist 的按端点 /models 剔除, 以及 DENY_FREE)。
// ⚠ 取 14 天而非"超过 1 天就熔断": freellm 这类"每日实测"源偶尔滞后几天是正常的,
//   而真正被废弃的源(awesomefree 停了 46 天)一眼就能被这条拦下。全源都熔断时会沿用本地缓存。
const SOURCE_STALE_DAYS = 14
// 源声明的清单日期距今多少天。解析不出(格式变了 / 空)一律返回 0 = 不算停更 ——
// 宁可漏熔断, 不可因格式变动把一个正常源整个丢掉(丢源比留旧数据更贵: 它可能是一整家的唯一来源)。
// 抽成纯函数只为一件事: 让它可被测试单独跑(见 protocol-test 的"停更熔断"用例), 判据不重写。
function sourceStaleDays(dateStr, nowMs) {
  const s = String(dateStr || '')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return 0
  return Math.floor(((nowMs || Date.now()) - new Date(s + 'T00:00:00Z').getTime()) / 86400000)
}

let _wlSyncing = false   // 白名单同步进行中(巡检要等它跑完, 否则读到旧表、剔除被冲掉)
// 上次"因白名单变动而触发目录扫描"的时刻。用途只有一个: 防抖(见同步末尾)。
// 源在短时间内连着变两次是常态(实测 OpenRouter 批量上架时会这样), 而一次目录扫描要打
// 十几家上游、约 4 分钟 —— 重复扫只是白烧请求, 不会让结果更准。
let _lastWlCatalogAt = 0

async function syncUpstreamWhitelist() {
  // 沙箱短路：cwd 或 __dirname 里有 .sandbox 就认作测试沙箱，绝不去碰测试准备的 free_whitelist.json
  // ⚠ 不能只看 process.cwd() —— Node 有时 cwd 会变(尤其被 spawn 进来再 chdir 的场景),
  //    __dirname 才是 server.mjs 所在的真实位置, 不会被运行时改掉。
  // ⚠ 不能在外层 try/catch 里调用未定义的函数 —— 一旦抛 ReferenceError 会被吞掉,
  //    函数继续走到下游 saveWhitelist() 把真实白名单写盘, 整个短路逻辑等于失效。
  //    (教训: 2026-09-19 这里曾写 `readWhiteCache()`，但这个函数根本不存在;
  //     启动时确实 SHORT-CIRCUIT 了(日志有), 但因为 readWhiteCache 抛错, 函数继续走完整流程,
  //     把真实白名单写盘, 沙箱测试从此间歇性 flake。)
  try {
    if (fs.existsSync(path.join(process.cwd(), '.sandbox')) || fs.existsSync(path.join(__dirname, '.sandbox'))) {
      _whitelist = loadWhitelist() || _whitelist
      return
    }
  } catch {}
  // 同步是"重建 hosts", 巡检是"读 hosts 再剔除" —— 两者撞车时巡检会读到旧表、剔除也被冲掉。
  // 这里立个旗, 让巡检先等着(见 patrolWhitelist)。
  if (_wlSyncing) return
  _wlSyncing = true
  const at = new Date().toISOString()
  const perSource = {}   // 记录每个源的上次更新日期, 供仪表盘/诊断看清"有没有真的刷到新内容"
  try {
    // 发现源(models.dev)没到最小间隔就跳过本轮, 沿用上一轮的候选
    const prevWl0 = loadWhitelist()
    const srcFetchedAt = Object.assign({}, prevWl0 && prevWl0.sourceFetchedAt)
    const skipDiscovery = (Date.now() - (srcFetchedAt.modelsdev || 0)) < DISCOVERY_MIN_MS
    const activeSources = WHITELIST_SOURCES.filter((s) => !(s.discovery && skipDiscovery))
    // 条件请求: 把上一轮各源的 etag / last-modified 带上, 源没变就回 304(正文零字节)。
    const prevCond = Object.assign({}, prevWl0 && prevWl0.sourceCond)
    // 并行拉取所有源; 单源失败不影响其它源(记 perSource 失败), 全挂才抛错沿用本地缓存。
    // srcId 在调用处注入, 而不是让每个源自己在返回值里写 —— 那要求三个源都记得加一行,
    // 漏一个就会让 304 短路时丢掉该源的 cond(下次白拉一次全量)。
    const results = await Promise.allSettled(activeSources.map((s) =>
      s.fetch(prevCond[s.id] || null).then((v) => (v ? Object.assign(v, { srcId: s.id }) : v))))
    // ── 全部 304: 白名单一个字节都没变 ──
    // 这条路径是"高频轮询"能成立的前提。同步间隔从 6h 降到 30min 之后, 如果每轮都重建 hosts,
    // 就会连带触发 1170 行那次目录扫描 —— 等于每 30 分钟把已接入的厂商全打一遍。
    // 有了这条短路: 源没变就只更新"我们刚确认过", 既不重建也不扫上游; 源真变了才走完整流程。
    // 实测(2026-10-25): OpenRouter(791KB, If-Modified-Since) 与 models.dev(5.9MB, If-None-Match)
    // 都稳定回 304 —— 高频轮询的实际流量因此是几百字节, 而不是几十 MB。
    // ⚠ 只在**上一轮名单非空**时短路: 首次运行 / 上轮失败留下空名单时, 必须走完整重建,
    //   否则会"确认没变"地把自己永久锁死在一个空名单上。
    // ⚠ 判据是"**成功的源**都没变", 不是"所有源都成功且没变"。
    //   后者只要有一个源长期挂掉(实测: 本机 raw.githubusercontent.com 解析不了, freellm 常年
    //   ENOENT)就永远走不到短路 —— 于是每 30 分钟全量重建一次 hosts 并连带扫一遍上游,
    //   等于把"某个源坏了"放大成"整个实时机制失效"。失败的源沿用上一轮贡献, 与"全挂沿用
    //   本地缓存"是同一条原则。
    const prevHash = Object.assign({}, prevWl0 && prevWl0.sourceHash)
    // "没变" = 304 **或** 正文指纹与上一轮相同(见 textHash 的说明)。
    const isUnchanged = (v) => !!(v.notModified || (v.hash && v.srcId && v.hash === prevHash[v.srcId]))
    const okResults = results.filter((r) => r.status === 'fulfilled' && r.value)
    const allOkUnchanged = okResults.length > 0 && okResults.every((r) => isUnchanged(r.value))
    if (allOkUnchanged && prevWl0 && prevWl0.hosts && Object.keys(prevWl0.hosts).length) {
      const newCond304 = Object.assign({}, prevCond)
      for (const r of okResults) {
        const id = r.value.srcId
        if (id && r.value.cond) newCond304[id] = r.value.cond
      }
      // ⚠ sourceFetchedAt 也必须更新: 它记的是"上次去拉的时刻", 而降频判据是
      //   `now - sourceFetchedAt.modelsdev < DISCOVERY_MIN_MS`。这里不更新的话, 那个源
      //   从"超过间隔"那一刻起会被**每一轮**都拉一次(虽然回 304, 但请求本身有成本,
      //   而且 5.9MB 的源要占住 60s 超时窗口)。
      const srcAt304 = Object.assign({}, prevWl0.sourceFetchedAt)
      for (const r of okResults) if (r.value.srcId) srcAt304[r.value.srcId] = Date.now()
      const newHash304 = Object.assign({}, prevHash)
      for (const r of okResults) if (r.value.srcId && r.value.hash) newHash304[r.value.srcId] = r.value.hash
      // sources 文案**不动**: 它描述的是"每个源上次拉到了什么", 而这一轮什么都没变。
      // 把 openrouter 改写成"未变(304)"反而让仪表盘冒出一句用户看不懂的技术黑话。
      saveWhitelist(Object.assign({}, prevWl0, {
        fetched_at: at, checked_at: at, sourceCond: newCond304, sourceFetchedAt: srcAt304, sourceHash: newHash304,
      }))
      const failed = results.length - okResults.length
      const how = okResults.map((r) => (r.value.notModified ? '304' : '指纹相同')).join('/')
      console.log(`[whitelist] ${at} 源未变化（${okResults.length} 个源：${how}${failed ? `，${failed} 个源本轮失败沿用缓存` : ''}），沿用现有名单 ${Object.keys(prevWl0.hosts).length} 家 —— 不重建、不触发目录扫描`)
      return true
    }
    // ── 有源变了: 304 的那些必须重拉全量 ──
    // hosts 每轮都是从零重建的, "没变"的源也得交出完整数据, 不能拿 304 空转。
    // 这一步只在"至少一个源有新内容"时才发生, 频率远低于轮询次数。
    for (let i = 0; i < activeSources.length; i++) {
      const v = results[i]
      if (v.status === 'fulfilled' && v.value && v.value.notModified) {
        try {
          const v = await activeSources[i].fetch(null)
          results[i] = { status: 'fulfilled', value: v ? Object.assign(v, { srcId: activeSources[i].id }) : v }
        } catch (e) {
          results[i] = { status: 'rejected', reason: e }
        }
      }
    }
    const merged = {}    // host -> { source, models:Set }  多源取并集
    // 发现源(models.dev)不能碰的 host: 已配置供应商 + 手工名单里的厂商。
    // 它的数据含"赠送额度/token plan"类误判(实测把 dashscope 标成免费), 让它给这些厂商加模型
    // 等于把付费模型塞进已启用供应商的池子 = 直接扣费。新厂商只作候选, 用户添加后仍要过实测。
    const guardedHosts = new Set(Object.keys(MANUAL_WHITELIST))
    for (const p of CFG.providers || []) {
      try { const h = new URL(normalizeBaseUrl(p.base_url)).hostname; if (h) guardedHosts.add(h) } catch {}
    }
    for (let i = 0; i < activeSources.length; i++) {
      const s = activeSources[i]
      const res = results[i]
      if (res.status === 'rejected' || !res.value) {
        perSource[s.id] = `失败:${res.reason ? res.reason.message : 'unknown'}`
        console.warn(`[whitelist] 源 ${s.id}(${s.name}) 拉取失败: ${res.reason ? res.reason.message : ''}`)
        continue
      }
      // 实时源(OpenRouter)没有版本日期, 记成"实时"而不是"未知" —— 否则会被误读成拉取失败或陈旧
      perSource[s.id] = res.value.live ? '实时' : (res.value.date || '未知')
      // ⚠ 停更熔断(见 SOURCE_STALE_DAYS 注释): 带版本日期且已过期 -> **整源不合并**。
      //   放在这里(合并之前)而不是合并之后过滤, 是为了让"这家厂商这个模型是谁贡献的"这件事
      //   从一开始就不成立 —— 事后过滤会留下 provisional/交叉印证的中间状态, 更难说清。
      //   状态文案写明"已忽略", 让仪表盘与日志能看出"不是没拉到, 是拉到了但不新"。
      const _sd = String(res.value.date || '')
      const _ageDays = sourceStaleDays(_sd)
      if (!res.value.live && _ageDays > SOURCE_STALE_DAYS) {
        perSource[s.id] = `${_sd} ⚠停更${_ageDays}天, 已忽略`
        console.warn(`[whitelist] 源 ${s.id}(${s.name}) 清单日期 ${_sd} 已停更 ${_ageDays} 天(>${SOURCE_STALE_DAYS}), 本轮不参与合并`)
        continue
      }
      for (const [host, info] of Object.entries(res.value.hosts || {})) {
        // 发现源只补"白名单里还没有的新厂商": 已有的一律跳过(见上方 guardedHosts 注释)
        if (res.value.discovery && (merged[host] || guardedHosts.has(host))) continue
        // provisional(暂定): 只有发现源认它、没有权威源(freellm/OpenRouter)交叉印证 -> 标未实测。
        // 刻意不叫 unverified —— 那个词已被 gateUnverifiedModels(手动模型隔离)占用, 语义不同。
        if (!merged[host]) merged[host] = { source: info.source || host, models: new Set(), provisional: !!res.value.discovery }
        else if (!res.value.discovery && merged[host].provisional) merged[host].provisional = false
        for (const id of info.models || []) {
          if (!id) continue
          if (DENY_FREE.some((re) => re.test(String(id)))) continue        // 硬排除: 名字含 pro 的收费模型
          if (NON_CHAT_RE.test(id)) continue                                // 非聊天模型(语音/嵌入/图像等)
          merged[host].models.add(normId(id))
        }
      }
    }
    if (!Object.keys(merged).length) throw new Error('所有上游源均未返回数据')

    // 组装最终白名单: models 排序 + 附上本地的 openFree/hybrid 人工口径(覆盖名单)
    const hosts = {}
    // ⚠ 发现源(models.dev)捞到、又没有权威源交叉印证的厂商 -> **只记候选, 不进正式名单**。
    //   用户 2026-09-19 明确要求: "一些小厂家和没测试过免费的厂家就不要放进去了"。
    //   它们只标明标价 0、我们从没真调过, 混进正式名单会让下拉里多出几十家陌生小厂
    //   (实测有标 52 个"免费"、含 claude-sonnet-4-6 的 kenari.id), 反而干扰判断、违背"轻量"。
    //   仍记进 candidates 是为了留住"发现"能力: 一旦权威源也收录它, 下一轮自动转正进 hosts。
    const candidates = {}
    for (const [host, info] of Object.entries(merged)) {
      const ent = {
        source: info.source,
        models: [...info.models].sort(),
        openFree: OPEN_FREE_HOSTS.has(host),
        hybrid: HYBRID_HOSTS.has(host),
      }
      // ⚠ 2026-10-18: 继承上一轮的"免 Key 实测"标记(anon/anonAt/anonModel)。
      //   巡检发现某家免 Key 可调用后会写这三个字段, 但这里是**重建** hosts —— 不继承等于每 6 小时
      //   把标记冲掉一次, 要等下一轮巡检再测一遍才补回来; 只要那次恰好被限流(429)标记就永久丢失。
      //   实测: llm7 今天就是这么掉的(17:00 同步冲掉标记 -> 17:04 巡检遇到 429 -> 标记没了)。
      //   标记代表"过去实测通过"这一事实, 不该因为一次重建或一次限流就抹掉。
      const prevEnt = prevWl0 && prevWl0.hosts && prevWl0.hosts[host]
      if (prevEnt && prevEnt.anon) {
        ent.anon = true
        ent.anonAt = prevEnt.anonAt
        ent.anonModel = prevEnt.anonModel
      }
      if (info.provisional) { candidates[host] = Object.assign(ent, { provisional: true }); continue }
      hosts[host] = ent
    }
    // 手工名单: 上游源没有的补进去; 带 force 标记的强制覆盖上游源
    // (教训: mnfst 把已砍免费档的 cerebras 仍标 openFree —— 源出错时以人工核实为准)
    for (const [h, v] of Object.entries(MANUAL_WHITELIST)) {
      if (!hosts[h] || v.force) hosts[h] = { models: [], hybrid: false, ...v }
    }
    // 同步落盘前也要套否决表: loadWhitelist 每次读都会修正, 但如果不在这里改,
    // 写到 free_whitelist.json 里的 openFree 仍是源给的 true —— 人工查看文件时会和运行时口径不一致。
    for (const h of OPEN_FREE_DENY) if (hosts[h]) hosts[h].openFree = false
    // list_date 取所有**带版本日期的源**里最新的那个(而非固定取 mnfst), 否则源停更时会一直显示
    // 旧日期误导用户。实时源(OpenRouter, 值为"实时")不参与 —— 它没有版本日期, 也不该被当成陈旧。
    const dates = Object.values(perSource).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort()
    const dateStr = dates.length ? dates[dates.length - 1] : ''
    // 跳过发现源的轮次: 候选**沿用上一轮**(写成空会让候选凭空消失), 源状态也沿用 ——
    // ⚠ 但**不能照搬上一轮的失败状态**：那会让仪表盘一直顶着"modelsdev✗"，而这一轮根本没去拉
    //   (DISCOVERY_MIN_MS = 4h)。只有上轮拿到正常值才沿用，失败一律降级成"缓存(未到间隔)"，
    //   否则用户会以为源挂了 —— 这正是上面那句"别显示成失败"的本意，原实现漏了这层判断。
    if (skipDiscovery) {
      // ⚠ 沿用上一轮状态时**不能连"实时"一起沿用**（2026-09-25 修）：models.dev 是降频的发现源，
      //   跳过这一轮时界面仍写着"实时"，等于在说一件不准确的事 —— 实测距上次拉取已 11.3 小时，
      //   而仪表盘顶着"modelsdev 实时"。改成把真实年龄说出来，用户一眼能看出这份名单是多久前的。
      //   （失败状态仍然一律降级成"缓存(未到间隔)"，见上一条注释。）
      const prevM = ((prevWl0 && prevWl0.sources) || {}).modelsdev
      const ageH = (Date.now() - (srcFetchedAt.modelsdev || 0)) / 3600000
      perSource.modelsdev = (prevM && String(prevM).startsWith('失败'))
        ? '缓存(未到间隔)'
        : `缓存(${ageH < 1 ? '刚刚' : Math.round(ageH) + 'h 前'})`
    }
    // 候选沿用条件(2026-09-25 补): ① 本轮没去拉(跳过了) 或 ② 去拉了但**失败**。
    // ⚠ 原来只覆盖 ① —— ② 时 candidates 是空的, 直接写盘会让候选区凭空消失, 而且要等下一个
    //   20h 窗口才可能恢复。注释里"写成空会让候选凭空消失"正是这个意思, 原实现只做了一半。
    //   注意不能无条件沿用: 发现源真的成功且**确实没有**候选时, 就该如实写空(否则会一直挂着旧候选)。
    const discoveryFailed = !skipDiscovery && String(perSource.modelsdev || '').startsWith('失败')
    const finalCand = (skipDiscovery || discoveryFailed) ? ((prevWl0 && prevWl0.candidates) || {}) : candidates
    // 记每个源各自的同步时刻, 供下一轮判断是否到了最小间隔。
    // ⚠ 只保留"当前仍在 WHITELIST_SOURCES 里"的源 —— 源被移除后(2026-09-25 移除 mnfst),
    //   它的键会永远留在 free_whitelist.json 里, 人工查看时看到一个已不存在的源, 同样是误导。
    const knownSrcIds = new Set(WHITELIST_SOURCES.map((s) => s.id))
    const newSrcFetchedAt = {}
    for (const [k, v] of Object.entries(srcFetchedAt)) if (knownSrcIds.has(k)) newSrcFetchedAt[k] = v
    for (const s of activeSources) newSrcFetchedAt[s.id] = Date.now()
    // 各源的 etag / last-modified 一并落盘, 下一轮拿它做条件请求。
    // 本轮没去拉的源(发现源被 DISCOVERY_MIN_MS 降频跳过)沿用上一轮的 cond —— 否则下次
    // 真去拉时会因为丢了 etag 而白拉一次 5.9MB。
    const newCond = {}
    for (let i = 0; i < activeSources.length; i++) {
      const v = results[i]
      if (v.status === 'fulfilled' && v.value && v.value.cond) newCond[activeSources[i].id] = v.value.cond
    }
    for (const [k, v] of Object.entries(prevCond)) if (knownSrcIds.has(k) && !newCond[k]) newCond[k] = v
    // 正文指纹同理落盘: 下一轮靠它判断"源虽然回了 200, 但内容其实没变"(见 textHash)。
    const newHash = Object.assign({}, prevHash)
    for (let i = 0; i < activeSources.length; i++) {
      const v = results[i]
      if (v.status === 'fulfilled' && v.value && v.value.hash) newHash[activeSources[i].id] = v.value.hash
    }
    // ⚠ probe(名单巡检结论)必须跟着一起存回去: 每轮同步都是重建 hosts, 不带上它
    // 就会把"端点查无此模型"的剔除记录冲掉, 下一轮源的原话又被原样加回来。
    saveWhitelist({ fetched_at: at, list_date: dateStr, sources: perSource, hosts, candidates: finalCand, sourceFetchedAt: newSrcFetchedAt, sourceCond: newCond, sourceHash: newHash, probe: ((prevWl0 && prevWl0.probe) || {}) })
    // 白名单变了 => 免费池口径变了, 立刻重扫目录同步路由
    console.log(`[whitelist] ${at} 同步完成, ${Object.keys(hosts).length} 家厂商进入封闭名单/开放名单`
      + `（另有 ${Object.keys(finalCand).length} 家发现源候选未收录${(skipDiscovery || discoveryFailed) ? '，本轮沿用缓存' : ''}） | 源状态: ${JSON.stringify(perSource)}`)
    if (CFG.providers.length && Date.now() - _lastWlCatalogAt > 10 * 60 * 1000) {
      _lastWlCatalogAt = Date.now()
      refreshCatalogSafe().catch((e) => console.error('[catalog]', e.message))
    } else if (CFG.providers.length) {
      console.log('[whitelist] 10 分钟内刚因白名单变动扫过目录，本轮跳过（防抖）')
    }
    return true
  } catch (e) {
    console.error('[whitelist] 同步失败(沿用本地缓存):', e.message)
    return false
  } finally {
    _wlSyncing = false   // 放行等待中的名单巡检(见 patrolWhitelist 的等待逻辑)
  }
}

// 这些厂商的 /models 会返回真实价格(pricing), 元数据可信 -> 价格>0 即判为收费
const PRICING_TRUSTED = new Set(['openrouter', 'siliconflow'])

// 从模型元数据判断免费: true=确定免费 / false=确定收费 / null=信息不足(交回名单/规则)
function metaIsFree(m) {
  if (!m || typeof m !== 'object') return null
  const id = m.id || m.name || ''
  if (/:free$/.test(id)) return true                      // OpenRouter/Kilo 的 :free 后缀是硬标记
  const pr = m.pricing
  if (pr && typeof pr === 'object') {
    const vals = ['prompt', 'completion', 'request', 'image'].map((k) => pr[k]).filter((v) => v !== undefined && v !== null && v !== '')
    if (vals.length) {
      const nums = vals.map(Number)
      if (nums.every((n) => n === 0)) return true          // 全 0 = 免费
      // 负定价(-1 等) = 上游用特殊值表示"动态/按实际路由到的模型计费", 绝不是免费。
      // 实测 Kilo 的 kilo-auto/efficient|balanced|frontier、openrouter/auto* 都是 -1,
      // 它们会按路由到的真实模型扣费。以前这里返回 null(信息不足) —— 对 openFree 厂商
      // 就会被无条件放行成"免费", 是静默扣费口子。按"宁可漏判不可错判"判为收费。
      if (nums.some((n) => n < 0)) return false
      if (Number(pr.prompt) > 0 || Number(pr.completion) > 0) return false // 输入或输出收费 = 收费
    }
  }
  // is_free/free 布尔字段只信白名单已知的开放型厂商; 其余厂商这类字段语义不统一, 不足以定生死
  if (m.is_free === true || m.free === true) return null
  if (Array.isArray(m.tags) && m.tags.some((t) => /free/i.test(String(t)))) return null
  return null
}

// 路由型模型: 它本身不是某个具体模型, 而是"由厂商在内部按策略转发到别的模型"。
// 识别意义: ①它的能力/表现取决于上游挑中谁, 用户看到的名字不对应固定模型, 需要标注清楚;
// ②部分路由型是付费的(kilo-auto/efficient 定价 -1), 不能和真免费模型混在一起展示。
// 判据: 上游显式给了 autoRouting 字段(Kilo), 或 id 属于已知的聚合命名(openrouter/auto|free 等)。
function isRouterModel(x) {
  if (!x) return false
  if (x.meta && x.meta.autoRouting) return true
  return /^(openrouter|kilo-auto)\/(auto|free)/i.test(String(x.id || ''))
}

// 兜底启发式规则(现在只用于"白名单里没有的自定义厂商")。返回 true 表示该模型在免费池内。
// ⚠ 封闭名单厂商(智谱/mistral 等)不走这里, 直接查每日白名单 —— 避免"flash≠免费"类误判。
const FREE_RULES = {
  openrouter: (id) => id.endsWith(':free'),               // 有价格元数据时以元数据为准
  groq: () => true,                                       // 免费 plan 的 key 只能看到免费模型
  gemini: (id) => /flash|lite|gemma/i.test(id),           // 免费层覆盖 flash/lite/gemma(Pro 已移出免费层)
  // B.AI 是付费聚合器, 本身无永久免费档, 只有"限时 0 Credits"活动。
  // 2026-09-16 17:00(UTC+8) 起 Qwen3.8-Flash / Hy3 / MiMo-V2.5 的活动统一改成"限时 1 折"= 已收费。
  // 所以这里不写死, 一律以公告页巡检结论为准: 只有巡检确认"仍在免费"才放行(放行=静默扣费)。
  bai: (id) => promoWatchState('bai', id) === 'free',
  // Empero 官方口径: 仅列出的社区端点模型免费(免Key); 名单外交给封闭白名单判, 此处只兜同名重复
  empero: (id) => /^glm-5\.3-flash$/i.test(id),
}
// 兜底: 未知供应商 —— 只认模型名里"独立成词"的 free 标记(如 model-free / free-model / :free / _free),
// 绝不按 flash/lite/8b 猜, 也不匹配含 free 子串的普通词(如 Stanford / freeform) —— 错判=扣钱
const FREE_DEFAULT = (id) => /(^|[/:._-])free([/:._-]|$)/i.test(id)
// 推荐模型: 各家公认能打 + 通用大参数/强能力启发 (2026-09 核对; 推荐只在"已判定免费"的模型中生效)
const RECOMMENDED = {
  groq: ['gpt-oss-120b', 'qwen3.8', 'qwen3.6', 'gpt-oss-20b', 'compound'],
  gemini: ['gemini-3.5-flash', 'gemini-3.6-flash', 'gemini-3.7-flash', 'gemma-4'],
  zhipu: ['glm-4.7-flash', 'glm-4.6v-flash'],
  longcat: ['LongCat-Flash-Lite', 'LongCat-Flash-Chat', 'LongCat-Flash-Thinking'],
  openrouter: ['deepseek', 'qwen3-coder', 'llama-3.3-70b', 'kimi', 'gemma-4', 'nemotron'],
  nvidia: ['nemotron-3-ultra', 'deepseek', 'kimi', 'glm', 'minimax', 'gemma-4'],
  mistral: ['mistral-large', 'mistral-medium', 'mistral-small', 'codestral'],
  siliconflow: ['Qwen3-8B'],
  bailian: ['qwen-flash', 'qwen-turbo'],
  volc: ['seed-lite', 'flash'],
  modelscope: ['Qwen3.5'],
  amd: ['DeepSeek-V4-Flash', 'Qwen3.8-Flash', 'MiniCPM'],
  cerebras: ['gemma-4', 'gpt-oss'],
  bai: [],   // 2026-09-16 起 0 Credits 活动全部结束, B.AI 已无免费模型
  cloudflare: ['llama-3.3-70b', 'gpt-oss-120b', 'glm-4.7-flash', 'gemma'],
  kilo: ['nemotron-3-ultra', 'step-3.7', 'hy3'],
  sensenova: ['SenseNova 6.7', 'deepseek-v4', 'U1'],
  empero: ['glm-5.3'],
}
const REC_PATTERN = /(70b|32b|235b|671b|r1|coder|kimi|k2|thinking|reasoning|gemma-?4|nemotron|deepseek-v4|qwen3\.[568])/i

// ---------------- 限时免费活动标注(人工兜底) ----------------
// until: 官方公布的截止日期(ISO); null = 未公布。note: 说明。
// ⚠ 本表只是"人工兜底", 不再是唯一事实来源 —— 下面的 watchPromoPages() 会定时抓官方公告页自动订正,
//   巡检结论优先级高于本表(见 promoOf)。公告页覆盖得到的活动交给 PROMO_WATCH, 本表只留公告页覆盖不到的。
const PROMO = {
  bai: [
    { match: /qwen3\.?8-?flash/i, until: '2026-09-16', note: '0 Credits 活动已于 2026-09-16 17:00 结束, 调整为限时 1 折(收费)' },
    { match: /hy3/i, until: '2026-09-16', note: '0 Credits 活动已于 2026-09-16 17:00 结束, 调整为限时 1 折(收费)' },
    { match: /mimo-?v2\.?5/i, until: '2026-09-16', note: '0 Credits 活动已于 2026-09-16 17:00 结束, 调整为限时 1 折(收费)' },
  ],
  sensenova: [
    // 2026-09-17 实地核对官方 token-plan 页: "订阅方案 公测期完全免费开放，付费档位即将上线
    //   Free · 公测 限时放量 ¥ 0 /月 · 60,000 积分 / 5 小时"。付费档 Lite/Pro 仍标"即将上线",
    //   即当下确实免费; 一旦上线, 该页的价格标记会变, PROMO_WATCH 的整页判定会立刻改判 paid。
    { match: /sensenova|deepseek-v4-flash/i, until: null, note: 'Token Plan 公测期完全免费(¥0/月, 60,000 积分/5 小时), 付费档 Lite/Pro 尚未上线' },
  ],
  // 示例: 若某家公布明确截止日期, 形如下面这样维护
  // zhipu: [{ match: /glm-4\.6/i, until: '2026-12-31', note: '限时免费活动' }],
}

// ---------------- 限时活动公告页自动巡检 ----------------
// 为什么必须自动: 白名单源(freellm / OpenRouter)只覆盖"清单型免费"; "限时活动型免费"
// (B.AI 0 Credits、SenseNova 公测免费…) 只写在厂商自家公告页上, 靠人工维护 PROMO 表必然滞后。
// 实测教训: B.AI 于 2026-09-16 17:00 把 Qwen3.8-Flash / Hy3 / MiMo-V2.5 的免费活动统一改成
// "限时 1 折"(按标准参考价 10% 结算) = 已收费, 而规则表隔天才靠人工发现 —— 这段空窗就是扣费窗口。
// 做法: 定时抓官方公告页 -> 按标题 section 定位每个活动模型 -> 判定"仍免费"还是"已降级收费" -> 自动订正。
// 安全原则: 判为收费立即停止放行; 抓取失败/判不准一律保持原状(绝不因网络抖动把收费模型放进来)。
// 每个条目两种判定方式, 二选一:
//   ① models[] 逐模型判定 —— 页面结构是"一个模型一个 h1~h4 标题"(B.AI 公告页就是这样),
//      命中标题的那一段正文里出现收费措辞 -> 该模型判 paid。
//   ② page 整页判定 —— 页面是营销落地页, 标题跟模型名对不上(SenseNova 的 token-plan 页),
//      就在整页文本上只认"价格标记"本身。⚠ 别去认"免费开始"这类按钮文案:
//      活动结束后 CTA 往往还挂着, 认文案会被"免费"两个字骗过去, 只认 ¥0/月 这类价格才靠谱。
const PROMO_WATCH = [
  {
    pname: 'bai',
    label: 'B.AI',
    url: 'https://docs.b.ai/zh-Hans/llmservice/promotions-and-pricing-notices/',
    models: [
      { name: 'Qwen3.8-Flash', re: /qwen3\.?8-?flash/i },
      { name: 'Hy3', re: /hy3/i },
      { name: 'MiMo-V2.5', re: /mimo-?v2\.?5/i },
      { name: 'GLM-5.3-Flash', re: /glm-?5\.?3-?flash/i },
      { name: 'GLM-5.2', re: /glm-?5\.?2(?!-)/i },
    ],
  },
  {
    pname: 'sensenova',
    label: '商汤日日新',
    url: 'https://www.sensenova.cn/token-plan',
    // 实测该页(2026-09-17)原文: "订阅方案 公测期完全免费开放，付费档位即将上线
    //   Free · 公测 限时放量 ¥ 0 /月 立即开始 60,000 积分 / 5 小时 … Lite / Pro 即将上线"
    // 判 paid 的锚点是"¥ 非0 /月"和"公测…结束/付费档位…上线": 只要免费档还在, 价格标记就是 0。
    page: {
      free: /公测期完全免费|¥\s*0\s*\/\s*月/,
      paid: /公测(期)?(已)?结束|公测(已)?截止|付费档位(已|正式)(上线|推出)|恢复收费|不再免费|¥\s*[1-9]\d*\s*\/\s*月/,
    },
    models: [
      { name: 'SenseNova 6.7/6.8 Flash Lite', re: /sensenova/i },
      { name: 'SenseNova U1 Fast', re: /sensenova/i },
      { name: 'deepseek-v4-flash', re: /deepseek/i },
    ],
  },
]
// 收费信号优先于"免费"字样 —— B.AI 的措辞正是"现有免费活动于 X 调整为限时 1 折"(含"免费"二字, 实为收费)
const PROMO_PAID_RE = /(\d+\s*折|按标准参考价|标准价的?\s*\d+\s*%|\d+\s*%\s*结算|恢复收费|活动结束|不再免费|已结束|终止)/
const PROMO_FREE_RE = /(限时免费|免费|0\s*Credits|0\s*元)/
const stripTags = (s) => String(s == null ? '' : s)
  .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/\s+/g, ' ').trim()

let _promoState = null
function loadPromoState() {
  if (_promoState) return _promoState
  try { _promoState = JSON.parse(fs.readFileSync(PROMO_STATE_PATH, 'utf8')) } catch { _promoState = { at: '', items: {} } }
  if (!_promoState || typeof _promoState !== 'object') _promoState = { at: '', items: {} }
  if (!_promoState.items) _promoState.items = {}
  if (!_promoState.health) _promoState.health = {}
  return _promoState
}
function savePromoState(s) { _promoState = s; writeJsonAtomic(PROMO_STATE_PATH, s) }
// 取某厂商某模型的最新巡检结论: 'free' | 'paid' | undefined(无结论)
function promoWatchState(pname, id) {
  const w = PROMO_WATCH.find((x) => x.pname === pname)
  if (!w) return undefined
  const m = w.models.find((x) => x.re.test(String(id)))
  if (!m) return undefined
  const it = loadPromoState().items[`${pname}:${m.name}`]
  return it ? it.state : undefined
}
// 巡检产生的变动, 暂存后由 refreshCatalog 并入目录的变动记录(让用户在仪表盘上看得见)
let pendingPromoChanges = []
async function watchPromoPages() {
  const st = loadPromoState()
  const at = new Date().toISOString()
  const changed = []
  if (!st.health) st.health = {}
  for (const w of PROMO_WATCH) {
    let text = ''
    try {
      const r = await fetchTextAuto(w.url, { 'user-agent': 'Mozilla/5.0 (compatible; XiaoJiFreeModel/1.0)' })
      if (!r || !r.status || r.status >= 400) throw new Error('HTTP ' + (r && r.status))
      text = r.text || ''
    } catch (e) {
      // 抓取失败 -> 沿用上次判定, 同时记健康度: 连续失败说明公告页 URL 或网络出了问题,
      // 巡检正在静默失效(退回人工维护), 必须让用户在仪表盘上看得见, 不能只写日志
      const h = st.health[w.pname] || { failCount: 0 }
      h.failCount = (h.failCount || 0) + 1
      h.lastError = '公告页抓取失败: ' + e.message
      h.lastFailAt = at
      st.health[w.pname] = h
      console.warn(`[promo] ${w.pname} 公告页抓取失败(${e.message}), 沿用上次判定 (连续失败 ${h.failCount} 次)`)
      continue
    }
    const full = stripTags(text)
    // 结论落地: 只有"结论变了"才写盘 + 记变动, 否则每次巡检都会刷一堆一模一样的记录
    const record = (m, next, note) => {
      const key = `${w.pname}:${m.name}`
      const prev = st.items[key] && st.items[key].state
      if (prev === next) return
      st.items[key] = { state: next, at, url: w.url, label: w.label, model: m.name, note: String(note || '').slice(0, 200) }
      changed.push({ pname: w.pname, label: w.label, model: m.name, prev, next })
      console.log(`[promo] ${key}: ${prev || '(首次)'} -> ${next}`)
    }
    let matched = 0
    if (w.page) {
      // 整页判定: 收费信号优先 —— 两种信号同时命中时按收费处理(和 B.AI 那次"含免费二字实为收费"的教训一致)
      const next = w.page.paid.test(full) ? 'paid' : (w.page.free.test(full) ? 'free' : null)
      if (next) {
        matched = w.models.length
        for (const m of w.models) record(m, next, next === 'paid'
          ? '公告页价格标记已不再是 0 元/月，限时免费档疑似已结束'
          : '公告页仍显示 0 元/月 免费档，限时活动进行中')
      }
    } else {
      // 按 h1~h4 标题切 section: 标题命中模型名的那一段就是该模型的活动说明
      const secs = String(text).split(/<h[1-4][^>]*>/i).slice(1)
      for (const m of w.models) {
        const sec = secs.find((s) => m.re.test(stripTags(String(s).split(/<\/h[1-4]>/i)[0] || '')))
        if (!sec) continue
        matched++
        const body = stripTags(String(sec).split(/<h[1-4]/i)[0]).slice(0, 600)
        const next = PROMO_PAID_RE.test(body) ? 'paid' : (PROMO_FREE_RE.test(body) ? 'free' : null)
        if (!next) continue
        record(m, next, body)
      }
    }
    // 一个关注模型都没匹配到 = 页面结构大概率改版了。这种失败最阴险: HTTP 抓取是"成功"的,
    // 但结论永远不再更新, 巡检会静默失效、悄悄退回人工维护 —— 所以必须显式记为异常。
    if (matched === 0) {
      const h = st.health[w.pname] || { failCount: 0 }
      h.failCount = (h.failCount || 0) + 1
      h.lastError = `公告页已抓通，但未匹配到任何关注模型（共 ${w.models.length} 个），页面结构可能已改版`
      h.lastFailAt = at
      st.health[w.pname] = h
      console.warn(`[promo] ${w.pname}: ${h.lastError} (连续 ${h.failCount} 次)`)
    } else {
      st.health[w.pname] = { failCount: 0, lastOkAt: at, matched, total: w.models.length }
    }
  }
  st.at = at
  savePromoState(st)
  // 结论变了 => 免费池口径变了, 立刻重扫目录, 并记一条变动给用户看
  if (changed.length) {
    for (const c of changed) {
      pendingPromoChanges.push({
        at, provider: c.pname, label: c.label, model: c.model,
        type: c.next === 'paid' ? 'promo_end' : 'promo_start',
        note: c.next === 'paid'
          ? '官方公告页显示免费活动已结束/降级为折扣，已自动移出免费池'
          : '官方公告页显示限时免费活动生效，已自动放回免费池',
      })
    }
    if (CFG.providers.length) refreshCatalogSafe().catch((e) => console.error('[catalog]', e.message))
  }
  return changed
}
function promoOf(pname, id) {
  const list = PROMO[pname] || []
  const hit = list.find((r) => r.match.test(id))
  // ① 公告页巡检结论优先(最接近事实): 明确收费 -> 视为过期; 明确免费 -> 不算过期
  const ws = promoWatchState(pname, id)
  if (ws === 'paid') return { until: hit ? hit.until : null, note: ((hit ? hit.note + ' | ' : '') + '公告页巡检: 免费活动已结束'), expired: true, watched: true }
  if (ws === 'free') return { until: hit ? hit.until : null, note: ((hit ? hit.note + ' | ' : '') + '公告页巡检: 免费活动生效中'), expired: false, watched: true }
  if (!hit) return null
  // ② 回退到人工维护的 until
  const expired = hit.until ? Date.now() > new Date(hit.until + 'T23:59:59+08:00').getTime() : false
  return { until: hit.until, note: hit.note, expired }
}
// 供仪表盘展示: 正在盯哪些公告页 + 每个活动模型的最新巡检结论
function promoStatusPayload() {
  const st = loadPromoState()
  return {
    at: st.at || '',
    items: Object.entries(st.items).map(([k, v]) => Object.assign({ key: k }, v)),
    health: Object.entries(st.health || {}).map(([k, v]) => Object.assign({ pname: k }, v)),
    watching: PROMO_WATCH.map((w) => ({ pname: w.pname, label: w.label, url: w.url, models: w.models.map((m) => m.name) })),
    unwatched: promoUnwatched(),
  }
}
// 覆盖缺口检测: 人工 PROMO 表里有、但还没纳入自动巡检的厂商。
// 这些家的活动起止只能靠人盯 —— 而"靠人盯"正是最容易漏掉、进而被静默扣费的地方。
// 列到仪表盘上让用户看得见; 给它补一条 PROMO_WATCH, 提示会自动消失(所以这个检测本身会自愈)。
function promoUnwatched() {
  const watched = new Set(PROMO_WATCH.map((w) => w.pname))
  const label = {}
  for (const d of Object.values(VENDOR_DIR || {})) if (d && d.name) label[d.name] = d.label
  return Object.keys(PROMO).filter((k) => !watched.has(k)).map((k) => ({
    pname: k,
    label: label[k] || k,
    models: (PROMO[k] || []).length,
  }))
}

// ── 模型类型准入: 这里只做"文字对话网关"，不是所有免费模型都该接 ──
// 对话/推理/代码模型(含能看图、但输出文字的多模态对话模型)可以走 /chat/completions；
// 嵌入、重排、审核、语音、音乐、纯图像/视频生成、OCR 等即使价格为 0，也不能被 auto 选中。
// 不把它们接进来不是浪费，而是避免接口形状不兼容时出现"看似成功、实际没回答"或用错端点。
// 实测踩坑: Groq 的 canopylabs/orpheus-* 是 TTS; OpenRouter 的 google/lyria-* 是音乐生成;
// nvidia/nemotron-*-content-safety 是审核，AMD MinerU2.5-Pro 的 output=["ocr"] —— 都可能标价 0。
const MODEL_KIND_RULES = [
  ['嵌入/向量', /embed|clip|vector/i],
  ['重排/检索', /rerank|re-rank/i],
  ['安全审核', /prompt-guard|guard-|_guard|moderation|safety/i],
  ['语音生成', /tts|speech|voice|orpheus|playai|play-ai|bark|kokoro|parler/i],
  ['语音识别', /whisper|asr|transcribe/i],
  ['音乐生成', /musicgen|audiogen|lyria|music|audio/i],
  ['图像/视频生成', /image|stable-diffusion|sdxl|flux|dall-?e|imagen|veo|sora|upscal|diffusion/i],
  ['OCR/文档解析', /ocr|mineru|vision-encoder/i],
]
const NON_CHAT_RE = new RegExp(MODEL_KIND_RULES.map(([, re]) => re.source).join('|'), 'i')

// 上游明确不支持 tool calling 的模型（按 provider -> Set(model) 精确匹配，不做模糊匹配）。
// 背景: agent 类客户端(WorkBuddy 等)默认每次请求都带 tools 字段, 这些模型会 100% 回
// `tool calling is not supported with this model`, 每次都白搭一次 HTTP 往返还拖慢首字节。
// 实测命中: groq/compound、groq/compound-mini、allam-2-7b —— Groq 自家 agentic 模型,
// 只走内部 tool, 不对外开放 function calling。
// 设计取舍: **不做永久拉黑, 只在请求真的带 tools 时跳过** —— 纯对话场景它们仍是可用的免费模型,
// 一刀切会平白损失池子容量。用户显式指定 `groq/groq/compound` 时也不拦(尊重显式意图)。
// 不支持 tools 的模型。**主路径是实测学习, 不是这张表** —— 带 tools 的请求被上游以
// "不支持"措辞拒绝时, 自动记进该供应商的 noTools(见 markFail), 下次带 tools 的路由直接跳过。
// 为什么不能只靠人工名单: 免费池每天在变, 手工名单第二天就过期(与 modelTier 同一原则)。
// 这张表只放"人已经实测确认过、不值得再浪费一次往返去学"的几条。
const MODEL_NO_TOOLS = new Map([
  ['groq', new Set(['groq/compound', 'groq/compound-mini', 'allam-2-7b'])],
])
const NO_TOOLS_TTL_MS = 30 * 86400000   // 实测结论 30 天后作废重学(上游可能给模型升级)
// 只认**明确的"不支持"措辞**。刻意不收 invalid / unknown / unrecognized —— 那几种更可能是
// 我们自己的 tools schema 写错了, 记成"这个模型不行"会让好模型被长期跳过, 而用户完全看不出原因。
const NO_TOOLS_RE = /(?:tools?|functions?|tool_choice|function\s*calling)[\s\S]{0,80}?(?:not\s+support|unsupport|doesn'?t\s+support|does\s+not\s+support|isn'?t\s+support)|(?:not\s+support|unsupport|doesn'?t\s+support|does\s+not\s+support)[\s\S]{0,60}?(?:tools?|function\s*calling)/i
// p 传 provider 对象(兼容旧的传名字字符串)。noTools 里的条目过期即自动恢复支持。
function modelSupportsTools(p, id) {
  const s = MODEL_NO_TOOLS.get(typeof p === 'string' ? p : (p && p.name))
  if (s && s.has(id)) return false
  const nt = p && p.noTools && p.noTools[id]
  if (nt) return (Date.now() - new Date(nt.at).getTime()) > NO_TOOLS_TTL_MS
  return true
}
// 这个请求是不是要用工具。⚠ 空数组陷阱: !![] === true —— 只看字段存在会把"带了空的 tools: []"
// 的纯对话请求也误伤。必须看长度; tool_choice 是对象/字符串, 存在即代表要用工具。
// pickChain(挑候选) 与 attemptChain(实测学习) 共用同一判据, 两处各写一份迟早会不一致。
function payloadWantsTools(payload) {
  return !!(payload && (
    (Array.isArray(payload.tools) && payload.tools.length > 0) ||
    (Array.isArray(payload.functions) && payload.functions.length > 0) ||
    payload.tool_choice
  ))
}

// ── 视觉能力感知: 请求带图片时, 别把纯文本模型排在最前面 ──
// 背景(2026-09-29): 免费池里纯文本模型占绝大多数, 且它们通常比视觉模型更快、更不容易撞限流 ——
// 于是带图请求的 auto 链会把纯文本模型排在前列, 必然撞一次"不支持图片输入"的 400, 白搭一次往返,
// 池子小时甚至整链失败。这与 tools 那条缺口是同一类问题, 所以用同一套机制解决:
//   ① 名字启发式(visionLikely) 负责**降档** —— 带图请求里"名字没有视觉信号"的模型不领跑(仍是候选);
//   ② 实测学习(noVision) 负责**跳过** —— 上游以明确措辞拒绝图片时记下来, 之后带图请求硬跳过它。
// 宁可漏判: 判不准只是顺序偏一点, 不会拿不到答案(与 TIER_SPECIALIST_RE 同一取舍)。
const VISION_RE = /(^|[\/:._-])(vl|vision|visual|multimodal|omni|llava|pixtral|internvl|moondream)([\/:._-]|\d|$)|minicpm-v|qwen[\d.]*-?vl|gpt-4o|gpt-4\.1|gpt-4-turbo|gpt-5|claude|gemini|glm-4v|step-1v|yi-vision|idefics/i
const NO_VISION_TTL_MS = 30 * 86400000   // 与 noTools 同口径: 实测结论 30 天后作废重学
// 只认**明确的"不支持图片"措辞**(双向, 因为各家语序不同)。刻意不收 invalid/unknown ——
// 那更可能是我们自己把 payload 组坏了, 记成"模型不行"会让好模型被长期跳过且用户看不出原因。
const NO_VISION_RE = /(?:image|vision|visual|multimodal|图片|图像|视觉|多模态|image_url)[\s\S]{0,60}?(?:not\s+support|unsupport|doesn'?t\s+support|does\s+not\s+support|isn'?t\s+support|not\s+accept|doesn'?t\s+accept|cannot\s+(?:process|handle|read|understand|see)|unable\s+to\s+(?:process|handle|read))|(?:not\s+support|unsupport|doesn'?t\s+support|does\s+not\s+support|cannot\s+(?:process|handle|read|understand)|unable\s+to\s+(?:process|handle))[\s\S]{0,60}?(?:image|vision|visual|multimodal|图片|图像)/i

// 名字里有没有视觉信号 —— 只用于"降档", 判不准最坏只是排名偏一点。
function visionLikely(id) { return VISION_RE.test(String(id || '')) }
// 是否已**实测确知**不支持图片(硬跳过; 过期自动恢复, 与 modelSupportsTools 同构)。
function modelVisionBlocked(p, id) {
  const nv = p && p.noVision && p.noVision[id]
  return !!(nv && (Date.now() - new Date(nv.at).getTime()) <= NO_VISION_TTL_MS)
}

// ── 容量记忆: 实测"这个模型装不下这么大的请求"(2026-10-05 加) ──
// 与 noTools / noVision 同一套实测学习, 只是闸门从"带没带 tools/图片"换成"请求有多大"。
// 背景: `groq/openai/gpt-oss-120b` 在 WorkBuddy 的真实大请求上**每次都撞 413**
//   (`Request too large for model ...`, 2026-10-05 实测两次), 而它常排在链首附近 ——
//   每次都要白等一个完整往返才换下一家。这与 noTools 那次是同一类浪费, 就该用同一套机制省掉。
// ⚠ 记的是"**撞墙时的规模**": 撞过 50000 字符说明它吃不下 50000, 但 30000 仍可以试它 ——
//   所以取**历次撞墙的最小规模**, 而不是一撞就永久拉黑(它是"这轮太大", 不是"这模型坏了")。
// ⚠ 判据留 20% 余量: 规模是按字符估算的, 卡在临界值上反复横跳最坏(打一次、跳过、又打)。
const CTX_LIMIT_TTL_MS = 30 * 86400000   // 与 noTools 同口径: 30 天后作废重学(上游可能放宽限额)
function modelCtxLimit(p, id) {
  const r = p && p.ctxLimit && p.ctxLimit[id]
  if (!r) return 0
  if (Date.now() - new Date(r.at).getTime() > CTX_LIMIT_TTL_MS) return 0
  return r.chars || 0
}
// 这个请求对该模型来说是不是"太大"(实测过**同样或更小**规模的请求被它拒收)
function modelCtxTooBig(p, id, reqChars) {
  const lim = modelCtxLimit(p, id)
  return !!(lim && reqChars && reqChars >= lim * 0.8)
}
// 这个请求是不是带图片。四种入口(OpenAI/Anthropic/Gemini/Ollama)都先归一成 OpenAI payload
// 再进路由, 所以这里只认 OpenAI 形态: content 是数组且含 image_url / image part。
// ⚠ 只认数组形态 —— 纯文本 content 是字符串, 走老路径, 行为一个字节都不变。
function payloadWantsVision(payload) {
  const msgs = payload && Array.isArray(payload.messages) ? payload.messages : []
  for (const m of msgs) {
    const c = m && m.content
    if (!Array.isArray(c)) continue
    for (const part of c) {
      if (part && typeof part === 'object' && (part.type === 'image_url' || part.type === 'image' || part.image_url)) return true
    }
  }
  return false
}

// ── 能力分档: auto 原来只有"谁快用谁"一个维度, 于是稳定地选中最快但最弱的模型 ──
// 实测(2026-09-18): 带 tools 的请求, auto 链前 8 名里 6 个是 mistral 的 ministral-3b/8b/14b,
// 而池里最有脑子的 gemini-3.x-flash 系列排在第 9 名开外 —— 这就是"auto 不聪明"的直接原因。
//
// 判据全部来自**模型名里已有的信号**, 不维护手工名单: 免费池每天在变, 手工名单第二天就过期。
// 设计取舍: 信息不足时给**中性偏上的默认档(2 = 通用)**, 而不是沉底 ——
// 宁可让一个未知模型参与竞争, 也不要因为"名字里没有参数量"就把它判成弱模型。
const TIER_STRONG_RE = /(^|[\/:._-])(ultra|opus|max|super|reasoning|thinking|think|pro)([\/:._-]|$)/i
const TIER_WEAK_RE = /(^|[\/:._-])(nano|tiny|mini|lite|light|lightning|small|fast|air|instant)([\/:._-]|$)/i
// 专用模型(代码/数学/垂直领域微调): 在**不对口**的任务(写作、分析、多轮对话、开放式问答)上
// 明显弱于同档通用模型, 而免费池里它们常因为"响应快、不撞限流"而排到最前。
// 实测(2026-09-25): auto 稳定选中 mistral 的 codestral-2508(代码模型), 用户在 WorkBuddy 里的
// 体感是"auto 比手动直接连一家差多了"。判据仍只用名字里已有的信号, 不维护手工名单。
// ⚠ `med` 这种短词不要加 —— 会命中 mistral-medium-3-5 这类通用模型。
const TIER_SPECIALIST_CODE_RE = /(^|[\/:._-])(codestral|devstral|codex|coder|code)([\/:._-]|\d|$)/i
const TIER_SPECIALIST_MATH_RE = /(^|[\/:._-])(mathstral|math)([\/:._-]|\d|$)/i
const TIER_SPECIALIST_VERT_RE = /(^|[\/:._-])(fin|finance|legal|law|medical)([\/:._-]|\d|$)/i
// ── 任务类型: "这道题是什么题" ──
// 与 requestTier("要几档")、estTurns("要几轮") 并列的第三个维度, 三者回答的是不同问题:
//   requestTier -> 需要多强的模型;  estTurns -> 单轮能容忍多久;  detectTask -> **需要哪种模型**。
// 为什么必须有这一维(2026-10-05): 专用模型以前**无差别降两档**, 于是"写代码"这个最该用
// codestral 这类模型的场景反而把它们压到队尾 —— 通用模型来写代码, 体感就是"auto 不如手动选一家"。
// 现在按题目走: **对口 +1, 不对口才 -2**。判据全部来自文本里已有的信号, 不维护手工模型名单。
//
// ⚠ 只看**最后一条用户消息**, 不看 system prompt —— WorkBuddy 的 system prompt 里本来就满是
//   "read files / edit / code" 这类词, 拿它判题会让每个请求都变成代码任务(实测过这个误判)。
// ⚠ 门槛刻意高: 宁可判成"通用"(退回原来的行为), 也不要因为一个词把题判偏 —— 判错只是排名
//   偏一点, 不会拿不到答案(与 requestTier 同一取舍: 只降权, 不硬过滤)。
const CODE_TASK_RE = /```|代码|函数|算法|脚本|编译|报错|重构|单元测试|接口|正则|数据库|调试|\b(bug|fix|refactor|compile|debug|regex|stack ?trace|npm|git|docker|sql|function|class|import|const|def|return|async|await|TypeError|undefined|null pointer)\b/gi
const CODE_FILE_RE = /\.(js|mjs|cjs|ts|tsx|jsx|py|java|go|rs|cpp|hpp|cs|php|rb|swift|kt|sql|sh|bash|bat|ps1|json|ya?ml|toml|html|css|scss|vue|svelte|rs|h)\b/i
const MATH_TASK_RE = /计算|求解|方程|证明|积分|导数|微分|矩阵|概率|排列组合|数列|统计|公式|\b(solve|equation|integral|derivative|matrix|probability|combinatorics|prove|theorem|formula|algebra)\b/gi
function detectTask(payload) {
  if (!payload || !Array.isArray(payload.messages)) return 'general'
  // 从后往前找**最后一条 user 消息**: agent 多轮里 tool 结果不是"题目", 拿它判题会被文件内容带偏
  let text = ''
  for (let i = payload.messages.length - 1; i >= 0; i--) {
    const m = payload.messages[i]
    if (!m || m.role !== 'user') continue
    const c = m.content
    if (typeof c === 'string') text = c
    else if (Array.isArray(c)) text = c.map((x) => (x && typeof x.text === 'string') ? x.text : '').join(' ')
    break
  }
  if (!text) return 'general'
  text = text.slice(0, 8000)      // 只看开头一段, 别为判题遍历整篇(热路径, 省下来的是每轮的时间)
  const codeHits = (text.match(CODE_TASK_RE) || []).length + (CODE_FILE_RE.test(text) ? 1 : 0)
  const mathHits = (text.match(MATH_TASK_RE) || []).length
  if (codeHits >= 2 && codeHits >= mathHits) return 'code'
  if (mathHits >= 2 && mathHits > codeHits) return 'math'
  return 'general'
}
// task 是**可选的第二个参数**: 不传时行为与改造前完全一致(专用模型一律 -2)。
// 这样"按任务类型选模型"这件事只影响真的带上了题面判断的调用点, 不会偷偷改掉别处的排序。
function modelTier(id, task) {
  const name = String(id || '').replace(/^.*\//, '')
  let score = 3                       // 中性起点: 未知 = 通用档
  // ① 总参数量: 550b / 120b / 30b-a3b / 14b / 8b / 3b
  const bs = [...name.matchAll(/(\d+(?:\.\d+)?)\s*b(?![a-z0-9])/gi)].map((m) => parseFloat(m[1]))
  const totalB = bs.length ? Math.max(...bs) : 0
  if (totalB >= 300) score += 3
  else if (totalB >= 100) score += 2
  else if (totalB >= 30) score += 1
  else if (totalB > 0 && totalB <= 4) score -= 3
  else if (totalB > 0 && totalB <= 10) score -= 2
  else if (totalB > 0 && totalB <= 20) score -= 1
  // ② 档位词
  if (TIER_STRONG_RE.test(name)) score += 1
  if (TIER_WEAK_RE.test(name)) score -= 1
  // ③ 专用模型: **对口 +1, 不对口 -2**(只调权重, 不排除 —— 留在链上照样会被用到)。
  //    垂直领域(金融/法律/医疗)没有对应的任务判据, 所以恒走 -2, 与改造前一致。
  const domain = TIER_SPECIALIST_CODE_RE.test(name) ? 'code'
    : TIER_SPECIALIST_MATH_RE.test(name) ? 'math'
      : TIER_SPECIALIST_VERT_RE.test(name) ? 'vertical' : null
  if (domain) score += (domain === task) ? 1 : -2
  return Math.max(0, Math.min(3, Math.round(score / 2)))
}

// ── 请求规模(字符数) ──
// 两个消费者: ① requestTier 估 token 分档; ② 容量记忆 modelCtxLimit(见 markFail)。
// ⚠ 必须**把工具定义算进去**: WorkBuddy 的一次 agent 请求里 tools 的 JSON 常比 messages 还大,
//   只算 messages 会把"实际很大的请求"量成小请求 —— 而 413 恰恰常常是工具定义撑爆的。
// 抽成一个函数是为了让"分档"与"容量判据"共用**同一份**规模口径, 两处各算一次迟早分叉。
function payloadChars(payload) {
  if (!payload) return 0
  let chars = 0
  const msgs = Array.isArray(payload.messages) ? payload.messages : []
  for (const m of msgs) {
    const c = m && m.content
    if (typeof c === 'string') chars += c.length
    else if (Array.isArray(c)) { try { chars += JSON.stringify(c).length } catch {} }
  }
  const tl = payload.tools || payload.functions
  if (Array.isArray(tl) && tl.length) { try { chars += JSON.stringify(tl).length } catch {} }
  return chars
}

// ── 上下文降级: 请求比池里所有模型都大时, 裁一段历史再发, 而不是直接说"模型不在池里" ──
// 背景(2026-10-23): 免费池的窗口普遍很小(8k~32k), 而 agent 客户端会把整段历史原样发过来。
// 这时链上每个候选都被 modelCtxTooBig 挡掉 -> 链空 -> 报"模型不在任何已启用供应商的可用池里"。
// 用户看到的是"池里明明有模型, 网关却说没有", 完全看不出病因是"太大" —— 而这本来是**能答**的:
// 丢掉中段历史、留下 system + 最近几轮, 模型照样接得上话。
//
// 三条硬约束(每一条都是"不做就会更糟"):
//   ① **system 全留**。删掉系统提示 = 模型不再遵守指令, 比报错更糟(它会自信地乱答)。
//   ② **tools 不裁**。工具定义是能力声明, 裁掉一半 = 客户端以为能调、上游看不到。所以先把
//      tools 的额度扣掉, 扣完不够就**放弃裁剪**(返回 null, 调用方走原来的报错)。
//   ③ **role:"tool" 必须带着它的 assistant.tool_calls 一起留**。孤立的一条 tool 消息在
//      OpenAI 协议里非法, 上游回 400 —— 那只是把"太大"换成了另一个错误。
//
// ⚠ 只保留**开头连续的** system 消息, 中间的 system 当普通历史处理: 把中间的系统提示提到队首
//   会改变语义(它可能是某个阶段的临时指令), 而"重排消息"这种改动是最难被发现的那种。
// ⚠ 只裁字符串 content; 多模态数组里截 text part, image_url 原样保留(它只是一条 URL, 占不了多少,
//   删掉图片等于把用户的问题换掉了)。
const COMPACT_RATIO = 0.7   // 裁到"实测撞墙规模"的 70%: 与 modelCtxTooBig 的 0.8 同思路, 留余量
const COMPACT_MARK = (n) => `\n…[网关已省略 ${n} 字符以适配模型上下文窗口]…\n`

function msgChars(m) {
  const c = m && m.content
  if (typeof c === 'string') return c.length
  if (Array.isArray(c)) { try { return JSON.stringify(c).length } catch { return 0 } }
  return 0
}

// 把一段 content 压到 max 字符以内, 返回 [新content, 省下的字符数]。
// 字符串保留头 60% + 尾 40%: 开头通常定调("你是…"), 结尾通常是紧邻的指令, 中段是最可丢的。
function clipContent(c, max) {
  if (typeof c === 'string') {
    if (c.length <= max) return [c, 0]
    const head = Math.floor(max * 0.6)
    const tail = Math.max(0, max - head)
    const cut = c.length - head - tail
    const s = c.slice(0, head) + COMPACT_MARK(cut) + (tail ? c.slice(-tail) : '')
    return [s, c.length - s.length]
  }
  if (Array.isArray(c)) {
    // 只截 text part(从最长的开始); image_url 等原样保留
    const parts = c.map((p) => (p && typeof p === 'object' ? { ...p } : p))
    const idx = parts.map((p, i) => [p && p.type === 'text' && typeof p.text === 'string' ? p.text.length : 0, i])
      .filter(([n]) => n > 0).sort((a, b) => b[0] - a[0])
    let over = 0
    try { over = JSON.stringify(c).length - max } catch { return [c, 0] }
    if (over <= 0) return [c, 0]
    const before = JSON.stringify(c).length
    for (const [, i] of idx) {
      if (over <= 0) break
      const t = parts[i].text
      const keep = Math.max(120, t.length - over)
      const head = Math.floor(keep * 0.6)
      const tail = Math.max(0, keep - head)
      const nt = t.slice(0, head) + COMPACT_MARK(t.length - head - tail) + (tail ? t.slice(-tail) : '')
      over -= t.length - nt.length
      parts[i].text = nt
    }
    const after = JSON.stringify(parts).length
    return [parts, Math.max(0, before - after)]
  }
  return [c, 0]
}

// 把 payload 裁到 budget 字符以内。裁不动(或裁了也没省下多少)返回 null。
// 返回 { payload, before, after, dropped, truncated } —— dropped 是丢掉的历史条数。
function compactPayload(payload, budget) {
  if (!payload || !Array.isArray(payload.messages)) return null
  if (!(budget > 0)) return null
  const before = payloadChars(payload)
  if (before <= budget) return null            // 本来就不用裁
  const msgs = payload.messages
  const isSys = (m) => m && (m.role === 'system' || m.role === 'developer')

  // tools 先占额度 —— 裁不动就放弃(见上面约束②)
  let fixed = 0
  const tl = payload.tools || payload.functions
  if (Array.isArray(tl) && tl.length) {
    try { fixed += JSON.stringify(tl).length } catch { return null }
  }
  if (fixed >= budget * 0.9) return null

  // 开头连续的 system 全留; 单条超长时截它内部(不删条)
  let sysEnd = 0
  while (sysEnd < msgs.length && isSys(msgs[sysEnd])) sysEnd++
  const sys = msgs.slice(0, sysEnd).map((m) => ({ ...m }))
  let truncated = 0
  let sysChars = sys.reduce((n, m) => n + msgChars(m), 0)
  const sysBudget = Math.floor(budget * 0.5) - fixed
  if (sysChars > sysBudget && sysBudget > 0) {
    let over = sysChars - sysBudget
    const order = sys.map((m, i) => [msgChars(m), i]).sort((a, b) => b[0] - a[0])
    for (const [len, i] of order) {
      if (over <= 0) break
      const [c, saved] = clipContent(sys[i].content, Math.max(200, len - over))
      if (saved > 0) { sys[i].content = c; over -= saved; truncated++ }
    }
    sysChars = sys.reduce((n, m) => n + msgChars(m), 0)
  }

  // 历史: 从尾部往前保留, 直到额度用完
  const hist = msgs.slice(sysEnd)
  const remain = budget - fixed - sysChars
  if (remain <= 0) return null
  let used = 0
  let start = hist.length
  while (start > 0) {
    const len = msgChars(hist[start - 1])
    if (used + len > remain) break
    used += len
    start--
  }
  if (start >= hist.length) return null        // 一条都放不下 -> 预算算错了, 别硬裁
  // 起点不能落在 role:"tool" 上(见约束③): 往前吞到它的 assistant.tool_calls 为止
  while (start > 0 && hist[start] && hist[start].role === 'tool') start--

  const kept = [...sys, ...hist.slice(start)]
  const out = { ...payload, messages: kept }
  const after = payloadChars(out)
  // 没省下多少(<5%) 或仍超预算 -> 放弃, 让调用方走原来的路径(宁可漏裁, 不可裁了个半吊子)
  if (after >= before * 0.95 || after > budget) return null
  return { payload: out, before, after, dropped: hist.length - (hist.length - start), truncated }
}

// ── 请求分档: 一个"带 30 个工具定义的多轮 agent 请求"和一句闲聊, 需要的模型完全不同 ──
// 返回值是"这道题至少需要几档的模型"; 它有两个消费者, **两个都只做降权, 不做硬过滤** ——
// 硬过滤会让池子小的厂商直接空链, 而"排在后面"最差也只是慢一点, 不会拿不到答案:
//   ① weightsFor(): 决定"速度 vs 档位"谁更重要(闲聊靠速度选出快的, agent 靠档位选出强的);
//   ② pickChain 里的 tierShort(): 档位**低于这道题要求**的模型不领跑(见那里的说明)。
function requestTier(payload) {
  if (!payload) return 1
  const msgs = Array.isArray(payload.messages) ? payload.messages : []
  let need = 1
  const wantsTools = (Array.isArray(payload.tools) && payload.tools.length > 0) ||
    (Array.isArray(payload.functions) && payload.functions.length > 0)
  if (wantsTools) need = 2                       // 工具调用: 小模型基本必然调错或漏调
  // 带图片: 视觉理解是"看图说话", 小模型容易看漏或凭空瞎编(上游根本不支持视觉时更会硬编一个答案)。
  // 与 tools 同一取舍 —— 只抬"这道题至少需要几档", 不做硬过滤(硬过滤会让池子小的厂商直接空链)。
  // 注意这与 pickChain 里的 visionMismatch 是**两件事**: 那个管"谁排前面"(视觉匹配), 这个管"要几档"。
  if (payloadWantsVision(payload)) need = Math.max(need, 2)
  if (msgs.length >= 6) need = Math.max(need, 2) // 多轮: 需要稳定的指令跟随
  // 粗略估算 prompt 规模(不引 tokenizer, 只为分档): 中英混排按 ~3 字符/token 估
  const estTok = Math.round(payloadChars(payload) / 3)
  if (estTok > 120000) need = 3
  else if (estTok > 32000) need = Math.max(need, 2)
  return need
}

// ── 预估"这个请求在一次任务里会被调用多少轮" ──
// 目的: 让"多慢算慢"的标准随轮次收紧(见 pickChain 里的 speedBudgetMs)。
// 关键洞察: agent 是多轮的, 慢 2s × 20 轮 = 多 40s; 而闲聊单轮 10s 也能接受。
// 所以变的**不是"速度 vs 能力谁重要"**(速度一直重要), 而是"单轮能容忍多久"。
// 用评分基准的动态化来表达, 而不是去改 W_AGENT/W_CHAT 里那些固定权重数字 ——
// 后者换个场景又要重新拍一个数, 而"任务越长单轮预算越紧"是连续可解释的。
// ⚠ 只用于调评分基准, 不做硬过滤 —— 估错最坏也只是排名偏一点, 不会拿不到答案。
function estTurns(payload) {
  if (!payload) return 1
  const msgs = Array.isArray(payload.messages) ? payload.messages : []
  const wantsTools = (Array.isArray(payload.tools) && payload.tools.length > 0) ||
    (Array.isArray(payload.functions) && payload.functions.length > 0) ||
    !!payload.tool_choice
  let n = 1
  if (wantsTools) n = 4                            // 带工具定义 = 大概率多轮 agent
  n += Math.min(4, Math.floor(msgs.length / 4))    // 对话越长, 越可能在任务中后段
  return Math.max(1, Math.min(8, n))               // 封顶, 别让单个信号把基准拉爆
}

// ── "慢到不该再领跑": 平均延迟(EMA)超过阈值, 且至少有 2 次采样 ──
// 这条来自 2026-09-17 的真实事故: AMD 的 TTFB 飙到 55348ms, 而它历史失败率最低(9/62),
// 老排序因此总把它排第一, 每次 auto 都要先干等它 55 秒才回退 —— 用户侧就是"发条消息转一分钟"。
// ⚠ 但当时是用 `lastTtfb`(**单次采样**)做的硬门槛: 一次网络抖动就能把一个完全正常的供应商
// 踢到队尾, 而且要等它下次成功才恢复。现在改成看 EMA 平均延迟 + 采样数:
// 需要"持续地慢"才降权, 一次不算 —— 与排序里"样本量决定置信度"是同一个原则。
const SLOW_EMA_MS = 20000
const isVerySlow = (x) => (x.ref.latN || 0) >= 2 && (x.ref.latency || 0) > SLOW_EMA_MS
// ── "最近打不通就不领跑": 失败后降一档, 30 分钟后自动恢复领跑资格 ──
// 与 isVerySlow 同类(都是"降一档"的软门槛, 不是 bad 那种硬门槛)。定义放在这里而不是 markFail
// 旁边: 它是 markFail / markOk / pickChain 三处共用的常量, 放在使用点之后会变成 TDZ 隐患
// (现在靠"函数调用发生在模块执行完之后"才没事, 太脆弱)。
// ⚠ 必须有**期限**, 不能只看窗口 —— 只看窗口会死锁: 降级 → auto 不优先调它 → 它没机会成功 →
//   永远降级。实测(2026-09-25) gemini 家连挂之后, 池里最强的 `gemini-3.8-flash` 就这样被雪藏:
//   它的窗口里永远是那几条软失败, 再也不会被调到, 也就永远恢复不了。
//   到点自动放它回去试探, 再失败就再降 —— 与 rpmCap 的"棘轮必须自愈"是同一条原则。
const RECENT_DOWN_MS = 30 * 60 * 1000

function modelRouteType(id, meta) {
  const raw = String(id || '')
  // 有些上游不把功能写在模型名里，优先相信它明确给出的输出模态。
  const out = meta && (Array.isArray(meta.output) ? meta.output
    : (meta.architecture && meta.architecture.output_modalities))
  if (Array.isArray(out) && out.length) {
    const values = out.map((x) => String(x).toLowerCase())
    // 只要能输出 text，就是可用于对话的多模态模型；不要因它也能看图就错杀。
    if (!values.some((x) => /text|chat|message/.test(x))) {
      const shown = values.slice(0, 3).join('/')
      return { chat: false, kind: '非文本输出', reason: `上游元数据输出为 ${shown || '非文本'}` }
    }
  }
  for (const [kind, re] of MODEL_KIND_RULES) if (re.test(raw)) return { chat: false, kind, reason: `${kind}不适用于文字对话路由` }
  return { chat: true, kind: '文字对话', reason: '可接入 /chat/completions' }
}

// 硬排除黑名单（优先级最高，压过一切白名单/元数据/hybrid 判定）：
// 上游清单源偶尔混入已确认收费的模型 —— 实测 gemini-2.5-pro 被列进免费清单，
// 但 Google 免费层早已不含 Pro（见 FREE_RULES 注释），放行=静默扣费风险。
// 命中此表的一律不进免费池，且每日同步时从白名单里剔除。
const DENY_FREE = [/(^|[\/:._-])pro([\/:._-]|$)/i]

// ── 免费判定：结果 + 依据 ──
// judgeFree 与改造前的 isFree **判定结果逐条等价** —— 只是每个出口额外说明"为什么"。
// 动机：判定不可解释 = 不可审计 = 不可验证。外人只能相信 README 的叙述，无法自己核对。
// ⚠ 出口顺序与原实现严格一一对应；改这里必须同步核对下面 isFree 的历史行为（钱袋子逻辑）。
function judgeFree(pname, id, meta, provider) {
  const say = (free, layer, reason, extra) => Object.assign({ free, layer, reason }, extra || {})
  //  硬排除优先：名单/元数据说免费也没用
  if (DENY_FREE.some((re) => re.test(String(id)))) {
    return say(false, 'deny', '命中硬排除表：名字含独立词 pro，上游免费清单常误收已收费的 pro 模型')
  }
  // 非文字对话模型(语音/嵌入/审核/图像等)即使免费也不接入: 这个网关的统一入口是 /chat/completions。
  // modelRouteType 同时识别名称与上游 output_modalities，避免名字像聊天模型的 OCR 被漏进来。
  const rt = modelRouteType(id, meta)
  if (!rt.chat) return say(false, 'not-chat', `非文字对话模型：${rt.reason}`, { kind: rt.kind })
  // 限时免费活动已过期 -> 视为收费, 不放进免费池(防止 auto 静默产生账单)
  const promo = promoOf(pname, id)
  if (promo && promo.expired) return say(false, 'promo-expired', '限时免费活动已过期，按收费处理')
  // ① 上游元数据优先: 明确免费直接收下; 可信厂商明确收费直接弃掉
  const byMeta = metaIsFree(meta)
  if (byMeta === true) return say(true, 'meta', '上游元数据明确免费（:free 硬标记，或 pricing 各项全 0）')
  if (byMeta === false && PRICING_TRUSTED.has(pname)) {
    return say(false, 'meta-paid', `${pname} 属可信定价厂商，上游元数据明确收费`)
  }
  // ② 每日白名单(封闭名单厂商的主判据): 在名单内=免费; openFree 厂商名单外仍放行(其 key 看不到收费模型);
  //    封闭厂商名单外 = 不免费(即使名字像 flash/lite 也不放行 —— 这正是 glm-5.3-flash 误判的根源)
  const wl = whitelistFor(provider)
  if (wl) {
    if (wl.models.some((x) => sameId(x, id))) {
      // 免 Key 端点(anon): 依据比"源声称"更硬 —— 无 Key 实测调通过, 且没有账号 = 没有扣费通道。
      // 单独出一个出口只为可解释性: 仪表盘的"为什么免费"要能分清"实测"与"抄来的"。
      // ⚠ 它只覆盖**名单内**的模型; 名单外仍按下面的封闭名单语义处理(不放行) —— 免 Key 端点
      //   若是个聚合器(匿名可列 600+ 模型), 全放行会把付费模型的镜像也塞进池子。
      if (wl.anon) {
        return say(true, 'anon-free', `免 Key 端点实测可调用（无账号，无扣费通道${wl.anonModel ? '；试通模型 ' + wl.anonModel : ''}）`, { source: wl.source || null })
      }
      return say(true, 'whitelist', `在每日同步的免费白名单内（来源：${wl.source || '未标注'}）`, { source: wl.source || null })
    }
    if (byMeta === false) return say(false, 'meta-paid', '上游元数据明确收费，且白名单未收录')
    if (wl.openFree) {
      return say(true, 'open-free', '开放视野厂商：免费 Key 看不到收费模型，可见即免费')
    }
    if (!wl.hybrid) {
      return say(false, 'closed-list', '封闭名单厂商：不在每日同步的免费名单内，一律视为收费（防 flash/lite 类名字误判）')
    }
    // hybrid: 名单外交给下面的规则兜底(如 gemini 新 preview 命名口径稳定)
  }
  // ③ 无白名单的厂商(自定义 base_url): 可信收费元数据已判过, 其余走兜底规则
  if (byMeta === false) return say(false, 'meta-paid', '上游元数据明确收费')
  const rule = FREE_RULES[pname] || FREE_DEFAULT
  try {
    const ok = !!rule(id, meta)
    return say(ok, 'rule', ok
      ? '兜底规则命中（模型名含独立词 free）'
      : '兜底规则未命中：既无免费元数据、也不在免费名单内，按收费处理')
  } catch {
    return say(false, 'rule-error', '兜底规则执行出错，按收费处理')
  }
}
// 对外保持原签名与原语义：三个调用点(gateUnverifiedModels / scanProvider / fetchfree)一行都不用改。
function isFree(pname, id, meta, provider) {
  return judgeFree(pname, id, meta, provider).free
}
function isRecommended(pname, id) {
  const rec = RECOMMENDED[pname] || []
  if (rec.some((r) => id.toLowerCase().includes(r.toLowerCase()))) return true
  // 只看"模型名"部分(最后一个 / 之后), 避免把厂商名误当能力特征(如 thinkingmachines/inkling 被 "thinking" 命中)
  const base = id.includes('/') ? id.slice(id.lastIndexOf('/') + 1) : id
  return REC_PATTERN.test(base)
}

// ── 免费校验闸门（防静默扣费的最后一道口子）──
// 背景: 仪表盘在 /api/fetchfree 认不出任何免费模型时, 会放开"手动填写模型名"的输入框。
// 手动填的名字**绕过了 isFree 过滤**, 若直接进 p.models 就等于进了 auto 路由池。
// 而收费模型的调用通常返回 200 —— 全池体检只按"有没有报错"判定, 对它是瞎的, 于是会一直静默计费。
// 所以: 任何"非扫描来源"的模型名都必须再过一次 isFree, 没过的先隔离(不进 auto 池)。
//   · 目录扫描确认它确实在免费池 -> scanProvider 会自动解除隔离并放回池(自动转正)
//   · 用户确信它免费 -> 仪表盘「解除」按钮一键放行(显式人工确认)
//   · 全程不影响正常路径: /api/fetchfree 勾选来的模型本来就过了 isFree, 这里会直接放行。
function gateUnverifiedModels(p, models) {
  const unverified = []
  p.quarantine = p.quarantine || {}
  const pname = String(p.name || '').toLowerCase()
  for (const m of models || []) {
    if (!m) continue
    if (isFree(pname, m, null, p)) {
      // 之前被这道闸门隔离、现在校验通过了 -> 解除(只解除闸门自己加的, 不动扫描隔离的)
      if (p.quarantine[m] && p.quarantine[m].gate) delete p.quarantine[m]
      continue
    }
    if (p.quarantine[m]) continue // 已被扫描隔离, 不覆盖原有原因
    p.quarantine[m] = { at: new Date().toISOString(), gate: true, reason: '未通过免费校验（手动填写或非扫描来源），未进入 auto 池；目录扫描确认其在免费池会自动放回，确认免费也可手动解除' }
    unverified.push(m)
  }
  return unverified
}

let catalog = null
function loadCatalog() {
  if (catalog) return catalog
  try { catalog = JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf8')) } catch { catalog = null }
  return catalog
}
function saveCatalog(c) {
  catalog = c
  writeJsonAtomic(CATALOG_PATH, c)
}
// 简单并发限流器: 避免一次并发打爆上游 / 代理
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length)
  let i = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx], idx) }
  })
  await Promise.all(workers)
  return out
}

// ── 拉黑复审: "永久拉黑"不是死刑, 是缓刑 ──
// 厂商常先把模型下架/转收费、过段时间又放回免费池。被拉黑的模型每过 REVIEW_DAYS 天,
// 网关自动发一条最小请求实测: 200 = 已恢复 -> 解除拉黑(池同步会自动放回 auto);
// 仍 402/404/收费特征 = 维持拉黑, 更新时间戳, 下个周期再试。
const REVIEW_DAYS = 1
async function reviewBlocked(changes, at) {
  const tasks = []
  for (const p of CFG.providers) {
    if (!p.blocked) continue
    for (const [model, info] of Object.entries(p.blocked)) {
      const since = new Date(info.at || 0).getTime()
      if (Date.now() - since < REVIEW_DAYS * 86400000) continue
      const keys = providerKeys(p)
      const key = keys[0] || p.api_key
      if (!key) continue
      tasks.push((async () => {
        try {
          const up = await forward(p, { model, max_tokens: 4, messages: [{ role: 'user', content: 'ping' }] }, 30000, key)
          const text = await readBody(up)
          const kind = up.statusCode < 400 ? 'ok' : classifyUpstreamError(up.statusCode, text)
          // ok = 恢复可用; quota/ratelimit/overloaded = 模型还活着且免费, 只是暂时受限 -> 也应解除拉黑放回池
          if (kind === 'ok' || kind === 'quota' || kind === 'ratelimit' || kind === 'overloaded') {
            delete p.blocked[model]
            saveConfig()
            changes.push({ at, provider: p.name, label: p.label || p.name, type: 'unblock', model, note: kind === 'ok' ? `拉黑满 ${REVIEW_DAYS} 天, 实测已恢复可用, 自动解除` : `复审发现模型仍在(仅${kind === 'quota' ? '额度' : kind === 'ratelimit' ? '限流' : '过载'}受限), 自动解除拉黑放回池` })
            console.log(`[review] ${p.name}/${model}: 解除拉黑 (${kind})`)
          } else {
            info.at = new Date().toISOString() // 仍不可用, 顺延下个复审周期
            info.reason = `HTTP ${up.statusCode} ${text.slice(0, 100)}`
            saveConfig()
          }
        } catch {
          info.at = new Date().toISOString() // 网络失败不解除, 但避免每次刷新都重试
          saveConfig()
        }
      })())
    }
  }
  if (tasks.length) await Promise.all(tasks)
}

// ── 全池体检(防静默扣费的核心闸门) ──
// 名单源和 /models 只证明"厂商说免费"，证明不了"你的账号现在真能免费调"。
// 厂商会悄悄改政策(实测: Cerebras 2026-07-21 把永久 Free 档砍成 $5 试用金+绑卡门槛)。
// 所以对每家 auto 池里的全部模型主动发一条最小请求:
//   billing/retired -> markFail 直接拉黑(复审机制兜底恢复) | quota/ratelimit/overloaded -> 冷却到期自动回
//   auth -> 冷却该 Key | 网络错误 -> 跳过本轮, 绝不误判
// 成本: 每模型一次 "ping"(max_tokens=4), 池子几十模型几分钟扫完, 只在后台跑不占用户请求。
//
// 间隔为什么从 20h 压到 6h(2026-09-17):
//   最危险的不是"调用报错"，而是"调用不报错、直接按折扣价结算"(B.AI 2026-09-16 把
//   Qwen3.8-Flash/Hy3/MiMo-V2.5 从 0 Credits 改成"限时 1 折"，接口不返回任何计费错误)。
//   这种静默转收费只有真实试调才能发现，体检间隔就等于"最坏被扣费时长"。
//   20h 太长，压到 6h 与目录扫描同频 —— 池子几十个模型 × 4 次/天 ≈ 百余条 max_tokens=4 的
//   极小请求，对各家免费额度可忽略，却把静默扣费窗口缩短了 70%。
//   取 5 而非 6 是刻意的: 体检由 refreshCatalog(6h 定时) 驱动, 而 lastSweepAt 在体检"跑完之后"
//   才写入。若阈值正好 6h, 下次刷新时实际间隔只有 6h 减去体检耗时(如 6h-30s) -> 判定未到期而跳过,
//   体检会退化成 12h 一次。留 1 小时余量, 保证每个 6h 周期都真正体检。
const SWEEP_INTERVAL_H = 5
async function sweepPool(changes, at) {
  const tasks = []
  for (const p of CFG.providers) {
    if (p.enabled === false) continue
    const models = providerModels(p)
    if (!models.length) continue
    if (p.lastSweepAt && Date.now() - new Date(p.lastSweepAt).getTime() < SWEEP_INTERVAL_H * 3600000) continue
    const keys = providerKeys(p)
    if (!keys.length) continue
    tasks.push((async () => {
      // 分别统计三类结果。为什么必须分开记: 见下面 lastSweepAt 的写入条件。
      // ── 第一阶段: 只探活收集, 不落判 ──
      // 为什么必须分两阶段(2026-09-21 改): 原先"边探边 markFail", 于是判断依据只有单个模型的结果,
      // 分不清"个别模型挂了"和"整家一起挂了"。商汤那次 8 个模型全 404, 会被逐个拉黑 —— 而真凶是
      // Key 没有模型权限。聚合之后才能把"整家 404/401"识别成账号级问题, 不冤枉任何模型。
      const stat = { total: models.length, ok: 0, httpFail: 0, netErr: 0, notFound: 0, auth: 0 }
      const probes = []
      await mapLimit(models, 2, async (m) => {
        const ki = pickKeyIdx(p, Date.now())
        const key = ki >= 0 ? keys[ki] : keys[0]
        try {
          const up = await forward(p, { model: m, max_tokens: 4, messages: [{ role: 'user', content: 'ping' }] }, 30000, key)
          const text = await readBody(up)
          probes.push({ m, ki, status: up.statusCode, text })
        } catch { stat.netErr++ /* 网络/代理失败不判死刑, 下轮再扫 */ }
      })
      // ── 聚合判定: 整家是不是"账号级看不到模型" ──
      // 成立条件(三条同时满足, 刻意严格 —— 宁可漏判成模型下架, 也不轻易豁免真下架):
      //   ① 有模型返回 404/401       ② 没有任何一个模型成功
      //   ③ 所有失败**都是** 404/401 类型(混着 402 计费错误时不算, 那说明是模型各自的政策问题)
      const failProbes = probes.filter((x) => x.status >= 400)
      const accessFail = failProbes.filter((x) => /^(notfound|auth)$/.test(classifyUpstreamError(x.status, x.text)))
      const okCount = probes.filter((x) => x.status < 400).length
      if (accessFail.length && !okCount && accessFail.length === failProbes.length) {
        setAccountIssue(p, 'no_access', `全池 ${accessFail.length} 个模型均返回 404/401 —— 更像该 Key 没有模型权限或接入点路径不对, 而非逐个模型下架`)
        console.warn(`[sweep] ${p.name}: 判定为账号级无模型权限(${accessFail.length} 个模型全 404/401), 本轮不拉黑任何模型, 只冷却`)
      } else if (okCount) {
        clearAccountIssue(p) // 有模型调通 = 账号确实能看到模型, 旧标记作废
      }
      // ── 第二阶段: 落判 ──
      for (const x of probes) {
        if (x.status < 400) { stat.ok++; markOk(p, x.m, x.ki); continue }
        stat.httpFail++
        const kind = classifyUpstreamError(x.status, x.text)
        if (kind === 'notfound') stat.notFound++
        if (kind === 'auth') stat.auth++
        markFail(p, x.status, x.m, 0, x.ki, x.text)
        if (isBlocked(p, x.m)) {
          changes.push({ at, provider: p.name, label: p.label || p.name, type: 'sweep_block', model: x.m, note: `每日体检发现不可用（${kind === 'billing' ? '已转收费/免费档取消' : kind === 'retired' ? '已下架/账号无权限' : kind + '异常'}），已自动拉黑`} )
          console.log(`[sweep] ${p.name}/${x.m}: 拉黑 (${kind})`)
        }
      }
      const nowIso = new Date().toISOString()
      p.lastSweep = { at: nowIso, ...stat }
      // ⚠ 只有在"至少一个模型真的收到了上游 HTTP 响应"时, 才把本轮记为已完成。
      // 否则(整池全是网络错误, 典型是代理没开/断网)绝不能更新 lastSweepAt ——
      // 那样仪表盘会显示绿色「免费体检 刚刚」, 而实际上一条都没验到, 闸门等于谎报成功。
      // 不更新 lastSweepAt 的后果是: 仪表盘按"上次真实体检时间"计时, 超过 8 小时自然变橙色告警,
      // 且下个周期会重扫 —— 这正是我们要的失败可见性。
      const reachedUpstream = stat.ok + stat.httpFail > 0
      if (reachedUpstream) {
        p.lastSweepAt = nowIso
        console.log(`[sweep] ${p.name}: 全池体检完成 (${stat.total} 个模型: 正常 ${stat.ok} / 上游报错 ${stat.httpFail} / 网络失败 ${stat.netErr})`)
      } else {
        console.warn(`[sweep] ${p.name}: 全池体检未生效 —— ${stat.total} 个模型全部网络失败(代理未开或断网), 本轮不记为已完成, 下个周期重扫`)
      }
      saveConfig()
    })())
  }
  if (tasks.length) await Promise.all(tasks)
}

// 拉取所有已配置供应商的模型列表, 过滤免费 + 标注推荐
async function refreshCatalog() {
  // 白名单超过 6h 没更新(网关长期没重启的场景) -> 扫描前先补一次同步, 保证用最新口径
  const wl = loadWhitelist()
  if (!wl || Date.now() - new Date(wl.fetched_at || 0).getTime() > 6 * 3600 * 1000) {
    await syncUpstreamWhitelist().catch(() => {})
  }
  const prev = loadCatalog()
  const prevMap = new Map()
  if (prev && Array.isArray(prev.providers)) for (const e of prev.providers) prevMap.set(e.name, e)

  const providers = CFG.providers.filter((p) => p.enabled !== false)
  const at = new Date().toISOString()
  const changes = []
  // 公告页巡检刚发现的"免费活动结束/开始"变动, 并入本次目录变动记录, 让用户在仪表盘看得见
  if (pendingPromoChanges.length) { changes.push(...pendingPromoChanges); pendingPromoChanges = [] }
  // 并发扫描(限 4 路): 各家互不依赖, 并行把"逐家等十几秒"压到几秒
  const results = await mapLimit(providers, 4, (p) => scanProvider(p, prevMap.get(p.name), at, changes))

  // ── 拉黑复审: 被"已下架/转收费"拉黑的模型, 每天(REVIEW_DAYS)自动做一次最小实测 ──
  // 上游若恢复免费 -> 解除拉黑, 下面的池同步会自动把它放回 auto 池; 仍失败 -> 顺延到下个每日复审周期再试
  await reviewBlocked(changes, at)

  // ── 路由池同步: 每次刷新(含启动)后, 把各家的 auto 池替换为目录里的免费列表 ──
  // 这样"新转免费"的模型自动进池, "已下架/转收费"的自动出池, 无需手动维护 models[]
  for (const r of results) {
    if (r.error || !Array.isArray(r.models) || !r.models.length) continue
    const p = CFG.providers.find((x) => x.name === r.name)
    if (!p) continue
    const free = r.models.map((m) => m.id).filter((id) => !isBlocked(p, id) && !(p.quarantine && p.quarantine[id]))
    if (!free.length) continue // 全被拉黑/隔离 -> 不动池(保留原模型, 靠复审/人工恢复), 避免掏空后残留 undefined
    const cur = (p.models && p.models.length) ? p.models : [p.model]
    if (free.join('|') !== cur.filter(Boolean).join('|')) {
      p.models = free
      p.model = free[0]
      if (p.disabledModels) for (const k of Object.keys(p.disabledModels)) if (!free.includes(k)) delete p.disabledModels[k] // 已不在池中的勾选记录清掉
      saveConfig()
      changes.push({ at, provider: p.name, label: r.label, type: 'pool_sync', model: '', note: `auto 路由池已同步为免费目录 (${free.length} 个模型)` })
      console.log(`[pool] ${p.name}: 路由池同步 ${cur.length} -> ${free.length} 个模型`)
      // ── 免费模型数量"大幅"变化 -> 单独提示一条 ──
      // 逐模型的 added/removed 会淹没整体规模的突变(一次掉 12 个就是 12 条噪音),
      // 而用户真正要警惕的是"这家是不是把免费档砍了 / 是不是上新了活动" —— 那是**规模信号**。
      // 阈值: 绝对差 ≥3 且相对差 ≥30%(25→22 不算, 25→5 才算; 1→2 也不算)。
      const prevN = cur.filter(Boolean).length
      const d = free.length - prevN
      if (prevN > 0 && Math.abs(d) >= 3 && Math.abs(d) / prevN >= 0.3) {
        const pct = Math.round(Math.abs(d) / prevN * 100)
        changes.push({
          at, provider: p.name, label: r.label,
          type: d > 0 ? 'pool_up' : 'pool_down', model: '',
          note: `免费模型 ${prevN} → ${free.length}（${d > 0 ? '+' : ''}${d} · ${d > 0 ? '↑' : '↓'}${pct}%）`,
        })
        console.log(`[pool] ${p.name}: 免费模型数量大幅变化 ${prevN} -> ${free.length}`)
      }
    }
  }

  // ── 每日全池体检: 池内所有模型主动试调一遍, 厂商悄悄改政策(如 Cerebras 砍免费档)当天踢出 ──
  await sweepPool(changes, at)

  const prevChanges = (prev && Array.isArray(prev.changes)) ? prev.changes : []
  const merged = [...changes, ...prevChanges].slice(0, 300) // 保留最近 300 条
  const cat = {
    updated_at: at,
    ruleset: { version: RULESET.version, verified_at: RULESET.verified_at, review_days: RULESET.review_days },
    providers: results,
    changes: merged,
  }
  saveCatalog(cat)
  console.log(`[catalog] ${at} 更新完成, ${results.filter((r) => !r.error).length}/${results.length} 家成功, 变动 ${changes.length} 条`)
  scheduleCatalogRetry(results)   // 有失败则安排 5 分钟后自动补扫, 不让用户干等到下一轮定时扫描
  return cat
}

// 扫描单家供应商: 拉模型 -> 判免费 -> 记录变动 -> 自动隔离
async function scanProvider(p, old, at, changes) {
  const entry = { name: p.name, label: p.label || p.name, base_url: p.base_url, error: '', models: [] }
  try {
    const list = await listUpstreamModelsWithKeys(p) // [{id, meta}]
    const ids = list.map((x) => x.id)
    entry.total = ids.length
    // 扫描到的非对话模型也要留下"被排除"的可解释记录：用户能知道不是漏扫，
    // 而是它们的接口用途不同，刻意不接入文字对话池。只留前 24 个，避免一个大厂
    // 的音频/嵌入模型把 catalog.json 撑得很大。
    entry.excluded = list.map((x) => ({ id: x.id, type: modelRouteType(x.id, x.meta) }))
      .filter((x) => !x.type.chat)
      .slice(0, 24)
      .map((x) => ({ id: x.id, kind: x.type.kind, reason: x.type.reason }))
    entry.excluded_total = list.reduce((n, x) => n + (modelRouteType(x.id, x.meta).chat ? 0 : 1), 0)
    // ⚠ 判定依据（why = 判定所在层）**必须和结论一起落盘**：
    //   上游元数据(pricing/output_modalities)在扫描结束后就丢弃了，不留 layer 的话，
    //   "这个模型当时凭什么进池"事后无从查起 —— 判定不可追溯 = 不可审计（见 /api/why）。
    //   只存层名不存 reason 文案：同一层的文案是常量，/api/why 重建即可，避免 catalog 里
    //   几百条模型各存一份重复长句。
    entry.models = list
      .map((x) => ({ x, v: judgeFree(p.name, x.id, x.meta, p) }))
      .filter((o) => o.v.free)
      .map((o) => ({
        id: o.x.id, rec: isRecommended(p.name, o.x.id), promo: promoOf(p.name, o.x.id), type: '文字对话',
        why: o.v.layer,
      }))
    // 白名单来源是**厂商级**的（同一 host 同一个源），存一次即可
    entry.why_source = (() => { const w = whitelistFor(p); return w ? (w.source || null) : null })()

    const nowSet = new Set(entry.models.map((m) => m.id))
    // ── 入池探活: 新进入免费池的模型先发一条真实最小请求验"账号可调"再入池 ──
    // 教训(Cerebras gemma-4-31b): /models 是橱窗 —— 列出的模型账号未必有调用权限(404),
    // 厂商宣称免费也不代表你的账号已激活免费档(402)。列表只能证明"存在", 探活才能证明"能用"。
    // 只探新增模型(每次扫描通常 0~3 个), 控制开销; 网络失败不误判, 跳过留待下次。
    const probeTargets = entry.models.filter((m) => !oldOkCheck(old).has(m.id) && !isBlocked(p, m.id) && !(p.quarantine && p.quarantine[m.id]))
    if (probeTargets.length) {
      const keys = providerKeys(p)
      const probeKey = keys[pickKeyIdx(p, Date.now())] || keys[0] || p.api_key
      if (probeKey) {
        await mapLimit(probeTargets, 2, async (m) => {
          try {
            const up = await forward(p, { model: m.id, max_tokens: 4, messages: [{ role: 'user', content: 'ping' }] }, 30000, probeKey)
            const text = await readBody(up)
            if (up.statusCode >= 400) {
              markFail(p, up.statusCode, m.id, 0, -1, text) // billing/retired 会被拉黑
              if (isBlocked(p, m.id)) {
                changes.push({ at, provider: p.name, label: entry.label, type: 'probe_block', model: m.id, note: '入池探活发现账号不可调用，未入池（每日复审自动恢复）' })
                console.log(`[probe] ${p.name}/${m.id}: 探活失败, 拒绝入池`)
              }
            }
          } catch { /* 网络失败不判死刑, 下次扫描再探 */ }
        })
        saveConfig()
      }
    }
    function oldOkCheck(o) { return new Set(o && !o.error && Array.isArray(o.models) ? o.models.map((x) => x.id) : []) }
    // 标记已被拉黑/隔离的模型: 目录仍展示(信息透明), 但带状态且不算推荐
    for (const m of entry.models) {
      if (p.blocked && p.blocked[m.id]) { m.dead = 'blocked'; m.dead_reason = (p.blocked[m.id].reason || '').slice(0, 120); m.rec = false }
      else if (p.quarantine && p.quarantine[m.id]) { m.dead = 'quarantine'; m.dead_reason = (p.quarantine[m.id].reason || '').slice(0, 120); m.rec = false }
    }
    const oldSet = oldOkCheck(old)
    const oldOk = !!(old && !old.error && Array.isArray(old.models))

    // ── 变动追踪: 与上一次扫描结果对比 ──
    if (oldOk) {
      for (const m of entry.models) {
        if (!oldSet.has(m.id)) {
          const isPromo = !!m.promo && !m.promo.expired
          changes.push({ at, provider: p.name, label: entry.label, type: isPromo ? 'promo_start' : 'added', model: m.id, note: isPromo ? (m.promo.note || '限时免费活动开始') : '新进入免费池' })
        }
      }
      for (const om of old.models) {
        if (!nowSet.has(om.id)) {
          const exp = om.promo && om.promo.until && new Date(om.promo.until) <= new Date()
          changes.push({ at, provider: p.name, label: entry.label, type: exp ? 'promo_end' : 'removed', model: om.id, note: exp ? `限时活动到期（至 ${om.promo.until}）` : '已不在免费池（可能转收费或下架）' })
        }
      }
    }

    // ── 自动隔离: 已接入但这次扫描不在免费池的模型 -> 踢出路由(下次恢复自动放回) ──
    // 安全阀: 上游返回空列表 / 免费池突然归零 —— 更像接口或规则异常, 不是真的全下架, 跳过隔离避免误伤
    p.quarantine = p.quarantine || {}
    let cfgDirty = false
    // ⚠ 空列表要分两种, 处置不同(2026-09-21):
    //   · ids.length === 0 -> **确定性**信号: /v1/models 是 HTTP 200 但 data 为空(拉取失败会抛错,
    //     见 listUpstreamModels), 说明这个 Key 一个模型都看不到 = 账号级问题。必须显式记下来,
    //     否则下游会把它当成"逐个模型下架", 把整家拉黑(商汤 8 个模型的连坐就是这么来的)。
    //   · nowSet.size === 0 && oldSet.size > 0 -> /models 有模型但一个都不免费, 这才是"免费档没了",
    //     属于规则判定结果, 不该记成账号问题。
    if (ids.length === 0) {
      setAccountIssue(p, 'no_models', '上游 /v1/models 返回空列表 —— 该 Key 看不到任何模型（账号未开通 / 额度用尽 / Key 类型不对 / 接入点路径不对）, 不是模型下架')
      entry.note = '上游返回空模型列表（该 Key 看不到任何模型）, 已跳过自动隔离'
      saveConfig()
      return entry
    }
    if (p.accountIssue) { clearAccountIssue(p); cfgDirty = true } // /v1/models 有内容 = 账号看得到模型, 旧的账号级标记作废
    if (nowSet.size === 0 && oldSet.size > 0) {
      entry.note = '免费池本次为空, 已跳过自动隔离'
      if (cfgDirty) saveConfig()
      return entry
    }
    const configured = ((p.models && p.models.length) ? p.models : [p.model]).filter(Boolean)
    // ⚠ 复查范围必须把"已在隔离中"的模型也算进来, 不能只遍历 p.models。
    // 原因: refreshCatalog 里的 pool_sync 会把隔离模型从 p.models 摘掉(它们不在免费池), 于是
    // 从下一个周期起它们就不再出现在 p.models 里 —— 只遍历 p.models 的话它们永远不再被检查,
    // 即使厂商恢复免费也回不来(用户反馈的"已隔离的模型重扫不回来"就是这个 bug)。
    const watchList = [...new Set([...configured, ...Object.keys(p.quarantine)])]
    for (const m of watchList) {
      const q = p.quarantine[m]
      if (nowSet.has(m)) {
        // 在免费池里 -> 若之前被隔离, 现在解除(它会被 pool_sync 自动放回路由池)
        if (q) {
          delete p.quarantine[m]
          cfgDirty = true
          changes.push({ at, provider: p.name, label: entry.label, type: 'release', model: m, note: '重新出现在免费池，自动恢复' })
        }
      } else if (!q && configured.includes(m)) {
        // 在池里但这次不在免费池 -> 隔离
        p.quarantine[m] = { at, reason: `目录扫描未发现其仍在免费池（可见 ${ids.length} 个模型）` }
        cfgDirty = true
        changes.push({ at, provider: p.name, label: entry.label, type: 'quarantine', model: m, note: '已接入但本次未出现在免费池，自动隔离' })
      }
    }
    if (cfgDirty) saveConfig()
  } catch (e) {
    entry.error = e.message
  }
  return entry
}
let catalogRefreshing = false
async function refreshCatalogSafe() {
  if (catalogRefreshing) return catalog
  catalogRefreshing = true
  try { return await refreshCatalog() } finally { catalogRefreshing = false }
}
// 扫描出现失败(尤其"全挂")通常是瞬时网络中断 —— 实测 2026-09-17 20:38 一次断网导致 4/4 全失败,
// 页面就一直是"拉取失败", 要干等到下一轮定时扫描。这里安排短期自动补扫。
//
// ⚠ 2026-10-18 重做, 起因: 用户"自动补扫不要被暂停, 尝试数量应该自动增加"。
//   原来按**轮数**熔断(连续 3 轮有失败就永久停手), 只要有 1 家常驻失败就会把计数顶满并卡死 ——
//   实测 10-18 日志: gemini(地区限制 400) + empero(端点 503 下线) 常驻失败, 计数早已到 3,
//   于是**任何其它厂家**的瞬时失败都再也拿不到补扫, 等于用 1 个坏厂家换掉 8 个好厂家的自愈能力。
//   现在改成按**失败集合**判断:
//     · 还是同一批人失败 = 持续性故障(地区限制/端点下线), 退避重试, 到上限后只停这一批;
//     · 出现新面孔 = 情况变了, 计数清零重新给机会(常驻失败者不再拖累别人);
//     · 全成功 = 清零。
//   轮数上限 3 → 5, 间隔 5 分钟起指数退避(5/10/20/40/80), 总覆盖 155 分钟而不是原来的 15 分钟。
//   另加一道兜底: 失败集合在 {gemini} 与 {gemini,empero} 之间反复横跳会让计数一直归零,
//   所以按 6 小时窗口限总补扫次数 12 次, 防止变成每 5 分钟一次的刷屏式重试。
const RETRY_MAX = 5
const RETRY_BASE_MS = 5 * 60 * 1000
const RETRY_CAP_MS = 80 * 60 * 1000
const RETRY_WINDOW_MS = 6 * 3600 * 1000
const RETRY_WINDOW_MAX = 12
let catalogRetry = { n: 0, timer: null, sig: '', total: 0, winStart: 0 }
function scheduleCatalogRetry(results) {
  if (!Array.isArray(results) || !results.length) return
  const failed = results.filter((r) => r.error)
  const names = failed.map((r) => r.label || r.name)
  if (!failed.length) { catalogRetry.n = 0; catalogRetry.sig = ''; return }   // 全成功 -> 重置
  const sig = names.slice().sort().join(',')
  if (sig !== catalogRetry.sig) { catalogRetry.n = 0; catalogRetry.sig = sig }  // 换人失败 -> 重新计数
  if (catalogRetry.n >= RETRY_MAX) {
    console.error(`[catalog] ${sig} 连续 ${catalogRetry.n} 轮补扫仍失败(持续性故障), 这批暂停补扫, 等下一轮定时扫描`)
    return
  }
  const now = Date.now()
  if (!catalogRetry.winStart || now - catalogRetry.winStart > RETRY_WINDOW_MS) { catalogRetry.winStart = now; catalogRetry.total = 0 }
  if (catalogRetry.total >= RETRY_WINDOW_MAX) {
    console.error(`[catalog] 6 小时内已补扫 ${catalogRetry.total} 次(上限 ${RETRY_WINDOW_MAX}), 暂停到下一轮定时`)
    return
  }
  if (catalogRetry.timer) clearTimeout(catalogRetry.timer)
  catalogRetry.n++
  catalogRetry.total++
  const waitMs = Math.min(RETRY_BASE_MS * Math.pow(2, catalogRetry.n - 1), RETRY_CAP_MS)
  console.warn(`[catalog] ${results.length - failed.length}/${results.length} 家成功, 失败: ${names.join(',')} —— ${Math.round(waitMs / 60000)} 分钟后自动补扫(第 ${catalogRetry.n}/${RETRY_MAX} 轮)`)
  catalogRetry.timer = setTimeout(() => {
    catalogRetry.timer = null
    refreshCatalogSafe().catch((e) => console.error('[catalog]', e.message))
  }, waitMs)
  if (catalogRetry.timer && catalogRetry.timer.unref) catalogRetry.timer.unref()
}

// ---------------- 配置 ----------------
// 配置损坏恢复记录: 一旦发生就通过 /api/state 回传, 让仪表盘显式告警, 而不是悄悄吞掉。
let CONFIG_RECOVERED = null

function loadConfig() {
  let raw = null
  try { raw = fs.readFileSync(CONFIG_PATH, 'utf8') } catch {}
  if (raw !== null) {
    try {
      const cfg = JSON.parse(raw)
      if (cfg && typeof cfg === 'object' && !Array.isArray(cfg)) return cfg
      throw new Error('配置内容不是对象')
    } catch (e) {
      // ⚠ 这里以前是"生成新随机 gatewayKey + 空 providers 并立刻 saveConfig 写盘" ——
      // 等于把 7 家真实 API Key 一次性抹掉, 而且用户毫无察觉、也没有备份。
      // 现在改成: 只把损坏文件改名留档, 绝不覆盖; 并优先尝试从 .prev 恢复。
      const ts = new Date().toISOString().replace(/[:.]/g, '-')
      const bak = CONFIG_PATH + '.corrupt.' + ts
      try { fs.renameSync(CONFIG_PATH, bak) } catch {}
      CONFIG_RECOVERED = { at: new Date().toISOString(), backup: path.basename(bak), error: String((e && e.message) || e), restoredFrom: null }
      console.error(`[config] 配置解析失败(${(e && e.message) || e}), 已备份为 ${path.basename(bak)}`)
    }
  }
  // 优先从原子写留下的上一份恢复 —— 它带着真实 providers, 比"空配置"强得多
  try {
    const prev = JSON.parse(fs.readFileSync(CONFIG_PATH + '.prev', 'utf8'))
    if (prev && typeof prev === 'object' && Array.isArray(prev.providers) && prev.providers.length) {
      if (CONFIG_RECOVERED) CONFIG_RECOVERED.restoredFrom = 'config.json.prev'
      else CONFIG_RECOVERED = { at: new Date().toISOString(), backup: null, error: null, restoredFrom: 'config.json.prev' }
      console.warn(`[config] 已从 config.json.prev 恢复 ${prev.providers.length} 家供应商`)
      return prev
    }
  } catch {}
  return {
    port: 8787,
    // ⚠ 默认就带上当前版本号。不写的话首启(还没有 config.json 时)会被当成 v1 走一遍迁移,
    // 而迁移的第一步是"备份 config.json" —— 文件根本不存在, 于是每次首启都在日志里留一条
    // "迁移前备份失败, 跳过迁移" 的 WARN, 看起来像项目坏了。版本号跟上就不触发。
    configVersion: 2,
    // ⚠ 默认直连。这里以前硬编码了开发机上的代理端口 ——
    // 对任何别人来说那都是个不存在的代理, 首启即 "connect ECONNREFUSED", 看起来像项目坏了。
    // 海外厂商需要代理时在仪表盘「代理」里填, 端口按自己软件的实际值(Clash 常见 7890)。
    proxy: '',
    gatewayKey: 'freegw-' + crypto.randomBytes(16).toString('hex'),
    // 入站并发上限(只作用于"调用模型"的端点)。0 = 不限, 与改造前行为一致。
    // 想给免费额度上保险就写个数(比如 4): 超出的请求排队等待, 排队超时或队满回 503。
    maxConcurrent: 0,
    // 管理接口鉴权模式。默认 'local'(服务硬绑 127.0.0.1, 本机即可信, 行为与改造前一致)。
    // 要分享出去时改成 { mode: 'token', token: '<16 位以上的随机串>' } —— 见 adminAuthed 的注释。
    auth: { mode: 'local' },
    providers: [],
  }
}
// 防抖落盘。⚠ 原实现每次调用都 clearTimeout 重设 300ms, 而 markOk/markFail 每次请求成败都会调它 ——
// 高流量下定时器被无限推迟, 配置可能长时间不落盘(进程退出即丢)。现加"最长延迟 2s"兜底。
let saveTimer = null
let saveDirtyAt = 0
function saveConfig(cfg = CFG) {
  if (!saveDirtyAt) saveDirtyAt = Date.now()
  clearTimeout(saveTimer)
  const wait = (Date.now() - saveDirtyAt > 2000) ? 0 : 300
  saveTimer = setTimeout(() => {
    saveTimer = null; saveDirtyAt = 0
    try { writeJsonAtomic(CONFIG_PATH, cfg) } catch (e) { console.error('[config] 写盘失败', (e && e.message) || e) }
  }, wait)
}
const CFG = loadConfig()
// 网关 Key 兜底: 手抄 config.example.json 或手工编辑时很容易把它留空/写短。
// 空 Key 会让所有 /v1 请求 401(表现为"客户端怎么都连不上"), 短 Key 则可被猜。
// 只补不覆盖 —— 已有合规 Key 一律不动, 免得把用户正在用的 Key 换掉。
if (typeof CFG.gatewayKey !== 'string' || CFG.gatewayKey.length < 16) {
  const wasEmpty = !CFG.gatewayKey
  CFG.gatewayKey = 'freegw-' + crypto.randomBytes(16).toString('hex')
  console.warn(`[config] 网关 Key ${wasEmpty ? '缺失' : '过短(<16 位)'}，已自动生成新值 —— 完整值见仪表盘「统一出口」卡`)
  try { saveConfig() } catch {}
}
// 别名表: 老配置文件里没有这个字段。补一个空的**并落盘** —— 目的是让 config.json 自文档化,
// 用户打开文件就能看到"原来这里可以配别名", 不必先来翻 README。
if (!CFG.aliases || typeof CFG.aliases !== 'object' || Array.isArray(CFG.aliases)) {
  CFG.aliases = {}
  try { saveConfig() } catch {}
}
// 路由组: 同样自文档化地补一个空对象。用户打开 config.json 看到 "groups": {}
// 才会想到"原来还能把几个模型打包成一个名字"。
if (!CFG.groups || typeof CFG.groups !== 'object' || Array.isArray(CFG.groups)) {
  CFG.groups = {}
  try { saveConfig() } catch {}
}

// ---------------- 多 Key 与速率学习 ----------------
function providerKeys(p) {
  if (Array.isArray(p.keys) && p.keys.length) return p.keys
  return p.api_key ? [p.api_key] : []
}
// 旧配置迁移: api_key -> keys[]
for (const p of CFG.providers) {
  if (!Array.isArray(p.keys) || !p.keys.length) p.keys = p.api_key ? [p.api_key] : []
  if (!p.keyCooldown) p.keyCooldown = {}
  // 逐 Key 的人工启停与使用统计(见 /api/providers/:id/keys)。默认空, 老配置无感。
  if (!p.keyStats) p.keyStats = {}
  if (!p.keyDisabled) p.keyDisabled = {}
}

// ---------------- config.json 热重载 ----------------
// 为什么需要: 手工编辑 config.json(改 proxy / 换一个 Key / 加别名)以前**不生效**, 必须重启 ——
// 这是最容易让人困惑的一类问题("我明明改了怎么没用"), 也正是本文件里反复出现的那个主题。
//
// ⚠ 为什么**不是**"把文件读回来整体覆盖 CFG": config.json 里同时存着**运行时状态**
//   (cooldownUntil / modelLat / keyStats / modelQ / quarantine / blocked / ctxLimit …)。
//   整体覆盖会把内存里累积的冷却与拉黑名单换成磁盘上那份更旧的快照 ——
//   而"冷却状态丢了"等于防扣费防线被重置回出厂状态(见 flushAll 的注释)。
//   所以这里只合并**人能手工编辑的纯配置字段**, 运行时字段一律保留内存值。
//
// ⚠ 为什么 watch **目录**而不是 watch 文件: writeJsonAtomic 是"写 .tmp → 备份 → rename",
//   rename 之后原文件对象已经被换掉, 直接 watch 文件在 Windows 上从此收不到事件
//   (表现为"热重载只在第一次管用")。watch 目录 + 按文件名过滤才是稳的。
const CFG_PURE_KEYS = ['proxy', 'maxConcurrent', 'auth', 'gatewayKey', 'aliases', 'groups',
  // 2026-10-23: 两个"出问题要能立刻关掉"的开关 —— 它们必须支持热重载, 否则关掉要重启网关,
  // 而重启会丢冷却/拉黑这些运行时状态(等于把防扣费防线重置回出厂), 代价比开关本身大得多。
  'coalesce', 'retryOnRateLimit']
// 外部改动留痕（2026-10-17）：热重载只合并纯配置键，以前合并完只打一行服务端日志 ——
// 用户在编辑器里改了什么、有没有被忽略，界面上完全看不出来。记最后一批改动给仪表盘显示。
let CFG_DRIFT = null
let LAST_PURE_CHANGED = []
// 供应商身上"人能手工编辑"的字段。**其余字段一律保留内存值** —— 它们是运行时学出来的。
const PROV_PURE_KEYS = ['name', 'label', 'base_url', 'needs_proxy', 'enabled', 'model', 'models',
  'api_key', 'keys', 'anon', 'headers']
// 端口改了没法热生效(server 已经 listen 在旧端口上)。记下来交给仪表盘明说"重启后生效" ——
// 假装生效会让用户以为启动脚本坏了, 比不提示更糟。
let CFG_PORT_PENDING = 0
let cfgReloadTimer = null
const cfgProvKey = (p) => (p && p.id) ? 'id:' + p.id : 'url:' + String((p && p.base_url) || '').replace(/\/+$/, '').toLowerCase()
function cfgPureView(cfg) {
  const pick = (o, keys) => keys.map((k) => [k, o[k] === undefined ? null : o[k]])
  return {
    top: pick(cfg, CFG_PURE_KEYS),
    providers: (Array.isArray(cfg.providers) ? cfg.providers : []).map((p) => pick(p, PROV_PURE_KEYS)),
  }
}
function applyPureConfig(next) {
  const changed = []
  for (const k of CFG_PURE_KEYS) {
    if (!(k in next)) continue
    if (JSON.stringify(CFG[k]) === JSON.stringify(next[k])) continue
    CFG[k] = next[k]
    changed.push(k)
  }
  if (typeof next.port === 'number' && next.port !== CFG.port) {
    if (CFG_PORT_PENDING !== next.port) console.warn(`[config] 端口改为 ${next.port} —— 需要重启网关才生效(当前仍监听 ${CFG.port})`)
    CFG_PORT_PENDING = next.port
  } else if (CFG_PORT_PENDING && next.port === CFG.port) CFG_PORT_PENDING = 0
  // 供应商: 只更新**已存在**的那几家。按 id 认; 手工写的条目没有 id, 退回按 base_url 认。
  const cur = new Map(CFG.providers.map((p) => [cfgProvKey(p), p]))
  const added = []
  for (const np of Array.isArray(next.providers) ? next.providers : []) {
    const hit = cur.get(cfgProvKey(np))
    if (!hit) { added.push(np.name || np.base_url || '?'); continue }
    for (const f of PROV_PURE_KEYS) {
      if (!(f in np)) continue
      if (JSON.stringify(hit[f]) === JSON.stringify(np[f])) continue
      hit[f] = np[f]
      changed.push(`${hit.name}.${f}`)
    }
    // 老配置只有 api_key 没有 keys[] —— 改了 api_key 就得同步 keys[], 否则 providerKeys() 仍读旧数组。
    if ('api_key' in np && !Array.isArray(np.keys)) hit.keys = np.api_key ? [np.api_key] : []
  }
  // ⚠ 新增供应商**故意不在这里接** —— 接入要走 gateUnverifiedModels 的免费校验闸门,
  //   绕过它等于让手工写进去的收费模型直接进池, 撞上本项目最贵的那条红线(钱袋子宁可漏判, 不可错判)。
  //   所以只明确提示"请重启", 而不是半吊子地塞进去。
  if (added.length) {
    console.warn(`[config] 检测到新增供应商 ${added.join('、')} —— 热重载只合并已有供应商的改动;`
      + ' 新增的请重启网关(双击 小鸡开关.bat 选 [3] Restart)完成接入与免费校验, 以免未校验的收费模型进池。')
  }
  if (changed.length) {
    console.log(`[config] 已热重载: ${changed.slice(0, 12).join(', ')}${changed.length > 12 ? ` 等 ${changed.length} 项` : ''}`)
    // 勾选/取消模型会改变 /v1/models 的返回 —— 与 handleAdmin 的写请求入口同一处理,
    // 否则用户改完要等满 30 秒缓存过期才生效(又是一次"改了没用")。
    MODELS_CACHE.at = 0
  }
  LAST_PURE_CHANGED = changed.slice()
  return changed.length
}
// 快照回滚的合并规则（2026-10-17）：**只取快照里的纯配置键**，运行时状态一律保留当前值。
// 为什么不做整份覆盖：config.json 里混着冷却 / 拉黑 / 实测学习，整份盖回去等于把防扣费防线
// 重置回出厂状态（这条在热重载那里已经付过一次代价）。回滚要的是"配置退回去"，不是"失忆"。
function snapshotMerge(cur, snap) {
  const out = JSON.parse(JSON.stringify(cur))
  for (const k of CFG_PURE_KEYS.concat(['port'])) {
    if (k in snap) out[k] = JSON.parse(JSON.stringify(snap[k]))
  }
  const curMap = new Map((cur.providers || []).map((p) => [cfgProvKey(p), p]))
  const snapProvs = Array.isArray(snap.providers) ? snap.providers : []
  // 供应商集合**以快照为准**（回滚要能把误删的那家带回来、把误加的那家去掉），
  // 但每一家只取纯字段，运行时字段从当前同名/同接入点的那家继承。
  out.providers = snapProvs.map((np) => {
    const hit = curMap.get(cfgProvKey(np))
    const p = hit ? JSON.parse(JSON.stringify(hit)) : { ok: 0, err: 0, cooldownUntil: 0, lastError: '', keys: [] }
    for (const f of PROV_PURE_KEYS) if (f in np) p[f] = JSON.parse(JSON.stringify(np[f]))
    return p
  })
  return out
}
function reloadConfigFromDisk() {
  let next
  // 正写到一半 / JSON 语法错 -> 保持旧配置继续服务, 不打断、不报警(用户还在编辑器里打字)。
  try { next = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) } catch { return 0 }
  if (!next || typeof next !== 'object' || Array.isArray(next)) return 0
  // 自己刚写的那份: 纯配置投影必然与内存一致 -> 直接返回。这是防自激的**主**保险,
  // 静默窗口只是"事件别来打扰"的辅助(两道都要, 单独任何一道都有缝)。
  if (JSON.stringify(cfgPureView(next)) === JSON.stringify(cfgPureView(CFG))) return 0
  const n = applyPureConfig(next)
  if (n) CFG_DRIFT = { at: new Date().toISOString(), count: n, items: LAST_PURE_CHANGED.slice(0, 12) }
  return n
}
function watchConfigFile() {
  const arm = (delay) => {
    clearTimeout(cfgReloadTimer)
    cfgReloadTimer = setTimeout(() => {
      // 还在自己写盘的静默窗口里就**往后顺延**, 而不是丢掉这次事件 ——
      // 丢掉的话用户恰好在这 1 秒内保存的编辑会静默不生效, 比不热重载还难查。
      const left = cfgQuietUntil - Date.now()
      if (left > 0) return arm(left + 50)
      reloadConfigFromDisk()
    }, delay)
  }
  try {
    fs.watch(__dirname, { persistent: false }, (_ev, filename) => {
      // 只认 config.json。写入过程还会产生 config.json.tmp / .prev, 那些一律不理。
      if (filename && filename !== 'config.json') return
      arm(300)   // 防抖: 编辑器保存常常一次触发好几个事件
    })
  } catch (e) {
    console.warn('[config] 无法监听 config.json 变更(热重载不可用):', (e && e.message) || e)
  }
}
watchConfigFile()
// 逐 Key 管理的两个辅助:
// maskProviderKey —— 只回掩码。Key 明文存在 config.json 里, 没有任何理由把它再回传给浏览器。
// reindexKeys —— ⚠ 这是本块最容易写错的地方: keyCooldown / keyStats / keyDisabled 都是**按数组下标**
// 存的。删掉中间一个 Key 后如果不重建索引, 后面所有 Key 的冷却与统计会整体错位到隔壁 Key 上 ——
// 表现为"刚加的新 Key 一进来就是冷却中"、"删掉的 Key 的失败次数跑到别的 Key 头上", 极难排查。
function maskProviderKey(k) {
  const s = String(k || '')
  if (!s) return ''
  if (s.length <= 12) return s.slice(0, 3) + '…' + s.slice(-2)
  return s.slice(0, 6) + '…' + s.slice(-4)
}
function reindexKeys(p, removedIdx) {
  const shift = (obj) => {
    const out = {}
    for (const [k, v] of Object.entries(obj || {})) {
      const i = Number(k)
      if (!Number.isInteger(i) || i === removedIdx) continue
      out[i > removedIdx ? i - 1 : i] = v
    }
    return out
  }
  p.keyCooldown = shift(p.keyCooldown)
  p.keyStats = shift(p.keyStats)
  p.keyDisabled = shift(p.keyDisabled)
}
// 逐 Key 状态(掩码 + 冷却 + 启停 + 成败计数), 给仪表盘的 Key 管理弹层用
function keyInfoList(p) {
  const keys = providerKeys(p)
  const now = Date.now()
  return keys.map((k, i) => {
    const st = (p.keyStats && p.keyStats[i]) || {}
    const cd = (p.keyCooldown && p.keyCooldown[i]) || 0
    return {
      idx: i,
      mask: maskProviderKey(k),
      disabled: !!(p.keyDisabled && p.keyDisabled[i]),
      cooling: cd > now,
      until: cd > now ? new Date(cd).toISOString() : null,
      ok: st.ok || 0,
      err: st.err || 0,
      lastUsed: st.lastUsed || null,
    }
  })
}
function keysAllDisabled(p) {
  const keys = providerKeys(p)
  return keys.length > 0 && keys.every((_, i) => !!(p.keyDisabled && p.keyDisabled[i]))
}
// 启动清垃圾: 过期的 modelCooldown/keyCooldown 条目 + 历史脏数据(如 key 为 "undefined" 的隔离项)
// 这些条目只增不删会让 config.json 无限膨胀，且过期项已无任何路由意义
{
  const now = Date.now()
  let dirty = false
  for (const p of CFG.providers) {
    if (p.modelCooldown) for (const [k, v] of Object.entries(p.modelCooldown)) { if (!(v > now) || k === 'undefined') { delete p.modelCooldown[k]; dirty = true } }
    if (p.keyCooldown) for (const [k, v] of Object.entries(p.keyCooldown)) { if (!(v > now)) { delete p.keyCooldown[k]; dirty = true } }
    if (p.quarantine) for (const [k, v] of Object.entries(p.quarantine)) {
      // ⚠ 清理三类: ①无效键名 ②测试残留(集成测试造的假模型名, 会永久占位并让 /api/state 白白膨胀)
      //   ③超过 180 天的旧条目 —— quarantine 的语义是"扫描发现它不再免费", 半年前的结论早已失效,
      //   留着只会让 config.json 与每 8 秒的 /api/state 响应越滚越大(实测 groq 一家曾积 20 条假名)。
      //   不影响路由正确性: 真需要隔离时扫描会重新写入。
      const at = v && v.at ? new Date(v.at).getTime() : 0
      if (k === 'undefined' || k === '' || /^(fake-model|brand-new-model|test-model)/i.test(k) || (at && now - at > 180 * 86400000)) {
        delete p.quarantine[k]; dirty = true
      }
    }
    // blocked(扣费/下架拉黑)同理: 测试残留同样要清, 但**不设 TTL** —— 扣费判定宁可留着, 靠"解除"或每日复审放行
    if (p.blocked) for (const k of Object.keys(p.blocked)) {
      if (k === 'undefined' || k === '' || /^(fake-model|brand-new-model|test-model)/i.test(k)) { delete p.blocked[k]; dirty = true }
    }
    // keyStats/keyDisabled 的下标超出当前 Key 数 = 删过 Key 却没重建索引的残留, 一并清掉
    const kn = providerKeys(p).length
    for (const f of ['keyStats', 'keyDisabled']) {
      for (const k of Object.keys(p[f] || {})) { if (Number(k) >= kn) { delete p[f][k]; dirty = true } }
    }
  }
  if (dirty) saveConfig()
}
function keyCooling(p, ki, now) { return (p.keyCooldown && p.keyCooldown[ki] || 0) > (now || Date.now()) }
// 每密钥/每供应商速率学习: 滑动窗口记录请求时间, 429 时把观测值记为 rpmCap
const rateTracker = new Map() // p.id -> [ts]
function rateTrack(id) {
  const now = Date.now()
  let arr = rateTracker.get(id) || []
  arr = arr.filter((t) => now - t < 60000); arr.push(now)
  rateTracker.set(id, arr)
}
function recentReqs(id) {
  const now = Date.now()
  return (rateTracker.get(id) || []).filter((t) => now - t < 60000).length
}

// ---------------- 厂商接入点目录 ----------------
// ⚠ 这里**只描述"怎么连上这家"**（短名 / base_url / 是否走代理 / 备注），**不描述免费状态**。
// 免费状态与厂商名单本身全部由每日白名单推导（见 computePresets），所以：
//   · 白名单里冒出新厂商 -> 厂商列表里自动多一条（新厂商自动加进来）
//   · 白名单里某家免费模型归零 / 消失 -> 自动归到"已确认无免费层"（不免费的自动删掉）
//   · 备注不会被写死在列表里，界面显示的永远是"当前"状态
// 加新厂商 = 往这里补一条接入点信息（可选：不补也能出现在列表里，只是接入点需要探测）。
const VENDOR_DIR = {
  'api.groq.com': { name: 'groq', label: 'Groq', base_url: 'https://api.groq.com/openai/v1', needs_proxy: true, model: 'openai/gpt-oss-120b', note: '免费 plan 的 Key 只能看到免费模型，可见即免费' },
  'generativelanguage.googleapis.com': { name: 'gemini', label: 'Google Gemini', base_url: 'https://generativelanguage.googleapis.com/v1beta/openai', needs_proxy: true, model: 'gemini-3.5-flash', note: '免费层 flash / lite / gemma' },
  'api.mistral.ai': { name: 'mistral', label: 'Mistral', base_url: 'https://api.mistral.ai/v1', needs_proxy: true, model: 'mistral-small-2603', note: '实验层免费模型' },
  'openrouter.ai': { name: 'openrouter', label: 'OpenRouter', base_url: 'https://openrouter.ai/api/v1', needs_proxy: true, model: 'deepseek/deepseek-chat-v3-0324:free', note: ':free 后缀 + 价格元数据双重校验' },
  'api.cohere.com': { name: 'cohere', label: 'Cohere Trial', base_url: 'https://api.cohere.com/v2', needs_proxy: true, model: 'command-a-03-2025', note: '每月 1000 次免费' },
  'api.kilo.ai': { name: 'kilo', label: 'Kilo Code', base_url: 'https://api.kilo.ai/api/gateway', needs_proxy: true, model: 'openrouter/free', note: '免 Key，:free 模型池' },
  'integrate.api.nvidia.com': { name: 'nvidia', label: 'NVIDIA NIM', base_url: 'https://integrate.api.nvidia.com/v1', needs_proxy: true, model: 'meta/llama-3.3-70b-instruct', note: '开发者免费' },
  'ollama.com': { name: 'ollama', label: 'Ollama Cloud', base_url: 'https://ollama.com/api/v1', needs_proxy: true, model: 'deepseek-v4-flash', note: '需登录拿 Key，有免费额度' },
  'router.huggingface.co': { name: 'hf', label: 'Hugging Face Inference', base_url: 'https://router.huggingface.co/v1', needs_proxy: true, model: 'meta-llama/Llama-3.1-8B-Instruct', note: '每月 $0.10 额度' },
  'oai.endpoints.kepler.ai.cloud.ovh.net': { name: 'ovh', label: 'OVH AI Endpoints', base_url: 'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1', needs_proxy: true, model: 'gpt-oss-20b', note: '免 Key 匿名 2 RPM' },
  'api.cloudflare.com': { name: 'cloudflare', label: 'Cloudflare Workers AI', base_url: 'https://api.cloudflare.com/client/v4/accounts/<ACCOUNT_ID>/ai/v1', needs_proxy: true, model: '@cf/meta/llama-3.3-70b-instruct-fp8-fast', note: 'base_url 中 <ACCOUNT_ID> 换成你的账户 ID' },
  'api.siliconflow.cn': { name: 'siliconflow', label: '硅基流动', base_url: 'https://api.siliconflow.cn/v1', needs_proxy: false, model: 'Qwen/Qwen3-8B', note: '官方标注免费的模型' },
  'open.bigmodel.cn': { name: 'zhipu', label: '智谱 GLM', base_url: 'https://open.bigmodel.cn/api/paas/v4', needs_proxy: false, model: 'glm-4.7-flash', note: '官方标注免费的模型' },
  'api-inference.modelscope.cn': { name: 'modelscope', label: 'ModelScope 魔搭', base_url: 'https://api-inference.modelscope.cn/v1', needs_proxy: false, model: 'Qwen/Qwen3.5-27B', note: '每天 250 魔粒 ≈ 125 次' },
  'developer.amd.com.cn': { name: 'amd', label: 'AMD Radeon Cloud', base_url: 'https://developer.amd.com.cn/radeon/api/v1', needs_proxy: false, model: 'DeepSeek-V4-Flash', note: '每天 $10 额度、免绑卡、1M 上下文' },
  'token.sensenova.cn': { name: 'sensenova', label: '商汤日日新', base_url: 'https://token.sensenova.cn/v1', needs_proxy: false, model: 'SenseNova 6.7 Flash-Lite', note: 'Token Plan 公测 0 元/月，手机号注册免绑卡' },
  'free.empero.org': { name: 'empero', label: 'Empero 免费端点', base_url: 'https://free.empero.org/v1', needs_proxy: false, model: 'glm-5.3-flash', note: '免 Key 公共端点，官方换模型时可能短暂 503' },
  'api.llm7.io': { name: 'llm7', label: 'LLM7.io', base_url: 'https://api.llm7.io/v1', needs_proxy: true, model: '', note: '免 Key 公共网关' },
  'api.aionlabs.ai': { name: 'aionlabs', label: 'Aion Labs', base_url: 'https://api.aionlabs.ai/v1', needs_proxy: true, model: '', note: '' },
  // ── 2026-09-25 补录：白名单里有免费模型、却一直没进下拉的 5 家 ──
  // 接入点全部当场实测过（17:00，直连 TLS，逐个打印状态行/正文）：
  //   api.sambanova.ai/v1/models        -> 200 {"data":[…7 个模型…]}   探通
  //   api.ai21.com/studio/v1/models     -> 200 {"data":[]}            路径存在（匿名列不出模型）
  //   inference.api.nscale.com/v1/models-> 401 Unauthorized           路径存在，要 Key
  //   apihub.agnes-ai.com/v1/models     -> 401 Token not provided     路径存在，要 Key
  //   glhf.chat（/api/openai/v1 与 /v1）-> 直连与代理都超时            ⚠ 没验通
  // needs_proxy 按实测填：这 4 家直连就能通，不必绕代理。
  'api.sambanova.ai': { name: 'sambanova', label: 'SambaNova Cloud', base_url: 'https://api.sambanova.ai/v1', needs_proxy: false, model: 'deepseek-v3-1', note: '白名单标注免费 · 端点实测可匿名列出模型' },
  'api.ai21.com': { name: 'ai21', label: 'AI21 Labs', base_url: 'https://api.ai21.com/studio/v1', needs_proxy: false, model: 'jamba-mini-2', note: '白名单标注免费 · 需 Key（/studio/v1 实测存在）' },
  'inference.api.nscale.com': { name: 'nscale', label: 'Nscale', base_url: 'https://inference.api.nscale.com/v1', needs_proxy: false, model: 'deepseek-r1-distill-llama-70b', note: '白名单标注免费 · 需 Key' },
  'apihub.agnes-ai.com': { name: 'agnes', label: 'Agnes AI', base_url: 'https://apihub.agnes-ai.com/v1', needs_proxy: false, model: 'agnes-2.0-flash', note: '白名单标注免费 · 需 Key' },
  'glhf.chat': { name: 'glhf', label: 'Glhf.chat', base_url: 'https://glhf.chat/api/openai/v1', needs_proxy: true, model: 'meta-llama/Meta-Llama-3.1-70B-Instruct', note: '白名单标注免费 · ⚠ 实测直连与代理都超时，接入前先确认服务是否还在' },
  'api.longcat.chat': { name: 'longcat', label: '美团 LongCat', base_url: 'https://api.longcat.chat/openai/v1', needs_proxy: false, model: '', note: '已取消每日免费额度，新用户一次性赠 1000 万 tokens，之后按量计费' },
  'api.cerebras.ai': { name: 'cerebras', label: 'Cerebras 极速', base_url: 'https://api.cerebras.ai/v1', needs_proxy: true, model: '', note: '2026-07-21 起取消永久免费档，改为 $5 试用金且需绑卡' },
  // 以下几家从来不在白名单里（无免费层），保留接入点信息但会被自动归到"已确认无免费层"
  'api.deepseek.com': { name: 'deepseek', label: 'DeepSeek 官方', base_url: 'https://api.deepseek.com/v1', needs_proxy: false, model: 'deepseek-chat', note: '无免费层，仅新用户试用金', noFree: '2026-09-17' },
  'api.moonshot.cn': { name: 'kimi', label: 'Kimi', base_url: 'https://api.moonshot.cn/v1', needs_proxy: false, model: 'kimi-k2-0711-preview', note: '无免费层，仅新用户试用金', noFree: '2026-09-17' },
  'dashscope.aliyuncs.com': { name: 'bailian', label: '阿里云百炼', base_url: 'https://dashscope.aliyuncs.com/compatible-mode/v1', needs_proxy: false, model: 'qwen-flash', note: '新人每模型送 100 万 tokens、90 天有效，用完即停（需开开关）', noFree: '2026-09-17' },
  'ark.cn-beijing.volces.com': { name: 'volc', label: '火山方舟 · 豆包', base_url: 'https://ark.cn-beijing.volces.com/api/v3', needs_proxy: false, model: '', note: '需先开通方舟服务，无长期免费层', noFree: '2026-09-17' },
  'api.b.ai': { name: 'bai', label: 'B.AI', base_url: 'https://api.b.ai/v1', needs_proxy: true, model: 'Qwen3.8-Flash', note: '0 Credits 活动已于 2026-09-16 17:00 结束，相关模型调整为限时 1 折（已收费）', noFree: '2026-09-16' },
}

// 由**当前白名单**动态生成厂商列表 —— 每次调用都重新推导，所以列表本身就是每天最新的，
// 不存在"写死的厂商名单"。白名单里出现新厂商会自动多出来，某家免费模型归零会自动归到无免费层。
// 厂商列表主显示备注规则:
//   有免费档(free/promo) → 用 VENDOR_DIR 写死的接入说明(用户熟悉的"备注",如"每月 1000 次免费")
//   没免费档(paid)      → 换成动态状态(避免显示过期的"每月 1000 次免费"误导)
// 这样备注看上去是写死的(便于认)、内容却能跟白名单每天同步, 符合"每天刷新"的诉求.
// 厂商状态行该显示的新鲜度是"**我们上次同步是什么时候**", 不是 list_date。
// list_date 只是"上游清单里最新的那条数据有多新"(社区源停更时它就一直不动), 拿它当"名单版本"
// 会让用户以为白名单没在刷新 —— 实测用户就是这么问的("都 19 号了怎么还显示 9-10")。
const fmtSyncDate = (iso) => { const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? `${m[2]}-${m[3]}` : '' }

// ---------------- 候选厂商的可读名 ----------------
// 为什么需要这张表(2026-09-21 用户): "我不信每次都是那18家, 总有新的大厂给到免费模型,
// 比如阶跃星辰" —— 白名单的发现源(models.dev)其实每轮都捞到几十家新厂商, 但它们只进
// candidates 不进 hosts(用户 2026-09-19 要求过"小厂家和没测试过的别放进去"), 于是
// **发现能力一直在跑, 用户却完全看不到**, 感受就是"名单固死了"。
// 现在把候选挂到仪表盘上给用户自己挑。但候选里大量是 `api.xyz.ai` 这种裸域名,
// 用户原话"我作为普通用户都不知道那几个是干嘛的" —— 所以给已知厂商补中文名,
// 让"阶跃星辰/腾讯/火山"这类一眼能认出来。**只影响显示, 不影响任何免费判定**。
// 没收录的候选照样显示(用域名 + 来源名), 只是没有中文名而已。
const CANDIDATE_LABELS = {
  'ark.cn-beijing.volces.com': '火山方舟（字节）',
  'tokenhub.tencentmaas.com': '腾讯 TokenHub',
  'api.lkeap.cloud.tencent.com': '腾讯 Token Plan',
  'token-plan.cn-beijing.maas.aliyuncs.com': '阿里云百炼 Token Plan',
  'token-plan.ap-southeast-1.maas.aliyuncs.com': '阿里云百炼 Token Plan（新加坡）',
  'coding.dashscope.aliyuncs.com': '阿里云百炼 Coding Plan',
  'coding-intl.dashscope.aliyuncs.com': '阿里云百炼 Coding Plan（国际）',
  'dashscope.aliyuncs.com': '阿里云百炼',
  'token-plan-cn.xiaomimimo.com': '小米 MiMo Token Plan',
  'token-plan-ams.xiaomimimo.com': '小米 MiMo Token Plan（欧洲）',
  'token-plan-sgp.xiaomimimo.com': '小米 MiMo Token Plan（新加坡）',
  'api.z.ai': '智谱 Z.AI（海外站）',
  'api.minimax.cn': 'MiniMax Token Plan',
  'api.minimax.io': 'MiniMax Token Plan（国际）',
  'api.kimi.ai': 'Kimi For Coding',
  'api.kimi.com': 'Kimi For Coding（国际）',
  'zenmux.ai': 'ZenMux（含阶跃星辰 Step）',
  'api.iflow.cn': '心流 AI iFlow',
  'api.nova.amazon.com': '亚马逊 Nova',
  'api.llama.com': 'Meta Llama API',
  'api.poe.com': 'Poe',
  'api.infomaniak.com': 'Infomaniak（瑞士）',
  'inference.hetzner.com': 'Hetzner（德国）',
  'inference.poolside.ai': 'Poolside',
  'api.poolside.ai': 'Poolside',
  'api.scnet.cn': '国家超算 SCNet',
  'coding-plan-endpoint.kuaecloud.net': '硅基流动 KUAE Cloud',
  'api.jiekou.ai': '接口 AI',
  'api.unorouter.com': 'UnoRouter',
  'api.tokenrouter.com': 'TokenRouter',
  'router.requesty.ai': 'Requesty',
  'api.orcarouter.ai': 'OrcaRouter',
  'nano-gpt.com': 'NanoGPT',
  'openai.bothub.ru': 'Bothub',
  'api.llmgateway.io': 'LLM Gateway',
  'api-gateway.merge.dev': 'Merge Gateway',
  'model.inferx.net': 'InferX',
  'api.meganova.ai': 'Meganova',
  'api.pendra.ai': 'Pendra',
  'api.empiriolabs.ai': 'EmpirioLabs',
  'api.code.umans.ai': 'Umans AI',
  'opencode.ai': 'OpenCode Go',
  'api.stdcmpt.com': 'Standard Compute',
  'api.regolo.ai': 'Regolo AI',
  'llmtr.com': 'LLMTR',
  'api.zeldoc.ai': 'Zeldoc',
  'api.cortecs.ai': 'Cortecs',
  'api.nan.builders': 'NaN Builders',
  'kenari.id': 'Kenari（数据可疑）',
}
// 候选列表给仪表盘用的瘦身投影: 只回名字/来源/模型数/前几个模型名。
// 不回完整 models 数组 —— 48 家 × 每家几十个 id 会让 /api/state 胖一圈, 而列表上只显示数量。
// 已被证伪的候选(标了"数据可疑"的那些)沉底: 它们往往模型数最多(kenari.id 标了 52 个, 含 claude 付费模型),
// 若只按模型数降序, 可疑数据会霸占列表头部 —— 用户要的是"看见新大厂", 不是"先看最不可信的"。
const SUSPECT_CANDIDATES = new Set(['kenari.id'])
// 候选列表的"实测状态"排序权重: 能匿名列模型(证据最强) < 端点确认活着需 Key < 未测 < 路径不通 < 连不通
// 排序用: 证据越强越靠前。"端点存在"排在"需 Key"之后、"未收录/待确认"之前 ——
// 它证明了厂商真实存在(比"待确认"强), 但拿不到模型名(比"需 Key"弱)。
const PROBE_RANK = { listed: 0, needs_key: 1, exists: 2, skip: 3, no_list: 4, unreachable: 5 }
const probeRank = (c) => {
  if (!c.probe) return 3
  const r = PROBE_RANK[c.probe.state]
  return r === undefined ? 3 : r
}
function candidateBrief(host, v, probeMap) {
  const models = v.models || []
  // 无 Key 巡检结论(见 patrolWhitelist 的候选侧)。仪表盘据此把"实测"和"抄来的"分开显示 ——
  // 这正是用户问"候选的厂家为什么你不测试"时要看的东西。
  const pr = (probeMap && probeMap[host]) || null
  return {
    host,
    source: v.source || host,
    label: CANDIDATE_LABELS[host] || '',
    models: models.length,
    sample: models.slice(0, 5),
    suspect: SUSPECT_CANDIDATES.has(host),
    probe: pr ? {
      state: pr.state, apiBase: pr.apiBase || '',
      listedCount: pr.listedCount || 0,
      missingCount: pr.missingCount || 0,
      unverifiable: !!pr.unverifiable,
      detail: pr.detail || '', at: pr.at || '',
    } : null,
  }
}
// VENDOR_DIR 里"描述无免费/已结束"的人工结论。厂商状态是 free/promo 时若还在显示这些,
// 就是标签和数据打架(会出现"免费 · 无免费层"), 此时改用动态备注。见 computePresets 里的 liveNote。
const NEG_FREE_RE = /(无免费层|无长期免费|无永久免费|取消.{0,8}免费|活动已结束|已结束|已收费|已转收费|需绑卡|试用金|用完即停|不再免费)/i

// 白名单的 source 字段大多是可读品牌名（"Agnes AI" / "SambaNova" / "AI21 Labs"），
// 但个别条目把内部说明也糊了进去（"Cerebras Cloud(2026-07 起无永久免费档, 封闭名单)"）。
// 取括号前的部分，并拒掉含中文 / 本身就是裸域名的值 —— 后者正是用户 2026-09-19 说过的
// "新增的怎么都是英文 api, 我作为普通用户都不知道那几个是干嘛的"那一类。
const cleanSource = (s) => {
  const t = String(s || '').split(/[（(]/)[0].trim()
  if (t.length < 2 || t.length > 30) return ''
  if (/[\u4e00-\u9fa5]/.test(t)) return ''
  // ⚠ 别拿"两段式域名"当判据：LLM7.io / Glhf.chat 是品牌名，会被误伤（实测过）。
  //   真正的裸 API 域名是 ≥3 段（api.xyz.ai / open.bigmodel.cn / inference.api.nscale.com）
  //   或 api./www. 开头。
  if (/^[a-z0-9-]+(\.[a-z0-9-]+){2,}$/i.test(t)) return ''
  if (/^(api|www)[.-]/i.test(t)) return ''
  return t
}

function computePresets() {
  const wl = loadWhitelist()
  const hosts = (wl && wl.hosts) || {}
  const ps = loadPromoState()
  // 名单巡检结论(每日跑一次): 没配 Key 的厂商拿不到"免费"的证明, 但能拿到证伪 ——
  // 端点不通 / 源声明的模型在端点上不存在。这里挂出去, 仪表盘才说得清"哪句是实测、哪句是抄的"。
  const probeMap = (wl && wl.probe) || {}
  // 已接入(配了 Key、正在被 sweepPool 全池实测)的厂商 —— 这是唯一"真跑过"的一档,
  // 仪表盘要能和"只是名单上写着免费"区分开(用户 2026-09-19: "白名单搞那么多, 实际能通的呢")。
  const cfgHosts = new Set()
  // 已接入厂商的运行态摘要(host -> provider)。用途: 把"厂商公告页说免费"和"你的 Key 实测能不能用"
  // 分开显示 —— 这两句话本来就说的是不同的事, 不分开就会被读成自相矛盾。
  // 实测样本(2026-09-21 商汤): 厂商官网写着「公测期完全免费 … ¥0/月」, 而同一个 Key 的
  // /v1/models 返回空、所有模型调用 404。页面上一行说"限时免费中"、卡片上写"0/1 正常",
  // 用户只能自己猜哪个是真的 —— 其实两个都是真的, 只是一个讲宣传、一个讲你的账号。
  const cfgByHost = new Map()
  for (const p of CFG.providers || []) {
    try {
      const h = new URL(normalizeBaseUrl(p.base_url)).hostname
      if (!h) continue
      cfgHosts.add(h)
      cfgByHost.set(h, p)
    } catch {}
  }
  // ⚠ wl 可能为 null: 全新安装(或手工删掉 free_whitelist.json)时, 首次启动的同步还没落盘,
  //   这里直接读 wl.fetched_at 会让整个 /api/state 返回 500 —— 仪表盘在"刚装好、还在同步"
  //   的那 1~3 分钟里全程报错, 而用户看到的是"网关坏了"。
  //   实测(2026-09-30): 无 whitelist 文件的实例返回
  //   {"error":"管理接口异常: Cannot read properties of null (reading 'fetched_at')"}。
  const syncDate = fmtSyncDate(wl && wl.fetched_at)
  const out = []
  const seenHost = new Set()
  for (const [host, v] of Object.entries(hosts)) {
    seenHost.add(host)
    const dir = VENDOR_DIR[host] || null
    const models = v.models || []
    const promo = Object.entries(ps.items || {}).filter(([k]) => dir && k.startsWith(dir.name + ':')).map(([, x]) => x)
    const promoFree = promo.filter((x) => x.state === 'free')
    const promoPaid = promo.filter((x) => x.state === 'paid')
    // 动态状态备注: 每天跟着白名单推导, 写死的 VENDOR_DIR.note 只作接入提示, 不混入状态行
    let status
    // 限时活动的结论优先于白名单: 白名单只说"这个模型存在且标价 0", 而公告页巡检能说明
    // "限时活动已经结束"。两者冲突时以巡检为准 —— 否则活动结束后白名单还没刷新,
    // 仪表盘会继续显示"免费可用", 用户以为还免费。但**不能因为一个模型的活动结束
    // 就把整家判成收费**(该家可能还有长期免费档), 所以 free 分支只补一条提示。
    // 主显示备注: 有免费档时 = VENDOR_DIR 的人工接入说明(用户熟悉的"备注"),
// 没免费档(paid)时 = 动态状态 —— 避免显示过期的"每月 1000 次免费"误导
const dirNote = dir && dir.note ? dir.note : ''
    // ⚠ VENDOR_DIR 里有些 note 写的是人工核实的**否定结论**("无免费层""活动已结束""需绑卡")。
    //   若白名单现在明明给了免费模型、却仍把这条旧结论当主备注, 页面就会出现
    //   "免费 · 无免费层" 这种自相矛盾的显示(实测: 给 deepseek 补免费模型后就长这样)。
    //   红线「标签语义必须和数据一致」—— 命中否定词时改用动态备注, 让显示永远跟着当前数据走。
    const liveNote = dirNote && !NEG_FREE_RE.test(dirNote) ? dirNote : ''
    if (promoFree.length) {
      // basis 说明这条"免费"的**出处**: announcement = 厂商公告页说免费(宣传口径, 不代表你的 Key 能用);
      // whitelist = 上游清单标价 0。仪表盘据此把口径写清楚, 别让用户以为"免费"等于"我能用"。
      status = { state: 'promo', basis: 'announcement', models: promoFree.map((x) => x.model), note: liveNote || `限时免费 ${promoFree.length} 个`, fullNote: `限时免费中：${promoFree.map((x) => x.model).join(' / ')}` }
    } else if (models.length) {
      // 主要场景: 长期免费档. 优先用 VENDOR_DIR 的人工说明(如"每月 1000 次免费"),
      // 没收录过的厂商(VENDOR_DIR 没记)回退到动态的"N 个免费 · 名单 09-10"
      const tail = promoPaid.length ? ` · 限时活动已结束（${promoPaid.map((x) => x.model).join(' / ')}）` : ''
      const dyn = `${models.length} 个免费${tail}`
      status = { state: 'free', basis: 'whitelist', count: models.length, models: models.slice(0, 12), source: v.source || host, syncDate, note: liveNote ? liveNote + tail : dyn }
      // provisional = 只有发现源认它、没被实测过。备注里必须写明, 否则用户会以为
      // "名单里有 = 确认免费" —— 而我们要的是"每天最新"且"信息可信", 新鲜不等于已核实。
      if (v.provisional) {
        status.provisional = true
        status.note = `${status.note} · 新发现待实测`
      }
    } else if (promoPaid.length) {
      status = { state: 'paid', note: `限时活动已结束（${promoPaid.map((x) => x.model).join(' / ')} 已转收费）` }
    } else {
      // 没免费档: 不能显示"每月 1000 次免费"这种过期的人工说明, 用动态状态替代
      status = { state: 'paid', note: syncDate ? `白名单无免费 · 同步 ${syncDate}` : '白名单无免费' }
    }
    out.push({
      // 白名单里有、但接入点目录还没登记的新厂商 -> 自动出现，标记待探测接入点
      name: dir ? dir.name : host.split('.')[0].replace(/[^a-z0-9]/gi, '').toLowerCase(),
      // ⚠ 兜底用白名单的 source（品牌名），不是 host（裸域名）—— 用 host 兜底正是这些厂商
      //   被 known 过滤掉、又认不出来的原因（2026-09-25 修）。
      label: dir ? dir.label : (cleanSource(v.source) || host),
      base_url: dir ? dir.base_url : `https://${host}/v1`,
      model: dir ? dir.model : (models[0] || ''),
      needs_proxy: dir ? dir.needs_proxy : true,
      // 顶层 note = VENDOR_DIR 写死的接入提示(可不显示, 只供 hover 弹层用),
      // status.note = 每天刷新的状态备注(主显示行)
      note: dir ? dir.note : '新发现的免费厂商，接入点路径待探测',
      known: !!dir,
      // 能不能进下拉：登记过接入点，或白名单给了可读的厂商名（每天新冒出来的厂商靠这条自动进列表）
      displayable: !!dir || !!cleanSource(v.source),
      host,
      status,
      // 巡检结论: 已配置的厂商由 sweepPool 全池实测, 这里只标"零 Key 旁证"能说什么
      patrol: probeMap[host]
        ? { state: probeMap[host].state, at: probeMap[host].at, detail: probeMap[host].detail || '', trimmed: probeMap[host].missingCount || 0, listedCount: probeMap[host].listedCount || 0 }
        : null,
      configured: cfgHosts.has(host),
      // 账号级问题(Key 看不到模型 / 接入点路径不对)。与 status 是**两个独立维度**:
      // status 回答"厂商有没有免费档"(依据公告页/白名单), accountIssue 回答"你这个 Key 现在调得通吗"。
      accountIssue: (() => {
        const p = cfgByHost.get(host)
        return p && accountIssueActive(p) ? { at: p.accountIssue.at, kind: p.accountIssue.kind, note: p.accountIssue.note } : null
      })(),
    })
  }
  // 接入点目录里有、但白名单里没有的（即当前无免费模型）
  for (const [host, dir] of Object.entries(VENDOR_DIR)) {
    if (seenHost.has(host)) continue
    const promo = Object.entries(ps.items || {}).filter(([k]) => k.startsWith(dir.name + ':')).map(([, x]) => x)
    const promoFree = promo.filter((x) => x.state === 'free')
    // 这类(白名单里没有)的备注也保持"动态" —— 仅显示"白名单暂无"事实, 不说死接入说明
    out.push({
      name: dir.name, label: dir.label, base_url: dir.base_url, model: dir.model,
      needs_proxy: dir.needs_proxy, note: dir.note, known: true, displayable: true, host,
      status: promoFree.length
        ? { state: 'promo', models: promoFree.map((x) => x.model), note: dir.note || `限时免费 ${promoFree.length} 个`, fullNote: `限时免费中：${promoFree.map((x) => x.model).join(' / ')}` }
        : { state: 'paid', note: syncDate ? `白名单暂无免费 · 同步 ${syncDate}` : '白名单暂无免费' },
    })
  }
  const rank = { promo: 0, free: 1, unknown: 2, paid: 3 }
  // ⚠ provisional(发现源刚捞到、未经实测)必须排在已核实厂商**之后**：
  //   它们里有 kenari.id 这种标了 52 个"免费"(含 claude-sonnet-4-6)的可疑数据,
  //   若只按模型数降序, 可疑厂商会霸占列表头部, 把 groq/openrouter 这些真在用的挤下去 ——
  //   用户要的是"每天看到新厂商", 不是"让新厂商盖住已核实的"。
  out.sort((a, b) => (rank[a.status.state] - rank[b.status.state])
    || ((a.status.provisional ? 1 : 0) - (b.status.provisional ? 1 : 0))
    || ((b.status.count || 0) - (a.status.count || 0))
    || a.label.localeCompare(b.label))
  // 只返回**当前有免费档**的厂商(用户 2026-09-19: "没免费名单的厂家不用显示出来,
  // 等自动识别到它们有免费的, 再自动显示")。网关定位是免费聚合, 把无免费层的厂商
  // (DeepSeek/Kimi/百炼/火山/Cerebras/LongCat…)挂在下拉里只是噪音。
  // ⚠ 它们并没有被删除 —— VENDOR_DIR 和白名单里都还在, 只是不进候选列表;
  //   一旦某个源识别到它重新有免费模型, 下一轮同步后它会自己回来(这就是"自动显示")。
  //
  // ⚠ 再加一道 `known`(2026-09-19 用户反馈: "新增的怎么都是英文api, 我作为普通用户都不知道
  //   那几个是干嘛的")。白名单里冒出来、但接入点目录没登记的厂商, 只能显示裸域名
  //   (api.sambanova.ai / glhf.chat 这种), 既看不懂也没有经过我们核实 —— 用户原话:
  //   "有些小厂家真的不想加进来"。所以**没有中文名+接入说明的厂商一律不进下拉**。
  //   想让它出现, 先在 VENDOR_DIR 里补一条人工核实过的中文条目。
  // 2026-09-25 放宽：原来要求 VENDOR_DIR 登记过（p.known）才进下拉，于是白名单里新冒出来的厂商
  // **永远进不去**（用户："你实测通过的怎么没往上面加？上面的列表没变过"）—— 白名单每天在长，
  // 下拉却得靠人工补录才动，两边的名单必然越差越多。
  // 现在只要白名单给了**可读的厂商名**就放行；接入点先用兜底值，路径不对由每日巡检纠正。
  // 仍然拦住的是只有裸域名、或 source 里混了内部中文备注的条目 —— 那正是用户说过看不懂的一类。
  return out.filter((p) => (p.status.state === 'free' || p.status.state === 'promo') && p.displayable)
}

// ---------------- HTTPS-over-CONNECT 代理隧道 ----------------
class TunnelAgent extends https.Agent {
  constructor(proxyUrl) {
    super({ keepAlive: false })
    this.proxy = new URL(proxyUrl)
  }
  createConnection(options, cb) {
    const host = options.hostname || options.host
    const port = options.port || 443
    const req = http.request({
      host: this.proxy.hostname,
      port: this.proxy.port,
      method: 'CONNECT',
      path: `${host}:${port}`,
      headers: { host: `${host}:${port}` },
      agent: false,
    })
    req.on('connect', (res, socket) => {
      if (res.statusCode !== 200) return cb(new Error(`代理 CONNECT 失败: ${res.statusCode}`))
      const ts = tls.connect({ socket, servername: host, ALPNProtocols: ['http/1.1'] })
      ts.once('secureConnect', () => cb(null, ts))
      ts.once('error', (e) => cb(e))
    })
    req.on('error', (e) => cb(e))
    req.end()
  }
}

// ---------------- 向上游转发 ----------------
// TunnelAgent 按代理地址复用: 每次 new 都意味着重做 代理CONNECT+TLS 握手,
// auto 链连续试多家时白付多次握手(各 0.5~1s)。keepAlive:false 保证连接不跨请求复用,
// 但 Agent 内部的 socket 管理/代理地址解析只做一次。
const _tunnelAgents = new Map()
function getTunnelAgent(proxyUrl) {
  let a = _tunnelAgents.get(proxyUrl)
  if (!a) { a = new TunnelAgent(proxyUrl); _tunnelAgents.set(proxyUrl, a) }
  return a
}
// ── 转发鉴权头: 免 Key(anon)厂商**绝不下发 Authorization** ──
// 背景(2026-10-04 实测): OVHcloud / Kilo 的公共端点是"无鉴权"语义 —— 不带 Authorization 时
// 正常 200, 一旦收到任何 Authorization(哪怕是我们占位用的 "Bearer free"), 立刻回
// 403 "authentication failed" / 401 INVALID_TOKEN。
// 原实现对所有厂商无条件发 `Bearer (apiKey || provider.api_key)`:
//   · anon 家 keys 为空 -> 实际发的是 "Bearer undefined" -> 一律 403, 这正是 OVH 长期
//     "在 OPEN_FREE_HOSTS 里却从不进池"的真正原因(不是标记没生效, 是标记生效了但请求仍被拒)。
//   · 我们后来给 anon 家补了占位 Key "free" -> 变成 "Bearer free" -> 同样 403。
// 所以判据必须是"这家是不是无鉴权端点", 而不是"它有没有 Key"。
function isAnonProvider(p) {
  if (!p) return false
  if (p.anon) return true
  try {
    const h = new URL(normalizeBaseUrl(p.base_url)).hostname.toLowerCase()
    return OPEN_FREE_HOSTS.has(h) && (!Array.isArray(p.keys) || !p.keys.length || p.keys.every((k) => !k || k === 'free'))
  } catch { return false }
}
function authHeaderFor(p, apiKey) {
  if (isAnonProvider(p)) return {}          // 无鉴权端点: 一个头都不发
  // ⚠ 2026-10-18: 原来只读 `apiKey || p.api_key`, **漏了 p.keys[0]**。
  //   起因: 用户"gemini 你再试试" → 实测 gemini 15 个模型全 400 "User location is not supported",
  //   但同一把 Key 手动走代理请求 /models 却是 200。根因就是这里: gemini 的 config 只有 `keys: [..]`、
  //   没有 `api_key` 字段(旧配置迁移只做了 api_key -> keys, 没做反向), 于是扫描/体检发出的请求
  //   **不带 Authorization**, Google 对无鉴权请求一律回 400 + "地区不支持"(误导性极强的错误)。
  //   用户真实调用走 forward() 的 key 轮询(providerKeys 会读 keys), 所以一直正常 —— 只有扫描在瞎报。
  //   回退链与 providerKeys() 保持一致: 显式传入 > api_key 镜像 > keys[0]。
  const k = apiKey || (p && p.api_key) || (p && Array.isArray(p.keys) && p.keys[0]) || ''
  return k ? { authorization: 'Bearer ' + k } : {}
}

function forward(provider, payload, timeoutMs = 90000, apiKey, holder) {  return new Promise((resolve, reject) => {
    let u
    try { u = new URL(normalizeBaseUrl(provider.base_url).replace(/\/+$/, '') + '/chat/completions') }
    catch { return reject(new Error('base_url 格式错误')) }
    const data = Buffer.from(JSON.stringify(payload))
    const useProxy = provider.needs_proxy && CFG.proxy
    const agent = useProxy ? getTunnelAgent(CFG.proxy) : undefined
    const mod = u.protocol === 'https:' ? https : http
    // 首字节(响应头)超时: 流式请求上游会很快吐头, 若迟迟不吐说明"连得上但不回",
    // 必须快速失败换下一家, 而不是让用户干等满 90 秒。非流式要等整段生成完才发头, 不额外设限。
    // 非流式原来直接拿 timeoutMs(90s) 当首字节超时 —— 上游"连得上但不回"时要干等满 90 秒才回退,
    // 用户侧完全不可接受。收到响应头后 headTimer 就被清除了, 所以收紧它不影响正文生成时长。
    // 流式的 15 秒可由调用方按"该模型的实测 TTFB + 链上还有没有退路"收紧(见 adaptiveHeadMs),
    // 通过 holder.headMs 传进来 —— 不改签名, 因为 forward 的调用点有 5 处。
    const headMs = payload.stream
      ? (Number(holder && holder.headMs) > 0 ? Number(holder.headMs) : 15000)
      : Math.min(timeoutMs, 45000)
    // 流式空闲超时: 响应头到达后不再按总时长截断, 改看"多久没有新数据"
    const STREAM_IDLE_MS = 60000
    const t0 = Date.now()
    let gotHead = false
    const r = mod.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method: 'POST',
      agent,
      headers: {
        'content-type': 'application/json',
        'content-length': data.length,
        ...authHeaderFor(provider, apiKey),
      },
    }, (res) => {
      gotHead = true
      clearTimeout(headTimer)
      res.__ttfb = Date.now() - t0 // 供延迟学习使用
      // 流式: 响应头已到, 就不能再按"总时长"掐断了 —— 否则一条长回答会在 90s 处被硬截断。
      // 改为"空闲超时": 只要还在持续吐数据就放行, 卡住不动才判死。
      // 注意用 'readable' 而不是 'data' 来续命: 挂 'data' 会让流进入 flowing 模式,
      // 本地快速上游的响应块会在下游(转发/协议转换)挂监听前就被 emit 掉而丢失;
      // 'readable' 模式下数据留在缓冲区, 下游之后用 for-await 消费仍能完整收到。
      // ⚠ 但 'readable' 挂过之后再挂 'data' 不会恢复流动(2026-09-13 二次事故)——
      // 所以只对"确实是 SSE 的 2xx 流"挂 readable 保活; 错误响应或 200-JSON(下游要用
      // readBody 的 data 读体)绝不能挂, 否则整条链卡死在该候选上既不回退也不报错。
      const isSSEHead = (res.headers['content-type'] || '').includes('event-stream')
      if (payload.stream && res.statusCode < 300 && isSSEHead) {
        clearTimeout(timer)
        let idle = setTimeout(() => r.destroy(new Error('上游流式响应空闲超时')), STREAM_IDLE_MS)
        const bump = () => { clearTimeout(idle); idle = setTimeout(() => r.destroy(new Error('上游流式响应空闲超时')), STREAM_IDLE_MS) }
        res.on('readable', bump)
        res.on('end', () => clearTimeout(idle))
        res.on('close', () => clearTimeout(idle))
        res.on('error', () => clearTimeout(idle))
      }
      // 把底层 ClientRequest 挂到响应上, 供"客户端断开时中止上游"使用(见 hookClientAbort)。
      // 只 destroy 响应流不足以真正掐断上游连接, 必须 destroy 这个请求对象。
      res.__upReq = r
      resolve(res)
    })
    const headTimer = setTimeout(() => {
      if (!gotHead) r.destroy(new Error(`上游 ${Math.round(headMs / 1000)}s 内未返回响应头(疑似卡死)`))
    }, headMs)
    // ⚠ 把"在飞的请求对象"立刻交给调用方(holder.req), 而不是等响应头到了再挂到 res 上。
    // 原因: 最常见的取消时刻恰恰是**上游还没回响应头**的时候(用户等不耐烦点停止) ——
    // 那时 st.up 还是 null, 只 destroy 响应流等于什么都没做, 这条请求会一直挂到首字节超时
    // (非流式最长 45s), 期间免费额度照烧。见 attemptChain 里 cancel() 的注释。
    if (holder) holder.req = r
    const timer = setTimeout(() => r.destroy(new Error('上游超时')), timeoutMs)
    r.on('error', (e) => { clearTimeout(headTimer); clearTimeout(timer); reject(e) })
    r.end(data)
    // 响应读完/被销毁时收掉计时器。对冲请求会主动 destroy 落败方的响应, 若不清理,
    // 那个 90s 总超时定时器会一直挂着(每次对冲白留一个 timer)。
    r.on('close', () => { clearTimeout(headTimer); clearTimeout(timer) })
  })
}

function readBody(res, limit = 64 * 1024) {
  return new Promise((resolve) => {
    let buf = ''
    res.on('data', (c) => { if (buf.length < limit) buf += c })
    res.on('end', () => resolve(buf))
    res.on('error', () => resolve(buf))
  })
}

// ── 上游配额头采集: 回答"我今天还能用多久" ──
// 免费池最大的焦虑就是这个, 而以前只有一条路能知道: **撞 429 之后**读 `retry-after`
// (`parseRetryAfter`)。属于"撞墙才知道"。其实 Groq / OpenRouter / Cerebras / Cloudflare /
// Anthropic 这些家在**每一个响应**里都会回配额头, 只是以前全被丢掉了。
//
// ⚠ 三个刻意的取舍(每一条都是"不做会出错"的那种):
//   ① **只记录, 绝不参与路由。** 免费池的配额口径各家不同(按天 / 按分钟 / 按美元),
//      拿它当权重只会引入一个说不清的行为 —— 与"记录与决策解耦"同一条规矩。
//   ② 头名各家不同(`x-ratelimit-*` / `anthropic-ratelimit-*`), 但**语义一样**, 所以按
//      "前缀 + 关键字"解析, 不维护厂商名单(免费池每天在变, 手工名单第二天就过期)。
//   ③ 采集点必须在**状态码判断之前** —— 429/4xx 的响应头恰恰最有用(`remaining: 0` 就是
//      "用完了"), 放进成功分支会正好漏掉它。
const QUOTA_PREFIX_RE = /^(?:x-ratelimit|anthropic-ratelimit)-/i
// reset 的值是**时长**("2m59.56s" / "1s" / "6m0s"), 不是秒数 —— 不解析的话界面上会出现
// "重置 179.56 秒" 这种谁也看不懂的东西。OpenRouter 那类纯数字按秒处理。
function parseDurationSec(v) {
  const s = String(v == null ? '' : v).trim()
  if (!s) return null
  if (/^\d+(\.\d+)?$/.test(s)) return parseFloat(s)
  let total = 0, hit = false
  const re = /(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)/gi
  let m
  while ((m = re.exec(s))) {
    hit = true
    const n = parseFloat(m[1])
    const u = m[2].toLowerCase()
    total += n * (u === 'ms' ? 0.001 : u === 's' ? 1 : u === 'm' ? 60 : u === 'h' ? 3600 : 86400)
  }
  return hit ? total : null
}
// 头名 -> {remain|limit|reset} × {req|tok}; 认不出返回 null(宁可少记, 不可错记)。
function quotaField(key) {
  const s = String(key || '').toLowerCase().replace(QUOTA_PREFIX_RE, '')
  const kind = s.includes('remaining') ? 'remain' : s.includes('reset') ? 'reset' : s.includes('limit') ? 'limit' : null
  if (!kind) return null
  // 没写单位的(OpenRouter 的 `x-ratelimit-remaining`)按"次"算 —— 它约束的确实是请求数。
  return kind + (/tokens?/.test(s) ? 'tok' : 'req')
}
function recordQuota(p, headers) {
  if (!p || !headers) return
  const q = {}
  for (const k of Object.keys(headers)) {
    const f = quotaField(k)
    if (!f) continue
    const raw = headers[k]
    const val = f.startsWith('reset') ? parseDurationSec(raw) : Number.parseInt(raw, 10)
    if (val == null || !Number.isFinite(val)) continue
    q[f] = val
  }
  // 这家本轮一个配额头都没回 —— **不要写空对象**: 那会把上一次的真数据覆盖掉,
  // 界面上表现为"额度信息一会儿有一会儿没"。
  if (!Object.keys(q).length) return
  q.at = new Date().toISOString()
  p.quota = q
}

// SSRF 防护: base_url 完全由用户/前端填写, 不校验的话网关就成了"打内网/读云元数据"的跳板
// (写入点 /api/providers、/api/listmodels、/api/fetchfree 都能带任意 base_url)。
// ⚠ 必须放行环回(127.0.0.1 / localhost / [::1]) —— 本地模型(Ollama / llama.cpp)与
// 测试沙箱的假上游(127.0.0.1:8790)都跑在环回上, 一刀切会把它们全部打死。
const SSRF_META_RE = /^(169\.254\.169\.254|100\.100\.100\.200|metadata\.google\.internal|metadata\.aliyuncs\.com|metadata\.tencentcloudapi\.com)$/i
const SSRF_PRIVATE_RE = /^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|169\.254\.|0\.0\.0\.0$|fd[0-9a-f]{2}:|fe80:)/i
const LOOPBACK_RE = /^(127\.|localhost$|\[::1\]$|::1$)/i
function assertSafeBaseUrl(u) {
  const h = u.hostname
  if (SSRF_META_RE.test(h)) throw new Error(`base_url 指向云元数据地址(${h})，已拒绝（防凭据被读取）`)
  if (SSRF_PRIVATE_RE.test(h) && !LOOPBACK_RE.test(h)) throw new Error(`base_url 指向内网地址(${h})，已拒绝`)
}
// base_url 清洗: 预设模板带 <ACCOUNT_ID> 占位符, 用户替换时常残留尖括号 -> URL 非法直接连不上。
// 这里统一去掉 <>; 若占位符没替换给出明确提示而不是晦涩的连接错误。
function normalizeBaseUrl(raw) {
  let s = String(raw || '').trim()
  if (/ACCOUNT_ID/i.test(s)) throw new Error('base_url 里的 <ACCOUNT_ID> 还没替换成你的 Cloudflare 账户 ID（在 dash.cloudflare.com 首页右侧栏可查看）')
  s = s.replace(/[<>]/g, '')
  let u = null
  try { u = new URL(s) } catch { return s }   // 格式错误留给调用方报"base_url 格式错误", 这里不抢答
  assertSafeBaseUrl(u)
  return s
}

function listUpstreamModels(p, timeoutMs = 20000, apiKey) {
  return new Promise((resolve, reject) => {
    let u
    try {
      // Cloudflare Workers AI 没有 GET /ai/v1/models 端点(实测 7001 "GET not supported"),
      // 模型列表要走 REST 的 /ai/models/search —— 这里自动改写。
      let base = normalizeBaseUrl(p.base_url).replace(/\/+$/, '')
      if (/api\.cloudflare\.com/.test(base) && /\/ai\/v1$/.test(base)) base = base.replace(/\/ai\/v1$/, '/ai')
      const isCf = /api\.cloudflare\.com/.test(base)
      u = new URL(base + (isCf ? '/models/search?returnAll=true' : '/models'))
    }
    catch (e) { return reject(e && e.message && e.message.includes('ACCOUNT_ID') ? e : new Error('base_url 格式错误')) }
    const useProxy = p.needs_proxy && CFG.proxy
    const agent = useProxy ? getTunnelAgent(CFG.proxy) : undefined
    const mod = u.protocol === 'https:' ? https : http
    const r = mod.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method: 'GET',
      agent,
      headers: authHeaderFor(p, apiKey),
    }, (res) => {
      clearTimeout(timer)
      readBody(res, 4 * 1024 * 1024).then((text) => {
        if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode} ${text.slice(0, 200)}`))
        try {
          const j = JSON.parse(text)
          // Cloudflare search 返回 {success, result:[{id,name,task,...}]}; 其余为 {data|models:[...]}
          let data = j.data || j.result || j.models || [] // 兼容 Cloudflare 的 {result:[...]} 等格式
          if (/api\.cloudflare\.com/.test(u.hostname) && Array.isArray(data)) {
            data = data.filter((m) => m && typeof m.id === 'string' && m.id.startsWith('@cf/')) // 只留 @cf/ 托管文本模型, 排除需另付费 key 的第三方条目
              .map((m) => ({ id: m.id, task: m.task }))
          }
          // 返回 [{id, meta}] —— 保留原始对象, 供"价格元数据优先"的免费判定使用
          const out = data
            .map((m) => (typeof m === 'string' ? { id: m, meta: {} } : { id: m.id || m.name || m.model, meta: m }))
            .filter((x) => x.id)
          out.sort((a, b) => String(a.id).localeCompare(String(b.id)))
          resolve(out)
        } catch { reject(new Error('返回非 JSON')) }
      })
    })
    const timer = setTimeout(() => r.destroy(new Error('上游超时')), timeoutMs)
    r.on('error', (e) => { clearTimeout(timer); reject(e) })
    r.end()
  })
}

// 扫描用: 多 Key 逐个试, 第一个能返回列表的 Key 即用(避免首个 Key 失效导致整家扫描失败)
async function listUpstreamModelsWithKeys(p) {
  const keys = providerKeys(p)
  if (!keys.length) return listUpstreamModels(p)
  let lastErr
  for (const k of keys) {
    try { return await listUpstreamModels(p, 20000, k) }
    catch (e) { lastErr = e; if (!/HTTP (401|403)/.test(e.message)) throw e }
  }
  throw lastErr
}

// ---------------- 路由: 构建候选链 ----------------
function providerModels(p) {
  const ms = (p.models && p.models.length) ? p.models : [p.model]
  // 踢出可用池: ①blocked = 实测计费/下架错误(每天自动复审, 也可人工解除) ②quarantine = 目录扫描发现不再免费(自动, 恢复即放回)
  // ③disabledModels = 用户在仪表盘手动取消勾选的模型(不勾选即不参与路由, 重新勾选立即生效)
  return ms.filter((m) => !(p.blocked && p.blocked[m]) && !(p.quarantine && p.quarantine[m]) && !(p.disabledModels && p.disabledModels[m]))
}

// ---------------- 配置结构迁移 ----------------
// 目的: 给 config.json 一个版本号, 让以后的格式变更能"只跑一次"而不是每次启动都猜。
//
// ⚠ 这里**刻意只盖章、不删字段**。原计划要清掉 api_key / lastSweepAt / 空 disabledModels,
// 动手前逐个核实后发现三处都不能删:
//   · lastSweepAt 是**防扣费防线的承重字段** —— 它只在"至少一个模型真收到上游响应"时才写
//     (见 sweepPool), 仪表盘靠它算"上次真实体检"的新鲜度、超 8h 转橙。删了等于把闸门
//     谎报成"刚验过", 而且会让下轮体检无条件重跑。它与 lastSweep.at 不是冗余: 后者每轮都写。
//   · api_key 是**代码在维护的活镜像** —— 改 Key 的处理里会 `p.api_key = p.keys[0]` 写回来,
//     删了下次一改 Key 又出现。要真去掉得先改掉那些写入点, 属于另一件事, 不该混在安全批次里。
//   · 空的 disabledModels 会在用户第一次取消勾选时被重建, 删了同样只是徒增 churn。
// 所以本函数只做一件事: 打版本号 + 备份。将来真要清理字段, 在这里按版本分支追加。
function migrateConfig() {
  const fromVersion = Number(CFG.configVersion || 1)
  if (fromVersion >= 2) return
  const ts = new Date().toISOString().replace(/[:.]/g, '-')
  const backup = CONFIG_PATH + '.pre-migrate.' + ts
  try { fs.copyFileSync(CONFIG_PATH, backup) } catch (e) {
    console.warn('[config] 迁移前备份失败, 跳过迁移:', (e && e.message) || e); return
  }
  const countBefore = CFG.providers.reduce((n, p) => n + providerModels(p).length, 0)
  CFG.configVersion = 2
  const countAfter = CFG.providers.reduce((n, p) => n + providerModels(p).length, 0)
  if (countAfter < countBefore) {
    // 安全阀: 可用模型数变少说明迁移动坏了东西, 立刻回滚(内存与磁盘都要还原)
    try {
      const restored = JSON.parse(fs.readFileSync(backup, 'utf8'))
      for (const k of Object.keys(CFG)) delete CFG[k]
      Object.assign(CFG, restored)
      console.error(`[config] 迁移后可用模型数 ${countBefore}→${countAfter} 变少, 已回滚(备份 ${path.basename(backup)})`)
    } catch (e) { console.error('[config] 回滚失败, 备份保留在', path.basename(backup), (e && e.message) || e) }
    return
  }
  saveConfig()
  console.log(`[config] 结构迁移完成 v${fromVersion}→v2(仅盖章): 可用模型 ${countBefore}→${countAfter}, 备份 ${path.basename(backup)}`)
}
migrateConfig()

// 计费类错误特征: 一旦命中说明该模型已不免费 -> 拉黑(每天自动复审), 人工也可解除
const BILLING_RE = /payment required|insufficient (credits|balance|funds)|credit balance|out of credits|requires? (a )?paid|no free tier|billing required|please add (a )?payment|余额不足|欠费|扣费/i
// 下架特征: 厂商明确"不再提供"(如 gemini 2.5 对新用户关闭) -> 拉黑复审; 注意与"额度用完"区分开!
// 另外把"模型不存在/无权限"(model_not_found)也算下架: 实测 Cerebras /models 列出了 gemma-4-31b 但调用 404
// (橱窗模型, 账号无调用权限) —— 只冷却 1 小时会让 auto 链每小时撞一遍, 直接拉黑每日复审更干净
// ⚠ 措辞覆盖面要宽: 各家说"这模型没了"的话术完全不统一, 漏一个就等于该家永远只能 1 小时冷却、
//   每小时撞一遍。2026-09-21 实测漏网: 商汤回 `{"message":"model is not found","code":"5"}`,
//   不含 "does not exist"/"model_not_found", 于是被判成 notfound 而不是 retired。
//   注意**只收"模型级不存在"的措辞** —— 401/403 那类"你没有权限"属于账号级问题(见 accountIssue),
//   不能算下架, 否则会把整家模型冤枉拉黑。
const RETIRED_RE = /no longer available|has been (retired|deprecated)|model (is |was )?(retired|deprecated)|end of life|no longer supported|shut(ting)? down|model does not exist|model_not_found|does not exist or you do not have access|model[ _-]?is[ _-]?not[ _-]?found|unknown model|invalid model|no such model|not a valid model|模型不存在|模型已下线/i
// 额度用完特征: 免费池的日/小时/月限额, 会随时间自动恢复 -> 只冷却到重置, 绝不拉黑
const QUOTA_RE = /daily (limit|quota|usage)|per[ -]?day|monthly (limit|quota)|quota (exceeded|exhausted)|exceed(ed|s)? your (daily|monthly|hourly|current|free)|hourly limit|reached your (usage|limit)|resource_exhausted|rate limit exceeded.*day/i
// 模型过载特征: 上游暂时没容量(503 类), 稍后重试即可 -> 短冷却换下一家
const OVERLOAD_RE = /overload|model is busy|high demand|no (available )?capacity|temporarily unavailable|try again (later|shortly)|is at capacity/i
// 上下文超限特征: 请求体比模型窗口大(400 类) -> 同一对话短期不会变小, 该模型要冷却久一点
// `request too large` 是 Groq 的措辞(实测 openai/gpt-oss-20b/120b 每次都撞), 不加进来会被
// 归到 'other' 只冷却 90s, 下一条消息立刻再撞一遍 —— 和上下文超限其实是同一类"本轮用不了"。
const CTX_RE = /reduce the length|context length|maximum context|too many tokens|context window|input length and.*exceed|request too large/i
// ── "这个模型不给你用" ≠ "你的 Key 失效" ──
// 免费池里有一类很常见的 401/403: 模型**本身**限定在特定客户端/付费档里, 与 Key 好坏无关。
// 实测(usage_log 2026-10-23): `thinkingmachines/inkling:free is only available on agentic harnesses`。
// 误判成 auth 的代价很大 —— auth 会冷却**整个 Key 10 分钟**, 同家其它本来能用的模型一起被连累
// (一家里 17 个模型, 一个模型的门槛把 16 个正常模型踢出池子 10 分钟)。这类应该只算"这个模型不可用",
// 走 retired 通道(拉黑该模型 + 每天复审), 不碰 Key。
// ⚠ 正则刻意写得**窄**: 只认"明确说了模型/场景限定"的措辞。宁可漏判(退回 auth)也不要错判 ——
//   把真正的 Key 失效当模型问题, 会让一把坏 Key 一直留在轮换里。
const MODEL_SCOPE_RE = /only available (on|for|via|to|in)\b|not available (for|on|in) (your|this|the)|isn'?t available (on|for)|requires? (a |an )?(paid|pro|enterprise|business|subscription|upgraded?) ?(plan|tier|account|subscription)?|not (enabled|included|supported) (for|in|on) (your|this)|restricted to (specific|particular|selected)|unsupported (client|harness|platform|surface)/i

// 上游错误分类器: 同一种 HTTP 状态可能对应完全不同的病因, 必须看正文
// billing/retired -> 拉黑+复审 | quota -> 冷却到重置 | overloaded -> 短冷却 | 其余按状态码
function classifyUpstreamError(status, text) {
  const t = text || ''
  if (status === 402 || BILLING_RE.test(t)) return 'billing'
  if (RETIRED_RE.test(t)) return 'retired'
  if (QUOTA_RE.test(t)) return 'quota'
  if (OVERLOAD_RE.test(t) && status >= 500) return 'overloaded'
  if (status === 429) return QUOTA_RE.test(t) ? 'quota' : 'ratelimit'
  // ⚠ 413/422 必须一起认: 同样是"这次请求太大", 各家状态码不统一 —— Groq 对超大请求回的是
  //   **413** + `Request too large`(实测 2026-10-05), 只写 400 会让它掉进 'other'(仅冷却 90s),
  //   下一条大请求立刻再撞一遍。归类到 ctxtoolong 才拿到该有的长冷却 + 容量记忆(见 markFail)。
  if ((status === 400 || status === 413 || status === 422) && CTX_RE.test(t)) return 'ctxtoolong'
  // ⚠ 顺序有意义: "模型限定"必须排在 auth 之前判 —— 这类响应的状态码正是 401/403,
  //   先判 auth 就永远轮不到它(见 MODEL_SCOPE_RE 的说明)。
  if ((status === 401 || status === 403) && MODEL_SCOPE_RE.test(t)) return 'retired'
  if (status === 0) return 'network'
  if (status === 401 || status === 403) return 'auth'
  if (status === 404) return 'notfound'
  if (status >= 500 && OVERLOAD_RE.test(t)) return 'overloaded'
  if (status >= 500) return 'server'
  return 'other'
}

// 额度"每天零点重置"用的是**厂商自己的时区**, 不是我们猜的那个。
// 旧实现一律按 UTC+8(国内厂商口径)算 —— 对 openrouter 就是错 8 小时: 它的 free-models-per-day
// 按 **UTC 零点** 重置, 于是额度早就回来了, 我们还在冷却(实测 usage_log 里 40 条
// `free-models-per-day` 全来自它, 最多白等 8 小时)。
// ⚠ 只登记**确知**的厂商; 认不出时按 UTC+8 —— 宁可晚一点恢复, 也不要早回来再撞一次
//   (早回来 = 一条必然失败的请求 + 重新冷却到下一个零点, 比多等更糟)。
// ⚠ 判据同时看 host 与 id/name: 生产里 name 就是厂商名, 而测试只能把 base_url 指向本地假上游,
//   两条都要, 否则这段逻辑永远测不到(本项目"测不到的分支等于没写"的老坑)。
const QUOTA_RESET_TZ = [
  { re: /openrouter/i, hours: 0 },
]
function quotaResetOffsetHours(p) {
  if (!p) return 8
  let host = ''
  try { host = new URL(normalizeBaseUrl(p.base_url || '')).hostname } catch {}
  const key = `${host} ${p.id || ''} ${p.name || ''}`
  for (const x of QUOTA_RESET_TZ) if (x.re.test(key)) return x.hours
  return 8
}
// 额度类冷却时长: 按"何时自动重置"计算, 到点自然恢复, 无需人工
function quotaCooldownMs(text, retryAfterSec, p) {
  if (retryAfterSec > 0) return Math.min(retryAfterSec * 1000, 26 * 3600000)
  const now = Date.now()
  const off = quotaResetOffsetHours(p) * 3600000
  const local = new Date(now + off) // 按该厂商口径算"当地明天零点"
  if (/monthly|每月|包月/i.test(text)) return 24 * 3600000 // 月额度太长, 先冷却一天, 复审机制兜底
  if (/daily|per[ -]?day|每天|今日|day/i.test(text)) {
    const nextMidnight = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + 1) - off
    return Math.min(nextMidnight + 120000 - now, 25 * 3600000) // +2 分钟缓冲
  }
  if (/hourly|per[ -]?hour|每小时|小时/i.test(text)) {
    const nextHour = (Math.floor(local.getTime() / 3600000) + 1) * 3600000 - off
    return Math.min(nextHour + 60000 - now, 2 * 3600000)
  }
  return 3600000 // 无法判断周期 -> 默认 1 小时
}
function isBlocked(p, modelId) { return !!(p.blocked && p.blocked[modelId]) }

// ── 账号级无模型权限 / 接入点路径不对（2026-09-21 加）──
// 起因: 用户问"没找到不就是已下架吗？区别是什么？" —— 区别在**处置完全相反**:
//   ① 模型级下架      -> 该模型从此不该再被选中 -> 拉黑 + 每日复审
//   ② 接入点路径写错  -> 整家 404, 模型其实好好的 -> 别动模型, 修 base_url
//   ③ Key 无模型权限  -> 整家 404/401, 账号问题 -> 别动模型, 提示换 Key
// ②③ 的判别信号不是"某个模型 404", 而是"**整家一起挂**":
//   · /v1/models 返回空列表(HTTP 200 但 data:[])   -> 这个 Key 看不到任何模型
//   · 全池模型同一轮全部 404/401                   -> 同上
// 实测样本(商汤 2026-09-21): /v1/models 回 `{"data":[]}`, 8 个模型 id 全回
//   `{"message":"model is not found","code":"5"}` —— 若按"404=已下架"处理会把 8 个模型
//   全部拉黑, 而真凶是 Key 没有模型权限。所以必须有这层区分。
// 一旦判定成立, markFail 对 retired 类错误**降级为冷却而不拉黑**。
// 标记在任一次真实成功(markOk)或 /v1/models 重新返回非空时立刻清除 —— 它只是临时认知, 不是判决。
const ACCOUNT_ISSUE_TTL = 12 * 3600000
function accountIssueActive(p) {
  const a = p && p.accountIssue
  if (!a || !a.at) return false
  return Date.now() - new Date(a.at).getTime() < ACCOUNT_ISSUE_TTL
}
function setAccountIssue(p, kind, note) {
  if (!p) return
  p.accountIssue = { at: new Date().toISOString(), kind, note: String(note || '').slice(0, 200) }
}
function clearAccountIssue(p) { if (p && p.accountIssue) delete p.accountIssue }

// Key 掩码: 只保留首 6 位与末 4 位, 用于管理接口回显, 避免明文外泄
function maskKey(k) { return k ? String(k).slice(0, 6) + '…' + String(k).slice(-4) : '' }

// 粘性会话: 同一对话(以首条 user 消息哈希识别)尽量固定在同一家, 保持风格连贯
const stickyMap = new Map() // hash -> { id, at }
const STICKY_TTL = 30 * 60 * 1000
// 粘性提升的门槛: 粘性候选的综合分必须 ≥ 队首的 96%, 否则不提升(见 pickChain 末尾)。
// 粘性的收益只是"命中上游 prompt 前缀缓存", 不该拿模型质量去换。
const STICKY_MIN_RATIO = 0.96
function stickyHash(payload) {
  try {
    const first = (payload.messages || []).find((m) => m.role === 'user')
    // 阈值 24 -> 4: "1+1=几"这类短消息也要能粘住上次成功的供应商, 否则每条都重走全链
    if (!first || typeof first.content !== 'string' || first.content.length < 4) return null
    return crypto.createHash('sha1').update(first.content.slice(0, 200)).digest('hex').slice(0, 16)
  } catch { return null }
}
function stickyGet(hash) {
  const v = stickyMap.get(hash)
  if (!v) return null
  if (Date.now() - v.at > STICKY_TTL) { stickyMap.delete(hash); return null }
  return v.id
}
function stickySet(hash, id) {
  stickyMap.set(hash, { id, at: Date.now() })
  if (stickyMap.size > 500) { // 简单防膨胀
    const cutoff = Date.now() - STICKY_TTL
    for (const [k, x] of stickyMap) if (x.at < cutoff) stickyMap.delete(k)
  }
}

// 把请求里写的模型名解析成池里真实存的那个 ID, 池里没有则返回 null。
// 必须解析(而不是拿请求名直接发上游): Gemini 官方列表接口返回的 ID 带 "models/" 前缀,
// 而官方文档和用户的习惯写法都省略它。只做精确匹配会有两个后果 ——
//   ① 填 "gemini-3-flash-preview" 找不到 "models/gemini-3-flash-preview", 报成"没有可用供应商"(误导);
//   ② 侥幸匹配上 provider 分支时把裸名发给 Google, 上游不认, 返回 200 但内容为空。
function resolveModelId(p, m) {
  const pool = providerModels(p)
  if (pool.includes(m)) return m
  if (pool.includes('models/' + m)) return 'models/' + m
  if (m.startsWith('models/') && pool.includes(m.slice(7))) return m.slice(7)
  return null
}
// ── 模型别名: 让客户端里那些"熟名字"直接落到免费池 ──
// 为什么需要: 客户端(WorkBuddy / Cursor / LobeChat / Cherry Studio)的模型下拉里全是
// gpt-4o / claude-3-5-sonnet 这类**付费**名字, 免费池里一个都没有。用户要么每次手打
// "groq/openai/gpt-oss-120b", 要么就得改客户端配置。别名把这一步前移到网关:
// config.json 里写 { "gpt-4o": "auto" }, 客户端照旧填 gpt-4o 就行。
// 约束(每一条都是为了让"配错了"表现为报错, 而不是静默跑偏):
//   · 只解析**一层** —— 别名指向别名一律不再展开, 否则 a→b→a 会转不出来;
//   · 目标必须是 auto / "厂商/模型" / 裸模型名, 不做任何猜测或模糊匹配;
//   · 别名不得与已有供应商同名 —— 否则 "名字/模型" 这种写法会产生歧义。
function resolveAlias(model) {
  const a = CFG.aliases
  if (!a || typeof model !== 'string' || !model) return model
  const t = a[model]
  return (typeof t === 'string' && t.trim()) ? t.trim() : model
}
// 校验一条别名能不能写入。返回 '' 表示通过, 否则返回人话原因(直接回给 API 调用方)。
function aliasProblem(name, target) {
  if (!name || !/^[\w.:-]{1,64}$/.test(name)) return '别名只能含字母/数字/._:- 且不超过 64 字符'
  if (name === 'auto') return 'auto 是内置模型名, 不能被别名占用'
  if (typeof target !== 'string' || !target.trim()) return '目标不能为空'
  if (target.trim() === name) return '目标不能是它自己'
  // 别名先于路由组解析(见 pickChain), 所以同名别名会把组**静默遮住** —— 必须在这里挡住,
  // 否则用户建了组却在请求里永远用不到它, 而两边看起来都"配置成功"。
  if (CFG.groups && CFG.groups[name]) return `${name} 已经是一个路由组了; 别名与路由组不能同名(别名先解析, 会把组静默遮住)`
  if (CFG.providers.some((p) => p.name === name)) return `别名与已接入的供应商同名(${name}), 会让 "名字/模型" 这种写法产生歧义`
  return ''
}

// ── 路由组: 一个名字 = 一组候选模型 ──
// 与别名的分工(两者不重叠, 别搞混):
//   · 别名解决"客户端只认付费名字"(gpt-4o -> auto), 目标是**一个**;
//   · 路由组解决"这次只想在这几个模型里选"(local-only / vision / 省钱组), 目标是**一组**。
// 关键取舍: 组**不改变排序规则**, 只把候选集合从"全池"收窄成"这几个"。组内候选照样走
// 同一套加权评分与 attemptChain 的故障转移 —— 想"让某个成员永远排第一"应该去改它的证据
// (实测数据), 而不是靠组里的书写顺序, 否则就退化成又一套"单点判据定生死"。
// 声明顺序只在**同分**时做 tiebreak(见 pickChain 里的 sort), 绝不越过分数。
// 约束(每一条都是为了让"配错了"表现为报错, 而不是静默跑偏):
//   · 成员只能是 "厂商/模型" / "厂商/*" / 裸模型名, **不解析别名、不嵌套组** ——
//     一旦允许, 组→别名→组 就能绕成环, 而这条解析路径上没有递归保护;
//   · 成员不接受 auto: 含 auto 的组等价于 auto 本身, 收窄候选的意图会被它自己取消掉;
//   · 组名不得与别名/供应商同名, 否则"这个名字指什么"取决于先查哪张表。
function resolveGroup(name) {
  const g = CFG.groups
  if (!g || typeof name !== 'string' || !name) return null
  const v = g[name]
  return Array.isArray(v) && v.length ? v : null
}
// 校验一个组能不能写入。返回 '' 表示通过, 否则返回人话原因。
function groupProblem(name, members) {
  if (!name || !/^[\w.:-]{1,64}$/.test(name)) return '组名只能含字母/数字/._:- 且不超过 64 字符'
  if (name === 'auto') return 'auto 是内置模型名, 不能被路由组占用'
  if (!Array.isArray(members) || !members.length) return '组内至少要有一个成员'
  if (members.length > 32) return '一个组最多 32 个成员'
  if (CFG.aliases[name]) return `${name} 已经是一个别名了; 别名与路由组不能同名(否则"这个名字指什么"取决于先查哪张表)`
  if (CFG.providers.some((p) => p.name === name)) return `组名与已接入的供应商同名(${name}), 会让 "名字/模型" 这种写法产生歧义`
  for (const raw of members) {
    const m = typeof raw === 'string' ? raw.trim() : ''
    if (!m) return '成员不能是空字符串'
    if (m === 'auto') return '成员不能是 auto —— 含 auto 的组等价于 auto 本身, 收窄候选的意图会被它自己取消'
    if (m === name) return '成员不能是组名自己'
    if (CFG.groups[m]) return `成员 ${m} 本身是一个路由组; 组不能嵌套(只解析一层)`
    if (CFG.aliases[m]) return `成员 ${m} 是一个别名; 组内请直接写它指向的目标模型(避免 组→别名→组 绕成环)`
  }
  return ''
}
// 导入配置的最低校验: 只保证"能用", 不做逐字段 schema 校验 —— 导入的目的是恢复, 不是替用户
// 把关每一个字段。但必须挡住"providers 不是数组"这类会让网关直接起不来的输入。
// 校验不通过时调用方**什么都不改**, 宁可让用户重来一次, 也不要写进去半份坏配置。
function configProblem(c) {
  if (!c || typeof c !== 'object' || Array.isArray(c)) return '配置必须是一个 JSON 对象'
  if (!Array.isArray(c.providers)) return '缺少 providers 数组'
  for (const p of c.providers) {
    if (!p || typeof p !== 'object') return 'providers 里有非对象的条目'
    if (!p.name || typeof p.name !== 'string') return 'providers 里每一项都必须有 name'
    if (!p.base_url || typeof p.base_url !== 'string') return `供应商 ${p.name} 缺少 base_url`
  }
  if (c.aliases != null && (typeof c.aliases !== 'object' || Array.isArray(c.aliases))) return 'aliases 必须是对象'
  if (c.groups != null) {
    if (typeof c.groups !== 'object' || Array.isArray(c.groups)) return 'groups 必须是对象'
    for (const [k, v] of Object.entries(c.groups)) {
      if (!Array.isArray(v)) return `路由组 ${k} 必须是数组`
    }
  }
  return ''
}

// 权重表: 带工具/多轮/长上下文的任务以"能力"为主; 闲聊短问以"快"为主。
// ⚠ 提到模块级是为了让 /api/route 与真实排序**共用同一张表** —— 各写一份的话，
//   改权重时那个接口不会跟着改，"展示出来的分解"与"真实排序依据"会悄悄对不上。
const W_AGENT = { tier: 0.40, quality: 0.20, avail: 0.15, speed: 0.15, load: 0.10 }
const W_CHAT = { tier: 0.15, quality: 0.20, avail: 0.15, speed: 0.40, load: 0.10 }
const weightsFor = (reqTier) => (reqTier >= 2 ? W_AGENT : W_CHAT)

// 把一个"显式写法的目标"展开成候选列表。三种写法: "厂商/模型" · "厂商/*" · 裸模型名。
// ⚠ 抽成函数是刻意的: 显式分支与路由组成员**必须用同一份实现**。各写一份的下场是
//   "组里能用的写法在显式分支里不能用"(或反过来), 而这类不一致最难向用户解释。
function expandExplicit(target, active) {
  const t = typeof target === 'string' ? target.trim() : ''
  if (!t) return []
  if (t.includes('/')) {
    const [pname, ...rest] = t.split('/')
    const m = rest.join('/')
    if (m === '*' || m === '') {
      return active.filter((p) => p.name === pname).flatMap((p) => providerModels(p).map((mm) => ({ ref: p, model: mm })))
    }
    // 显式写了厂商名时, 解析不到也要照原名发给上游 —— 这是用户尝鲜"池里还没有的新模型"的唯一入口,
    // 而且上游的 400/404 比我们一句"不在池里"有用得多(顺带保住 stream 400 fast-fail 那条回归测试)。
    const hit = active.filter((p) => p.name === pname && !isBlocked(p, m)).map((p) => ({ ref: p, model: resolveModelId(p, m) || m }))
    if (hit.length) return hit
    return active.flatMap((p) => { const id = resolveModelId(p, t); return (id && !isBlocked(p, id)) ? [{ ref: p, model: id }] : [] })
  }
  return active.flatMap((p) => { const id = resolveModelId(p, t); return (id && !isBlocked(p, id)) ? [{ ref: p, model: id }] : [] })
}

function pickChain(model, payload) {
  // 别名先解析, 之后所有分支都按解析后的目标走 —— 只有这一处解析, 不会出现
  // "有的地方认别名、有的地方不认"这种半生效状态(那是最难查的一类问题)。
  model = resolveAlias(model)
  // 别名解析完之后才判路由组 —— 于是 "gpt-4o -> 我的一组免费模型" 这种写法天然可用
  // (别名指向组: 各解析一层, 不会绕圈)。
  const group = resolveGroup(model)
  // ⚠ 账号级无模型权限的厂商要**整家**退出候选链(2026-09-21): 这类故障是"Key 看不到任何模型",
  //   逐个模型的 1 小时冷却盖不住 —— 冷却到期后 auto 会重新选它, 撞 404 再冷却, 一天来回好几轮,
  //   既拖慢链又刷一堆假"失败"统计。既然已知整家都调不通, 就别浪费往返。
  //   自愈路径: accountIssue 有 12 小时 TTL, 且每 6 小时的目录扫描一旦看到 /v1/models 有内容
  //   就会立刻清除它 —— 所以"修好 Key"之后最多 6 小时自动回到链上, 不需要人工干预。
  // 本次请求是否带图片 —— 决定"名字无视觉信号的模型"要不要降档(见下方 rankOf 的 visionMismatch)。
  // 放在这里而不是 auto 分支内: rankOf 在函数末尾要用它, 而分支内的 const 作用域出不来。
  const wantsVision = payloadWantsVision(payload)
  // 本次请求的规模 —— 容量记忆要用(实测撞过"请求太大"的模型, 规模相当的请求直接跳过, 见 modelCtxTooBig)
  const reqChars = payloadChars(payload)
  const active = CFG.providers.filter((p) => p.enabled !== false && !accountIssueActive(p))
  const now = Date.now()
  let chain
  if (!model || model === 'auto') {
    // auto: 每家把勾选的免费模型全部展开进链
    // 请求带 tools 时先剔除不支持 function calling 的模型: 它们必然失败, 放进去只是白搭一次往返
    // (名单来自实测学习, 见 modelSupportsTools)
    const wantsTools = payloadWantsTools(payload)
    chain = []
    for (const p of active) for (const m of providerModels(p)) {
      if (wantsTools && !modelSupportsTools(p, m)) continue
      // 带图请求: 实测确知不支持图片的模型直接跳过(与 tools 同一道闸门, 见 modelVisionBlocked)。
      // 名字无视觉信号的模型**不在这里跳** —— 那只降档(见 rankOf), 池子小时仍要能拿到答案。
      if (wantsVision && modelVisionBlocked(p, m)) continue
      // 容量闸门: 实测这个模型吃不下"这么大的请求"(撞过 413/request too large)。
      // ⚠ 2026-10-23 由**硬跳过**改成**标记后降档**(见下方 ctxTight): 硬跳过的后果是
      //   "池里每个模型都嫌大" -> 链直接空 -> 报"模型不在可用池里", 而那既不是事实
      //   (模型在池里)、也没告诉用户病因(太大)。降档同样省掉那次必然失败的往返
      //   (它排到最后, 前面的候选成功就不试它), 但池子小时仍能拿到答案。
      if (modelCtxTooBig(p, m, reqChars)) chain.push({ ref: p, model: m, ctxTight: true })
      else chain.push({ ref: p, model: m })
    }
    // 粘性会话: 上次同对话用过的"供应商|模型"。
    // ⚠ 这里只**记录**, 提升动作放到综合排序之后做(见本函数末尾) ——
    // 原实现是在这里先排一次, 而下面还有一次全量排序, 等于白排: 粘性从来没真正生效过。
    // 为什么粘到模型而不只是供应商: ①同一对话换模型会让上游的 prompt 前缀缓存失效, 首字明显变慢;
    // ②也让"这个对话一直用 gemini-3.x-flash"保持连贯, 不因某一轮链序波动就换模型。
    const hash = stickyHash(payload)
    const stickyId = hash && stickyGet(hash)   // 新格式 "providerId|model", 兼容旧的 "providerId"
    chain._stickyId = stickyId
    chain._stickyHash = hash
  } else if (group) {
    // 路由组: 成员逐个按"显式写法"展开, 去重后组成候选链。
    // 组**只收窄候选集合, 不改变排序规则** —— 展开完就交给下面那套统一的加权评分,
    // 故障转移也由 attemptChain 现成的回退完成, 这里不新写任何调度逻辑。
    chain = []
    const seen = new Set()
    for (let gi = 0; gi < group.length; gi++) {
      for (const x of expandExplicit(group[gi], active)) {
        const key = x.ref.id + '|' + x.model
        if (seen.has(key)) continue   // 组里同时写了 "groq/*" 和 "groq/llama-x" 时只留一份
        seen.add(key)
        // grpIdx 只用于**同分**时的 tiebreak(见下面的 sort), 不参与分数 ——
        // 想让某个成员永远领跑得去改它的实测证据, 不能靠书写顺序。
        x.grpIdx = gi
        chain.push(x)
      }
    }
    chain._group = model
    // 组内也认粘性会话: 同一对话在同一个组里尽量不换模型(理由同 auto 分支, 见那处注释)。
    // 粘到的模型不在本组时 findIndex 返回 -1, 自然不提升 —— 不需要额外判断。
    const hash = stickyHash(payload)
    chain._stickyId = hash && stickyGet(hash)
    chain._stickyHash = hash
  } else {
    // 显式写法("厂商/模型" · "厂商/*" · 裸模型名)与 auto 之外的一切都走同一份展开实现。
    chain = expandExplicit(model, active)
  }
  // 为每个候选分配可用 Key(多 Key 轮换); 全 Key 冷却的候选标记 keyIdx=-1
  // ⚠ 免 Key(anon)厂商 keyIdx 恒为 -1 —— 但那是"不需要 Key", 不是"没有可用 Key",
  //   所以下面 bad() 的 keyIdx<0 硬门槛必须对它放行, 否则 OVH/Kilo 永远排在第 2 档(等于不进池)。
  for (const x of chain) {
    x.anon = isAnonProvider(x.ref); x.keyIdx = x.anon ? 0 : pickKeyIdx(x.ref, now)
    // 上下文容量闸门**统一在这里补** —— 三个分支(auto / 路由组 / 显式)都要认这条实测结论。
    // 以前只有 auto 分支查 modelCtxTooBig, 于是"用户显式点名 groq/xxx"时学到的 ctxLimit 白学:
    // 每次照样发过去撞 413, 白等一个完整往返, 然后又把同一条结论重写一遍。
    // auto 分支已经标过(它要区分"标记"与"不标记"), 这里只补漏。
    if (x.ctxTight === undefined) x.ctxTight = modelCtxTooBig(x.ref, x.model, reqChars)
  }
  // ── 排序: 加权综合分, 不是"逐键淘汰" ──
  // 这套路由已经因为"单个指标定生死"踩了三次坑:
  //   ① 只看延迟        -> 永远选中最快但最弱的小模型(ministral-3b 排在 gemini-3.x-flash 前面);
  //   ② 只看累计失败率  -> gemini/openrouter 的失败几乎全是"额度用完/限流", 却被永久沉底;
  //   ③ 体检的一次 ping -> 瞬时 5xx 也进质量统计(现已改为只有真实请求才计入)。
  // 教训是: 任何单点判据都会被它自己的噪声放大。所以改成各项加权求和,
  // 并且**每一项都按样本量打折**(样本少 -> 该项回落到中性值 0.5, 不左右排名)。
  // 这也是"一次测试的结果不能定排名"的工程表达: 一个样本只能移动该项 1/N 的距离。
  // 限流计数预计算一次 —— 原来 loadScore 对**每个候选**都调 recentReqs(p.id)，而它会遍历
  // 整份 usage(最多 2000 条)，候选多时是 O(候选 × 2000) 的无谓开销（同一家还会被重复算）。
  // 同一家只算一次，并且顺手把"读全局 usage"收敛成一个显式输入 —— 评分逻辑因此更接近纯函数。
  const reqsById = {}
  for (const p of active) reqsById[p.id] = recentReqs(p.id)

  const tierOf = (x) => x.tier / 3
  // 速度 = 首字延迟 + 预计输出耗时。TTFB 只说明"多久开始吐字", 吞吐才说明"吐得多快";
  // agent 的真实耗时是「多轮 × (首字 + 输出/吞吐)」, 所以两个都要算进去。
  const EST_OUT_TOK = 400          // 一轮典型输出量
  const DEFAULT_TPS = 40           // 吞吐未知时的中性估计
  // 模型级优先, 没有就退回供应商级 —— 同家的模型速度差异经常比跨家还大
  const ttfbOf = (x) => (x.ref.modelLat && x.ref.modelLat[x.model]) || x.ref.latency || 8000
  const tpsOf = (x) => (x.ref.modelTokps && x.ref.modelTokps[x.model]) || x.ref.tokps || DEFAULT_TPS
  const estMs = (x) => ttfbOf(x) + (EST_OUT_TOK / tpsOf(x)) * 1000
  // ── 动态评分基准: 任务越长, 单轮能容忍的时间越短(√ 衰减, 连续不跳档) ──
  //   turns=1(闲聊)     -> 30.0s 才算"满分慢"
  //   turns=2(带工具)   -> 21.2s
  //   turns=4(agent 中) -> 15.0s
  //   turns=8(agent 后) -> 10.6s  <- 10 秒就算满分慢, speed 项自然把慢模型压下去
  // turns=1 时 30000/√1 = 30000, 与原实现**完全等价** —— 闲聊场景行为不变, 改动只作用于多轮任务。
  const turns = estTurns(payload)
  const speedBudgetMs = 30000 / Math.sqrt(turns)
  const speedScore = (x) => 1 - Math.min(1, estMs(x) / speedBudgetMs)
  // 速度采样数(用来给"速度"这一项打折)。
  // ⚠ 模型级样本优先; 回退到**供应商级时必须大幅压低置信度** —— 供应商均值不代表这个具体模型
  // (同一家 120b 和 20b 的首字差很多), 给它满分置信度会让"从没测过的模型"显得比"测过的模型"更快。
  // 实测(2026-09-18): 闲聊请求因此选了从没测过的 groq/compound, 而实测首字 1945ms 的 gpt-oss-120b
  // 被压到第二 —— 明明后者是更强的模型。没测过就老老实实待在中性值附近, 别假装它快。
  const speedSamples = (x) => {
    const mn = x.ref.modelLatN && x.ref.modelLatN[x.model]
    if (mn) return mn
    return Math.min(1, x.ref.latN || 0) * 0.4   // 弱证据: 最多给 0.4, 不足以左右排名
  }
  // 质量只看"模型/这家本身不行"(硬失败); 可用性把软失败也算上, 反映"现在打过去成不成"。
  // ⚠ 模型级优先, 供应商级只是弱证据 —— 见 pushQuality 上的说明。
  const winStats = (p, model) => {
    const mw = model && p.modelQ && p.modelQ[model]
    const hasModel = Array.isArray(mw) && mw.length > 0
    const src = hasModel ? mw : (p.qWindow || [])
    let hard = 0, any = 0
    for (const v of src) { if (v === 0) hard++; if (v !== 2) any++ }
    return { n: src.length, hard, any, model: hasModel }
  }
  // 供应商级证据最多只让它把该项移动 40%(与速度项的 speedSamples 同一口径):
  // "这家大概靠不靠得住"不能代表"这个具体模型行不行"。
  const Q_CONF = (s) => (s.model ? 1 : 0.4)
  const qualityScore = (s) => (s.n ? 1 - s.hard / s.n : 0.5)
  const availScore = (s) => (s.n ? 1 - s.any / s.n : 0.5)
  // ── 上游自报的额度余量（见 recordQuota）──
  // 这是**唯一由厂商亲口告诉我们**的余量信号: 比任何静态限额表都准, 而且厂商改限额它会自动跟着变。
  // 以前它只喂仪表盘("今天还剩多少"), 排序时完全不用 —— 于是"剩 3 次"和"剩 900 次"的家同分,
  // 路由可能把这一轮送去一家马上就要用尽的家, 撞 429 再回头。采了不用等于没采。
  // ⚠ 只做**排序微调**, 不做准入判断: 各家口径完全不同(按分钟 / 按天 / 按美元, 有的还是 token 维度),
  //   拿它决定"能不能用"必然误伤。真的用完了由 429 -> quota 冷却(quotaCooldownMs)处理。
  // ⚠ 只在**濒临耗尽**时降权(剩 <=20% 才开始衰减, 保底 0.2): 按分钟限流的家 remain/limit 长期停在
  //   900/1000, 线性映射对它们几乎无感(无害); 反过来, 若拿它当主信号, 一次读到 "3/1000" 就会把一家
  //   按天限流的家直接踢出候选 —— 而它可能刚好重置。
  // ⚠ 超 10 分钟的数据不认: 仪表盘可以展示 24 小时内的(那是"参照"), 路由要的是"此刻"。
  const QUOTA_FRESH_MS = 10 * 60 * 1000
  const quotaRatioScore = (remain, limit) => {
    // 没有上限字段 = 不知道分母, 不猜比例(猜就是编数据): 只有真的剩 0 才表态。
    if (limit == null || !(limit > 0)) return (remain != null && remain <= 0) ? 0.2 : 1
    const r = Math.max(0, Math.min(1, remain / limit))
    return r > 0.2 ? 1 : 0.2 + (r / 0.2) * 0.8
  }
  const quotaScore = (p) => {
    const q = p.quota
    if (!q || !q.at) return 1
    const age = now - Date.parse(q.at)
    if (!(age >= 0 && age < QUOTA_FRESH_MS)) return 1
    const byReq = q.remainreq != null ? quotaRatioScore(q.remainreq, q.limitreq) : 1
    const byTok = q.remaintok != null ? quotaRatioScore(q.remaintok, q.limittok) : 1
    return Math.min(byReq, byTok)
  }
  // 同一家会被多个模型候选重复引用 —— 与 reqsById 同一理由, 每家只算一次。
  const quotaById = {}
  for (const p of active) quotaById[p.id] = quotaScore(p)
  // 负载余量 = RPM 余量 × 上游自报的额度余量。两个都管"还能吃多少", 取乘而不是取小:
  // 一个管"这一分钟挤不挤", 一个管"今天还剩多少", 两样都紧才是真的紧。
  // rpmCap 未知时给**满分(1.0)而不是中性值** —— rpmCap 只在撞到 429 时才被学到,
  // "没有这个值"恰恰说明"我们从没被它限流过", 那是好事, 不该倒扣分。
  // (给 0.5 会让 gemini 这种"额度大到从没触发限流"的家平白吃亏, 实测就是这样被压下去的。)
  const loadScore = (p) => {
    const rpm = p.rpmCap ? 1 - Math.min(1, (reqsById[p.id] || 0) / p.rpmCap) : 1
    const q = quotaById[p.id]
    return rpm * (q == null ? 1 : q)
  }
  const blend = (v, n, k) => 0.5 + (v - 0.5) * Math.min(1, n / k)   // 样本量置信度
  // 带置信度上限的版本: 证据来源越弱, 越不能左右排名(见 Q_CONF)。
  const blendConf = (v, n, k, conf) => 0.5 + (v - 0.5) * Math.min(1, n / k) * conf
  // 权重随请求类型切换（表在模块级，与 /api/route 共用同一份）
  const reqTier = requestTier(payload)
  // 这道题是"什么题"(代码 / 数学 / 通用) —— 与 reqTier("要几档")并列的另一个维度, 见 detectTask
  const task = detectTask(payload)
  const W = weightsFor(reqTier)
  const scoreOf = (x) => {
    const p = x.ref
    const s = winStats(p, x.model)
    const qc = Q_CONF(s)
    const parts = {
      tier: tierOf(x),
      quality: blendConf(qualityScore(s), s.n, 10, qc),
      avail: blendConf(availScore(s), s.n, 10, qc),
      speed: blend(speedScore(x), speedSamples(x), 3),
      load: loadScore(p),
    }
    x.parts = parts
    // 加权后的分项一并留档 —— /api/route 直接读它，**不再自己重算一遍权重**。
    // 重算的坏处：权重表改了那个接口不会跟着改，于是"展示出来的分解"与"真实排序依据"
    // 会悄悄对不上（而它恰恰是给人排查排序用的，对不上比不展示更糟）。
    x.partsW = {
      tier: W.tier * parts.tier,
      quality: W.quality * parts.quality,
      avail: W.avail * parts.avail,
      speed: W.speed * parts.speed,
      load: W.load * parts.load,
    }
    x.qs = s                                     // 窗口统计留档(排查用; 排序不再依赖它)
    x.samples = {
      turns,                                      // 本次请求预估轮次(决定 speed 的评分基准)
      budget_ms: Math.round(speedBudgetMs),       // 该轮次下"满分慢"的毫秒阈值
      win: s.n,                                   // 质量/可用性窗口样本数(真实请求)
      win_model: s.model ? s.n : 0,               // 其中属于"这个模型自己"的样本数(0 = 只有供应商级弱证据)
      lat_model: (p.modelLatN && p.modelLatN[x.model]) || 0,  // 该模型自己的首字采样数
      lat_prov: p.latN || 0,                      // 该供应商的首字采样数
      lat_conf: +speedSamples(x).toFixed(2),      // 速度项实际用的置信度权重
    }
    return W.tier * parts.tier + W.quality * parts.quality + W.avail * parts.avail +
      W.speed * parts.speed + W.load * parts.load
  }
  // 分级: 0 = 正常参与竞争; 1 = 平均延迟已确知很慢 / 最近打过去全没成(不领跑, 但仍是可用候选);
  //       2 = 冷却中 / 模型冷却 / 无可用 Key(打过去必然失败, 是唯一的硬门槛)。
  // 只分三档而不是更多, 是为了让"同一档内按综合分排"这件事尽量干净 ——
  // 档位越多, 越容易退化成原来那种"逐键淘汰"。
  const bad = (x) => (x.ref.cooldownUntil || 0) > now || modelCooling(x.ref, x.model, now) || (!x.anon && x.keyIdx < 0) ? 1 : 0
  // "最近打过去没成过" → 不领跑(只降一档, 仍是候选, 不是硬门槛)。
  // 软失败刻意不进 quality(那不是"模型不行"), 但它确实说明"现在打不通"; 而冷却只有 60~90s,
  // 过期后它又回到队首 —— 实测(2026-09-25) empero 的模型连挂 2 次、gemini-3.8-flash 连挂 6 次,
  // 却因为"没有硬失败 + tier 不低"排在第 1、2 名, auto 每次都得先白等它们一轮才轮到真正能用的。
  // ⚠ 判据用 markFail 写的 downUntil(带 RECENT_DOWN_MS 期限), 而不是窗口比例 —— 因为**必须有期限**:
  //   只看窗口会死锁(降级 → 不被调用 → 永远没机会成功 → 永远降级), 见 RECENT_DOWN_MS 的说明。
  //   一次成功会在 markOk 里立刻清掉它(自愈, 不必等期限到)。
  const recentlyDown = (x) => ((x.ref.downUntil && x.ref.downUntil[x.model]) || 0) > now
  // 带图请求里"名字没有视觉信号"的模型不领跑(只降一档, 仍是候选 —— 与专用模型降档同一取舍)。
  // 免费池纯文本模型占多数且通常更快, 不降档它们会把视觉模型挤下去, 带图请求必然先撞一次 400。
  const visionMismatch = (x) => wantsVision && !visionLikely(x.model)
  // x.tier 必须在 rankOf 被调用之前算好 —— tierShort 要用它(下面 sort 与 healthy/rest 分流都在之后)。
  for (const x of chain) x.tier = modelTier(x.model, task)
  // ── "这道题比它强" → 不领跑(只降一档, 仍是候选, 不是硬门槛) ──
  // 这是"**复杂任务交给高端模型**"真正的落地点: reqTier 说"这题至少要几档"(工具/图片/多轮/长上下文),
  // x.tier 说"这个模型是几档"; 低于要求的不领跑, 但不排除 —— 与 isVerySlow / recentlyDown /
  // visionMismatch 同一取舍(池子小的厂商不会因此空链, 最差只是慢一点)。
  // ⚠ 只在 reqTier >= 2 时生效: 简单任务本来就是"给快的/小的", 那时按档位卡人正好搞反 ——
  //   实测闲聊队首是 allam-2-7b(tier 1), 靠的是 W_CHAT 里 speed 0.40 的权重, 不需要也不该有这条规则。
  const tierShort = (x) => reqTier >= 2 && x.tier < reqTier
  // rankInfo 同时给出"档位"与"原因" —— 排序用它, /api/route 也用它。
  // ⚠ 合成一个函数是刻意的: 判据只写一份, 否则展示的"为什么不领跑"会和真实排序悄悄分叉
  //   (这正是本项目反复踩过的"同一份数据两套过滤条件")。
  const rankInfo = (x) => {
    if (bad(x)) {
      const why = []
      if ((x.ref.cooldownUntil || 0) > now || modelCooling(x.ref, x.model, now)) why.push('cooling')
      if (!x.anon && x.keyIdx < 0) why.push('no_key')
      return { rank: 2, why }
    }
    const why = []
    if (isVerySlow(x)) why.push('very_slow')
    if (recentlyDown(x)) why.push('recently_down')
    if (visionMismatch(x)) why.push('vision_mismatch')
    if (tierShort(x)) why.push('tier_short')
    // 实测吃不下这么大的请求 -> 不领跑(与上面几条同一取舍: 只降档, 不排除)。
    // 理由见 pickChain 里 auto 分支那段: 排除会让"全都嫌大"直接变成空链。
    if (x.ctxTight) why.push('ctx_tight')
    return { rank: why.length ? 1 : 0, why }
  }
  const rankOf = (x) => rankInfo(x).rank
  // 先把分数算出来再排序(排序用 x.score; 下面的粘性门槛也要用它)。
  for (const x of chain) x.score = scoreOf(x)
  chain.sort((a, b) => {
    const ra = rankOf(a), rb = rankOf(b)
    if (ra !== rb) return ra - rb
    const d = (b.score || 0) - (a.score || 0)
    if (d) return d
    // 同分时才按路由组里的声明顺序排。**只做 tiebreak** —— 分数不同一律听分数,
    // 否则组内书写顺序就成了一套隐形的"单点判据"(这套路由为此踩过三次坑, 见上面的长注释)。
    const ga = a.grpIdx == null ? 1e9 : a.grpIdx
    const gb = b.grpIdx == null ? 1e9 : b.grpIdx
    return ga - gb
  })
  // 把"真实路由档位"与"不领跑的原因"留在候选对象上, 供 /api/route 展示 ——
  // 原来那个接口只回**列表位置**, 看不出"这个模型为什么排在后面"。排查排序时原因比分数更直接。
  // 交错会重建数组但对象不变, 所以这两个字段能安全活到最后(与 sticky 元数据不同, 那个挂在数组上)。
  for (const x of chain) { const ri = rankInfo(x); x.routeRank = ri.rank; x.demoted = ri.why }
  // ── 链序交错: 别让同一家的候选挨在一起 ──
  // 分数现在部分是**模型级**的(延迟/质量/可用性), 但同家候选仍常同分(尤其是都没样本时),
  // 纯按分数排会把同一家的候选排成一串。后果: 这家一限流, 链就连续撞同一家,
  // 每次白等一个完整往返才轮到别家 —— 用户侧就是"卡着不动然后突然换人"。
  // 改成贪心交错: 每次优先取"厂商与上一个不同"的最高分候选。只有一家可用时自动退化为原顺序。
  // 冷却中的候选不参与交错, 全部留在队尾(它们打过去必然失败, 换谁都没用)。
  // ⚠ 交错会重建数组, 挂在原数组上的自定义属性(粘性)必须先取下来, 否则会被丢掉 ——
  // 这类"换个数组引用就丢元数据"的坑在本文件里已经踩过一次(见 sticky 那段注释)。
  const stickyIdKept = chain._stickyId
  const stickyHashKept = chain._stickyHash
  const groupKept = chain._group
  const healthy = [], rest = []
  for (const x of chain) (rankOf(x) === 0 ? healthy : rest).push(x)
  const woven = []
  let lastProv = null
  while (healthy.length) {
    let i = healthy.findIndex((x) => x.ref.id !== lastProv)
    if (i < 0) i = 0
    const pick = healthy.splice(i, 1)[0]
    woven.push(pick)
    lastProv = pick.ref.id
  }
  chain = woven.concat(rest)
  chain._stickyId = stickyIdKept
  chain._stickyHash = stickyHashKept
  if (groupKept) chain._group = groupKept
  // ⚠ 必须在交错**之后**挂(交错会重建数组, 之前挂的自定义属性会被丢掉 —— 见 sticky 那段注释)。
  // 交给 attemptChain 写进 usage_log, 事后能回答"当时按几轮的基准排的序"。
  chain._turns = turns
  // 粘性提升放在最后: 顺序反了就等于没做(见上面 stickyId 处的说明)。
  // 只提升"健康的"那个候选 —— 它若在冷却/无 Key, 说明这一发打过去必然失败,
  // 粘性的意义是"保持连贯", 不是"锁定在一个坏候选上"。
  // ⚠ 还要求它**确实接近队首**(≥96%)。原来是无条件提升, 后果是"一次侥幸成功就把整个会话
  //   锁死在这个模型上 30 分钟"。实测(2026-09-25): 粘性把 codestral(代码模型)锁成了
  //   WorkBuddy 的默认模型, 用户体感"auto 比手动直接连一家差多了" —— 而它当时分数只排第 3。
  const sid = chain._stickyId
  if (sid && chain.length > 1) {
    const [sp, sm] = sid.includes('|') ? sid.split('|') : [sid, null]
    const i = chain.findIndex((x) => x.ref.id === sp && (sm === null || x.model === sm))
    const nearTop = i > 0 && (chain[i].score || 0) >= (chain[0].score || 0) * STICKY_MIN_RATIO
    // ⚠ 带图请求还要排除"视觉不匹配"的候选: 粘性的意义是省一次往返, 而粘到纯文本模型恰恰会
    //   白搭一次(撞 400 再回退)。纯文本请求下 visionMismatch 恒为 false, 老行为一个字节不变。
    if (nearTop && bad(chain[i]) === 0 && !visionMismatch(chain[i])) chain.unshift(chain.splice(i, 1)[0])
  }
  chain._reqTier = reqTier
  chain._task = task
  // "全链都嫌大"的计数 —— attemptChain 用它决定要不要走上下文降级(裁一段重发)。
  // 挂在数组上而不是靠调用方再算一遍: 判据只写一份, 否则展示/决策会悄悄分叉(本项目的老坑)。
  chain._ctxTight = chain.reduce((n, x) => n + (x.ctxTight ? 1 : 0), 0)
  return chain
}

// 选择该供应商当前可用的 Key(第一个既没被人工停用、也不在冷却中的); 全不可用返回 -1
// 多 Key 轮转: 在**可用**的 Key 里挑"最久没用过"的那把(从没用过的最优先)。
// ⚠ 旧实现是 `for i: if 可用 return i` —— 也就是**永远用第 0 把**, 第 2 把要等第 1 把被冷却
//   或人工停用才轮到。而免费池的瓶颈恰恰是**每把 Key 各自的每日 / RPM 额度**: 配了 3 把却只用 1 把,
//   等于把 3 份额度当成 1 份花, 而且切换点是"第 1 把已经被限流(429)"—— 那次请求已经白费了。
//   one-api 的渠道轮询、LiteLLM 的 deployment 负载均衡解决的都是这件事。
// 为什么用 lastUsed(LRU) 而不是取模轮转: 严格轮转在"某把 Key 一直 429"时会照样把请求送过去;
//   而 LRU + keyCooling 跳过 = 冷却中的自动让位, 剩下的按最久未用排, 效果等价于轮转,
//   且不需要维护额外游标(游标重启后会归零, 反而集中打第一把)。
// 单 Key 供应商行为完全不变(只有一把可选), 所以这条改动对绝大多数用户是零感知的。
function pickKeyIdx(p, now) {
  const keys = providerKeys(p)
  let best = -1
  let bestTs = Infinity
  for (let i = 0; i < keys.length; i++) {
    if (p.keyDisabled && p.keyDisabled[i]) continue   // 人工停用: 优先级高于冷却, 连试都不试
    if (keyCooling(p, i, now)) continue
    const st = (p.keyStats && p.keyStats[i]) || null
    // 从没用过 -> 0(最优先); 记的是 ISO 串, 解析失败也按 0 处理(宁可先试它, 不要把它饿死)
    const ts = (st && st.lastUsed) ? (Date.parse(st.lastUsed) || 0) : 0
    if (ts < bestTs) { bestTs = ts; best = i }
  }
  return best
}

// 连续失败退避: 第 1 次给 base, 之后每次翻倍, 封顶 cap。
// 为什么要有: 固定冷却只挡得住"刚才抖了一下"。一个真过载/真坏掉的模型冷却到期后**准时**回到竞争
//   队列, 于是每 base 秒被选中一次、白等一个完整往返、再冷却 —— 循环到天荒地老。实测(usage_log
//   2026-10-23): `gemini/gemini-3.8-flash` 13 次调用 10 次"过载"、全程 0% 成功;
//   `mistral/mistral-medium-3-5` 15 次里 13 次限流, 也是 0%。
// 为什么只对**连续**失败生效(markOk 一次清零): 单点判据不能定结果 —— 一次抖动必须还是 base,
//   否则偶发抖动会被放大成"这模型被踢出池子", 与"宁可漏判"相反。
// ⚠ 这是一条**冷却**, 不是拉黑: 到期照样回到候选链, 一次成功立刻恢复。
function streakBackoffMs(p, modelId, base, cap) {
  const streak = (p.failStreak && p.failStreak[modelId]) || 1
  return Math.min(base * Math.pow(2, Math.min(streak - 1, 5)), cap)
}
// 退避到第 3 次才值得说一声: 前两次是"抖了一下", 第 3 次起才是"这模型真的有问题",
// 而这种"悄悄变慢"正是本项目最难查的一类问题(请求不报错, 只是越来越慢)。
function noteBackoff(p, modelId, ms) {
  const streak = (p.failStreak && p.failStreak[modelId]) || 1
  if (streak >= 3) console.warn(`[backoff] ${p.name}/${modelId} 连续失败 ${streak} 次, 冷却 ${Math.round(ms / 60000)} 分钟`)
}

// ── "代理没开"不是厂商的问题 ──
// 病因在本机(代理没启动/端口不对), 修法是"把代理打开", 与厂商、Key、模型都无关。
// 旧行为把它当 network: **整家冷却 90 秒** —— 于是用户打开代理后还要再等 90 秒才能用,
// 而界面上没有任何东西解释为什么(实测 usage_log 里 6 次 `ECONNREFUSED 127.0.0.1:10808`)。
// 现在只冷却 5 秒(足够挡住同一次请求里的重复尝试), 且**不动** downUntil / failStreak / 质量统计:
// 一次代理没开不该把模型降级 30 分钟, 也不该算进"这模型不行"。
// 只认**确定性**的"连不上本机端口": ECONNREFUSED 是"那个端口上没人听"的铁证(代理没启动/端口写错)。
// 刻意**不收** ETIMEDOUT / ECONNRESET —— 它们也可能是目标站点自己挂了, 那种情况该按 network 正常
// 冷却 90 秒并降级。宁可漏判(退回 network), 也不要把真故障当成本机代理问题而放过。
const PROXY_DOWN_RE = /ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|socket hang up/i
function isProxyDown(p, status, bodyText) {
  if (status !== 0 || !p || !p.needs_proxy || !CFG.proxy) return false
  return PROXY_DOWN_RE.test(String(bodyText || ''))
}

// opts.real === true 表示"真实用户请求": 只有真实流量才进质量/可用性统计。
// 体检、拉黑复审、仪表盘测试按钮发的都是一次性合成探针 —— 一次瞬时 5xx 不该定排名,
// 它们只负责回答"现在能不能用/会不会扣费"这种确定性问题。
function markFail(p, status, modelId, retryAfterSec, keyIdx = -1, bodyText, opts = {}) {
  p.err = (p.err || 0) + 1
  p.lastError = `${new Date().toISOString()} [${modelId}] HTTP ${status}`
  p.modelCooldown = p.modelCooldown || {}
  p.keyCooldown = p.keyCooldown || {}
  p.blocked = p.blocked || {}
  // 代理不通要排在**所有**统计之前: 它不是这家的问题, 任何"记账"都会冤枉它(见 isProxyDown)。
  if (isProxyDown(p, status, bodyText)) {
    p.cooldownUntil = Date.now() + 5000
    p.lastError = `${new Date().toISOString()} [${modelId}] 代理 ${CFG.proxy} 连不上 —— 先把代理打开再重试(与厂商无关, 5 秒后即可)`
    saveConfig()
    return
  }
  // 模型级**连续**失败计数(一次成功就清零, 见 markOk)。用来给"反复失败的模型"做退避,
  // 见下方 5xx 分支的说明。跨模型独立计数: 一家有 17 个模型, 不能因为一个坏了就整家退避。
  p.failStreak = p.failStreak || {}
  p.failStreak[modelId] = (p.failStreak[modelId] || 0) + 1
  const kind = classifyUpstreamError(status, bodyText)
  const now = new Date().toISOString()
  // 逐 Key 统计: 放在最前面, 让"某把 Key 一直在失败"能被单独看见 ——
  // 以前只有供应商级 ok/err, 一把坏 Key 混在 3 把里, 表现只是"这家偶尔失败", 查不出来。
  if (keyIdx >= 0) {
    p.keyStats = p.keyStats || {}
    const s = p.keyStats[keyIdx] || (p.keyStats[keyIdx] = { ok: 0, err: 0, lastUsed: null })
    s.err++; s.lastUsed = now
  }
  // 软错误 = "现在恰好用不了", 不代表这家/这个模型不行: 不计入质量失败率(见 qualityErrRate)。
  // 这类失败已经由下面的冷却机制处理, 再额外算一次失败率等于对同一件事惩罚两遍。
  if (opts.real) pushQuality(p, SOFT_FAIL_KINDS.has(kind) ? 1 : 0, modelId)
  // 真实失败 → 该模型暂时失去领跑资格(只降一档, 仍是候选; 见 RECENT_DOWN_MS)。
  // 与冷却的区别: 冷却是**硬门槛**(打过去必然失败, 完全不打), 这个只是"排到健康的后面"。
  // ⚠ 排除 ctxtoolong: 那是"这次请求太大", 不是"这个模型现在打不通" —— 换个短对话它就好了,
  //   给它 30 分钟降级是误伤(它自己另有 10 分钟冷却, 够用了)。
  if (opts.real && modelId && kind !== 'ctxtoolong') {
    p.downUntil = p.downUntil || {}
    p.downUntil[modelId] = Date.now() + RECENT_DOWN_MS
  }
  if (SOFT_FAIL_KINDS.has(kind)) p.softErr = (p.softErr || 0) + 1
  // 实测学习: 带 tools 的请求被上游以"明确不支持"措辞拒绝 -> 记进该供应商的 noTools,
  // 之后带 tools 的路由直接跳过它, 省下一次必然失败的往返(名单见 modelSupportsTools)。
  // ⚠ 三重约束, 少一个都可能误伤: ① 本次请求**确实带了 tools**(否则这个 400 与 tools 无关);
  //   ② 状态是 400/422(客户端错误 = 参数问题, 不是上游抖动); ③ 正文命中 NO_TOOLS_RE。
  // 一次误判会让一个好模型在带 tools 的请求里被跳过 30 天, 所以宁可漏判。
  if (opts.tools && (status === 400 || status === 422) && bodyText && NO_TOOLS_RE.test(bodyText)) {
    p.noTools = p.noTools || {}
    if (!p.noTools[modelId]) {
      p.noTools[modelId] = { at: now, reason: String(bodyText).slice(0, 160) }
      // 能力标记变了 -> /v1/models 缓存立刻失效。这条路径**不经过 /api/***（它由真实请求触发），
      // 所以 5269 行那处"写操作清缓存"覆盖不到它 —— 不清的话客户端最多 30s 看不到 x_tools:false。
      MODELS_CACHE.at = 0
      console.warn(`[tools] ${p.name}/${modelId} 上游明确不支持 function calling, 已记入 noTools（30 天后自动重学）`)
    }
  }
  // 实测学习(与 noTools 同一套): 带图请求被上游以"明确不支持图片"措辞拒绝 -> 记进该供应商的
  // noVision, 之后带图请求直接跳过它。同样三重约束: ① 本次请求**确实带了图片**; ② 400/422;
  // ③ 正文命中 NO_VISION_RE。宁可漏判 —— 一次误判会让好模型在带图请求里被跳过 30 天。
  if (opts.vision && (status === 400 || status === 422) && bodyText && NO_VISION_RE.test(bodyText)) {
    p.noVision = p.noVision || {}
    if (!p.noVision[modelId]) {
      p.noVision[modelId] = { at: now, reason: String(bodyText).slice(0, 160) }
      MODELS_CACHE.at = 0   // 同上: 能力标记变了, 立刻让 /v1/models 缓存失效
      console.warn(`[vision] ${p.name}/${modelId} 上游明确不支持图片输入, 已记入 noVision（30 天后自动重学）`)
    }
  }
  // 容量记忆(与 noTools / noVision 同一套实测学习, 只是闸门换成"请求有多大"):
  // 上游明确回"请求太大" -> 记住**当时的请求规模**, 之后规模相当或更大的请求直接跳过它。
  // ⚠ 必须带 opts.chars: 这条闸门的意义完全在"规模"上, 没有规模就只剩冷却 —— 宁可不记,
  //   也不要瞎猜一个规模把好模型长期挡在门外(一次误判 = 该模型 30 天不参与大请求)。
  // ⚠ 取历次撞墙的**最小**规模: 撞过 50000 说明它吃不下 50000, 但 30000 仍可以试它。
  if (kind === 'ctxtoolong' && (status === 413 || status === 400 || status === 422) && opts.chars > 0) {
    p.ctxLimit = p.ctxLimit || {}
    const prev = p.ctxLimit[modelId]
    if (!prev || (prev.chars || 0) > opts.chars) {
      p.ctxLimit[modelId] = { at: now, chars: opts.chars, reason: String(bodyText || '').slice(0, 160) }
      console.warn(`[ctx] ${p.name}/${modelId} 实测吃不下 ${opts.chars} 字符的请求, 已记入 ctxLimit（30 天后自动重学）`)
    }
  }

  if (kind === 'billing' || kind === 'retired') {
    // 转收费 / 已下架 -> 拉黑(每天自动复审 REVIEW_DAYS, 恢复即放回)
    // ⚠ 但"已下架"的措辞是靠正则认的, 各家用词不统一, 光靠正文分不清"模型没了"还是
    //   "你的 Key 看不到它"。所以再加一道确定性信号: 若已判定这家**账号级看不到模型**
    //   (accountIssue, 来自 /v1/models 空列表或整池 404/401), 那 404 更可能是 Key 权限/路径
    //   问题 —— 这时只冷却 1 小时, 绝不拉黑。否则会把整家模型连坐(商汤那次是 8 个)。
    // ⚠ billing(402) 不享受这个豁免: 402 是明确的计费事实, 与账号能否看到模型无关。
    if (kind === 'retired' && accountIssueActive(p)) {
      p.modelCooldown[modelId] = Date.now() + 3600000
      p.lastError = `${now} [${modelId}] 疑似账号无该模型权限（非下架）, 冷却 1 小时 · ${p.accountIssue.note}`
      saveConfig()
      return
    }
    p.blocked[modelId] = { at: now, kind, reason: `HTTP ${status} ${bodyText ? bodyText.slice(0, 120) : ''}` }
    p.lastError = `${now} [${modelId}] ⛔${kind === 'billing' ? '已转收费' : '已下架'}, 拉黑(${REVIEW_DAYS}天后复审)`
    saveConfig()
    return
  }
  if (kind === 'quota') {
    // 免费额度用完 -> 只冷却该模型到"重置时间", 绝不拉黑(明天又是好汉)
    const ms = quotaCooldownMs(bodyText || '', retryAfterSec, p)
    p.modelCooldown[modelId] = Date.now() + ms
    p.lastError = `${now} [${modelId}] 额度已用完, 冷却 ${Math.round(ms / 60000)} 分钟后自动恢复`
    saveConfig()
    return
  }
  if (kind === 'overloaded') {
    // 模型过载 -> 短冷却 60s, 马上换链上下一家。
    // ⚠ 但**连续**过载要升级: 60s 固定冷却意味着一个真过载的模型每分钟被选中一次、白等一个往返
    //   (实测 `gemini/gemini-3.8-flash`: 13 次调用 10 次过载, 0% 成功)。60→120→240→480→600(封顶)。
    const ms = streakBackoffMs(p, modelId, 60000, 600000)
    p.modelCooldown[modelId] = Date.now() + ms
    p.lastError = `${now} [${modelId}] 上游过载, ${Math.round(ms / 1000)}s 后重试`
    noteBackoff(p, modelId, ms)
    saveConfig()
    return
  }
  if (kind === 'auth') {
    // Key 失效 = 冷却该 Key 10 分钟; 若全部 Key 都在冷却, 才冷却整个供应商
    if (keyIdx >= 0) p.keyCooldown[keyIdx] = Date.now() + 600000
    const keys = providerKeys(p)
    const allDown = keys.length > 0 && keys.every((_, i) => keyCooling(p, i))
    if (allDown) p.cooldownUntil = Date.now() + 600000
    else if (keyIdx < 0) p.cooldownUntil = Date.now() + 600000
  } else if (kind === 'network') {
    // 网络/代理/超时错误 = 整家冷却 90 秒 (与具体 Key 无关)
    p.cooldownUntil = Date.now() + 90000
  } else if (kind === 'notfound') {
    // 404 但正文不像下架(路径错误/无权限等) = 只冷却该模型 1 小时
    p.modelCooldown[modelId] = Date.now() + 3600000
  } else if (kind === 'ctxtoolong') {
    // 上下文超限: 同一对话的 payload 短时间内不会变小, 默认 90s 冷却会让下一条消息再撞一遍
    // 所有小窗口模型(WorkBuddy 49s 慢的根因)。给 10 分钟, 期间 auto 链自动跳过它们。
    p.modelCooldown[modelId] = Date.now() + 600000
    p.lastError = `${now} [${modelId}] 上下文超限, 10 分钟内跳过`
  } else if (kind === 'ratelimit') {
    // 速率限制: 学习该供应商 rpmCap = 触发前 60s 内的请求数
    p.rpmCap = Math.max(1, recentReqs(p.id) || p.rpmCap || 1)
    p.rpmCapAt = Date.now()   // 记录"最后一次撞限流"的时刻, markOk 里据此缓慢回升(见 rpmCap 自愈)
    // ⚠ 免 Key(anon)公共端点(OVH 2 RPM / Kilo 等)的限流窗口很短, 且是**共享配额** ——
    //   默认 90s / 1h 冷却会把它们长期踢出池子, 等于白接入。给一个短冷却(20s),
    //   并**只冷却这个模型**(不动整家), 让同家的其它模型继续可竞争。
    const ms = isAnonProvider(p) ? (retryAfterSec ? Math.min(retryAfterSec * 1000, 60000) : 20000)
      : (retryAfterSec ? Math.min(retryAfterSec * 1000, 600000) : 90000)
    p.modelCooldown[modelId] = Date.now() + ms
  } else {
    // 5xx/其他 = 该模型冷却 90 秒 —— 但**连续**失败要退避(曲线见 streakBackoffMs 的说明)。
    const backoff = streakBackoffMs(p, modelId, 90000, 720000)
    p.modelCooldown[modelId] = Date.now() + backoff
    noteBackoff(p, modelId, backoff)
  }
  saveConfig()
}
function markOk(p, modelId, keyIdx = -1, opts = {}) {
  p.ok = (p.ok || 0) + 1
  // 真的调通了 = 该 Key 确实能看到模型, "账号级无权限"的认知作废, 立刻解除豁免。
  // 放在最前面: 之后任何分支都不该让一个已被证伪的旧标记继续影响判断。
  clearAccountIssue(p)
  if (opts.real) pushQuality(p, 2, modelId)
  // 真的调通了 → 立刻恢复领跑资格(不必等 RECENT_DOWN_MS 到期)。
  if (modelId && p.downUntil) delete p.downUntil[modelId]
  // 同理清掉连续失败计数: 退避只针对"连续"失败, 中间成功一次就说明它现在好着呢。
  // 不清的话, 一个模型偶尔抖两下就会一路背到 12 分钟冷却, 那是"宁可错杀"的反面。
  if (modelId && p.failStreak) delete p.failStreak[modelId]
  // rpmCap 自愈: 学习值原来是"棘轮"—— 只在撞 429 时按当时的 60s 请求数写入, 之后**只降不升**。
  // 后果(实测 2026-09-18): openrouter/sensenova 被锁在 1, 意味着"60 秒内发过 1 个请求"就算已限流,
  // 这两个厂商共 29 个候选因此几乎永久降权, 池子里三分之一的名额形同虚设。
  // 现在: 连续 RPM_RECOVER_MS 没再撞限流就缓慢回升(+2, 上限 RPM_CAP_MAX), 再撞再降 ——
  // 升得慢降得快, 会自己收敛到该厂商真实的限流上限。
  if (p.rpmCap) {
    const at = p.rpmCapAt || 0
    if (Date.now() - at > RPM_RECOVER_MS) {
      p.rpmCap = Math.min(p.rpmCap + 2, RPM_CAP_MAX)
      p.rpmCapAt = Date.now()
    }
  }
  p.lastUsed = new Date().toISOString()
  p.lastError = ''
  p.cooldownUntil = 0
  if (p.modelCooldown && modelId) delete p.modelCooldown[modelId]
  if (keyIdx >= 0) {
    if (p.keyCooldown) delete p.keyCooldown[keyIdx]
    p.keyStats = p.keyStats || {}
    const s = p.keyStats[keyIdx] || (p.keyStats[keyIdx] = { ok: 0, err: 0, lastUsed: null })
    s.ok++; s.lastUsed = p.lastUsed
  }
  saveConfig()
}
// 首字节延迟学习(EMA): 免费池里各家速度差异巨大, 用它把快的排前面, 显著改善体感
// latN 记样本数: 排序时用样本量给"速度"这一项打折, 一个样本不能定排名(见 pickChain)。
// 同时记**模型级**: 同一家的模型速度可以差一个数量级(gemini-flash-lite vs gemini-3.8-flash,
// gemma-4-26b vs nemotron-550b), 只有供应商级会让同家所有模型分数完全相同、排不出高下。
function recordLatency(p, ms, modelId) {
  if (!ms || ms <= 0) return
  p.latency = p.latency ? Math.round(p.latency * 0.7 + ms * 0.3) : Math.round(ms)
  p.lastTtfb = Math.round(ms)
  p.latN = (p.latN || 0) + 1
  if (modelId) {
    p.modelLat = p.modelLat || {}
    p.modelLatN = p.modelLatN || {}
    const cur = p.modelLat[modelId]
    p.modelLat[modelId] = cur ? Math.round(cur * 0.7 + ms * 0.3) : Math.round(ms)
    p.modelLatN[modelId] = (p.modelLatN[modelId] || 0) + 1
  }
}

// ── 输出吞吐学习(EMA): TTFB 只描述"多久开始吐字", 描述不了"吐得多快" ──
// agent 场景的真实耗时是「多轮 × (首字 + 输出token / 吞吐)」, 免费池里吞吐差 3~5 倍,
// 只看 TTFB 会把"首字快但吐字慢"的家误判成快。单位 tok/s。同样分供应商级和模型级。
function recordThroughput(p, tokens, outMs, modelId) {
  if (!tokens || tokens < 20 || !outMs || outMs <= 0) return
  const tps = Math.round((tokens / outMs) * 1000)
  if (tps < 1 || tps > 2000) return   // 明显不合理的采样(统计口径错/上游乱报)直接丢
  p.tokps = p.tokps ? Math.round(p.tokps * 0.6 + tps * 0.4) : tps
  if (modelId) {
    p.modelTokps = p.modelTokps || {}
    const cur = p.modelTokps[modelId]
    p.modelTokps[modelId] = cur ? Math.round(cur * 0.6 + tps * 0.4) : tps
  }
}

// ── 质量/可用性统计: 只统计"真实用户请求", 且只统计"这家/这个模型本身行不行" ──
// 实测教训(2026-09-18): 原逻辑用**永久累计**的 p.err/(p.ok+p.err) 排序, 而 gemini 的 14 次失败里
// 13 次是"免费额度用完/过载/网络", openrouter 的 21 次失败**全部**是"每日免费额度耗尽" ——
// 一次都不是模型不行, 却把这两家(共 36 个候选, 含池里最强的一批)永久沉到链尾。
//
// 两条原则:
//  ① **探针结果不进质量统计**: 体检/复审/测试按钮发的是一次性 max_tokens=4 的合成请求,
//     一次瞬时 5xx 就能污染质量窗口 —— 那是"一次测试定排名"。探针只用于可用性与扣费判断
//     (402/404 是确定性事实), 质量必须由真实流量投票。
//  ② **软硬分开**: 限流/额度/网络/过载/上下文超限/Key 失效 = 软失败(现在恰好用不了, 已由冷却机制处理),
//     不算"模型不行"; 其余(下架/收费/5xx/找不到) = 硬失败。
// 窗口存最近 QUALITY_WINDOW 次真实请求的结果: 2=成功, 1=软失败, 0=硬失败。
// 用滑动窗口而不是永久累计, 是为了让一家恢复之后能重新爬回来, 不被历史数据永久定罪。
const QUALITY_WINDOW = 40
// ⚠ 'server'(裸 5xx, 正文没有过载措辞)也算**软失败**: 5xx 是上游故障, 不是"这个模型不行"。
//   实测(2026-09-19): gemini 全池 15 个模型在 20 秒内一起返回 5xx(代理/账号级抖动),
//   按硬失败记满 qWindow 后, 连最强的 gemini-3.8-flash 都被沉到第 12 名开外。
//   持续 5xx 的模型由冷却机制处理(90s), 不需要再罚一次质量分。
const SOFT_FAIL_KINDS = new Set(['auth', 'network', 'ratelimit', 'quota', 'overloaded', 'ctxtoolong', 'server'])
// rpmCap 自愈参数: 连续这么久没再撞限流就缓慢回升。升得慢降得快, 自己收敛到真实上限。
const RPM_RECOVER_MS = 10 * 60 * 1000
const RPM_CAP_MAX = 120
// 质量窗口**同时记两级**: 供应商级(老字段, 兼容) + 模型级(modelQ, 排序时优先)。
// 为什么必须有模型级: 供应商级会把整家连坐 —— 一家里有几个模型老失败, 全家的好模型一起沉底;
// 反过来"这家只跑过 A 模型且全成功"会让从没调用过的 B 模型白拿满分。两个方向都错, 同一个根因。
function pushQuality(p, code, modelId) {
  p.qWindow = p.qWindow || []
  p.qWindow.push(code)
  if (p.qWindow.length > QUALITY_WINDOW) p.qWindow.splice(0, p.qWindow.length - QUALITY_WINDOW)
  if (modelId) {
    p.modelQ = p.modelQ || {}
    const w = p.modelQ[modelId] || (p.modelQ[modelId] = [])
    w.push(code)
    if (w.length > QUALITY_WINDOW) w.splice(0, w.length - QUALITY_WINDOW)
  }
}
// 硬失败率 = "这个模型/这家本身不行"的概率(质量)
function qualityErrRate(p) {
  const w = p.qWindow
  if (!Array.isArray(w) || !w.length) return null   // 无样本 = 不知道, 不要假装知道
  let bad = 0
  for (const v of w) if (v === 0) bad++
  return bad / w.length
}
function modelCooling(p, id, now) {
  return (p.modelCooldown && p.modelCooldown[id] || 0) > now
}

// ---------------- 统计 ----------------
// candidateFail = 链上某个候选失败了、但被后面的候选救回(用户最终拿到结果)的次数。
// 它与 fail 的区别必须让用户看得见: fail=0 不代表"没出过问题", 而是"问题都被自动回退兜住了"。
// 只统计"请求级"的失败(HTTP 错误/网络错误), 不含被对冲主动取消的 skip(那不是失败)。
const STATS = { requests: 0, success: 0, fail: 0, fallbacks: 0, candidateFail: 0, tokens: 0, startedAt: new Date().toISOString() }

// ---------------- 模型使用记录(仪表盘「模型使用记录」板块) ----------------
// 逐**候选**事件日志: 一次请求可能产生多条(链上前几家失败、最后一家成功) —— 这正是它的价值,
// 它回答的是"为什么回退了", 而不只是"这次成不成"。持久化到 usage_log.json, 重启不丢。
// ⚠ 上限从 100 提到 2000: 100 条只够看最近几次请求, 装不下"昨晚为什么老失败"这种排查。
const USAGE_PATH = path.join(__dirname, 'usage_log.json')
const USAGE_CAP = 2000
let usageRecords = []
try {
  const u = JSON.parse(fs.readFileSync(USAGE_PATH, 'utf8'))
  if (Array.isArray(u)) usageRecords = u.slice(0, USAGE_CAP)
} catch (e) { if (fs.existsSync(USAGE_PATH)) console.warn('[usage] 读取失败, 从空记录开始:', (e && e.message) || e) }
let usageSaveTimer = null
function saveUsage() {
  clearTimeout(usageSaveTimer)
  usageSaveTimer = setTimeout(() => {
    usageSaveTimer = null
    try { writeJsonAtomic(USAGE_PATH, usageRecords.slice(0, USAGE_CAP), 0) } catch (e) { console.warn('[usage] 写盘失败', (e && e.message) || e) }
  }, 1200)   // 2000 条整份重写比 100 条贵, 防抖窗口相应放宽(退出时 flushAll 会兜底)
}
// extra 只认白名单字段: 别把任意对象摊进记录里 —— 2000 条 × 未知字段会把文件撑爆,
// 而 /api/usage 要把它整份读出来给仪表盘。
const USAGE_EXTRA_KEYS = ['id', 'ms', 'ttfb', 'status', 'tin', 'tout', 'kind', 'cand', 'turns']
function recordUsage(pname, model, ok, reason, extra = {}) {
  const rec = { at: new Date().toISOString(), provider: pname, model, ok, reason: (reason || '').slice(0, 200) }
  for (const k of USAGE_EXTRA_KEYS) {
    const v = extra[k]
    if (v !== undefined && v !== null && v !== '') rec[k] = v
  }
  usageRecords.unshift(rec)
  if (usageRecords.length > USAGE_CAP) usageRecords.length = USAGE_CAP
  saveUsage()
}

// ---------------- 请求级指标(仪表盘图表的唯一数据源) ----------------
// 与 usageRecords 的分工: usageRecords 记"候选级事件"(谁失败了、为什么), metrics 记
// "请求级聚合"(这一小时多少请求、成功多少、p50/p95 多少毫秒)。两者**刻意分开** ——
// 混在一起会出现"一个请求产生 3 条失败记录, 图上就显示 3 个失败请求"的假象。
//
// 结构: { updated_at, hours: { "YYYY-MM-DDTHH": { n, ok, fail, abort, msN, msSum, msSamples[],
//         ttfbN, ttfbSum, tin, tout, prov: {name: n} } } }
// ⚠ 必须留 msSamples 样本, 不能只存 sum/avg: 平均值会被一次 45s 超时拉平, 而用户真正
// 感受到的"偶尔卡一下"恰恰藏在 p95 里 —— 只看均值的面板永远是绿的。
const METRICS_PATH = path.join(__dirname, 'metrics.json')
const METRICS_HOURS = 168      // 滚动 7 天(小时桶)
const METRICS_SAMPLES = 120    // 每小时最多留 120 个耗时样本(够算 p50/p95, 又不让文件失控)
let metricsState = { updated_at: null, hours: {} }
try {
  const m = JSON.parse(fs.readFileSync(METRICS_PATH, 'utf8'))
  if (m && m.hours && typeof m.hours === 'object' && !Array.isArray(m.hours)) metricsState = { updated_at: m.updated_at || null, hours: m.hours }
} catch (e) { if (fs.existsSync(METRICS_PATH)) console.warn('[metrics] 读取失败, 从空开始:', (e && e.message) || e) }
let metricsSaveTimer = null
// 桶键用**本地时区**的小时(而非 UTC): 图表横轴要跟用户钟表上的时间对得上,
// 否则"晚上 8 点特别慢"会被画到下午。
function hourKey(ts = Date.now()) {
  const d = new Date(ts - new Date(ts).getTimezoneOffset() * 60000)
  return d.toISOString().slice(0, 13)
}
function saveMetrics() {
  clearTimeout(metricsSaveTimer)
  metricsSaveTimer = setTimeout(() => {
    metricsSaveTimer = null
    // 写之前先裁掉窗口外的桶, 否则文件会无限长大
    const keep = new Set()
    for (let i = 0; i < METRICS_HOURS; i++) keep.add(hourKey(Date.now() - i * 3600e3))
    for (const k of Object.keys(metricsState.hours)) if (!keep.has(k)) delete metricsState.hours[k]
    metricsState.updated_at = new Date().toISOString()
    try { writeJsonAtomic(METRICS_PATH, metricsState, 0) } catch (e) { console.warn('[metrics] 写盘失败', (e && e.message) || e) }
  }, 4000)
}
// ok 传 'abort' 表示"客户端主动断开"(不是模型的错, 不能算进失败率去冤枉供应商)
function recordMetrics(ok, ms, ttfb, tin, tout, provider) {
  const k = hourKey()
  const b = metricsState.hours[k] || (metricsState.hours[k] = { n: 0, ok: 0, fail: 0, abort: 0, msN: 0, msSum: 0, msSamples: [], ttfbN: 0, ttfbSum: 0, tin: 0, tout: 0, prov: {} })
  b.n++
  if (ok === 'abort') b.abort++
  else if (ok) b.ok++
  else b.fail++
  if (Number.isFinite(ms) && ms >= 0) {
    b.msN++; b.msSum += ms
    b.msSamples.push(Math.round(ms))
    if (b.msSamples.length > METRICS_SAMPLES) b.msSamples.shift()
  }
  if (Number.isFinite(ttfb) && ttfb > 0) { b.ttfbN++; b.ttfbSum += ttfb }
  if (tin) b.tin += tin
  if (tout) b.tout += tout
  if (provider) b.prov[provider] = (b.prov[provider] || 0) + 1
  saveMetrics()
}
function percentile(sorted, p) {
  if (!sorted.length) return null
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * p)))
  return sorted[i]
}
// 输出连续的小时序列(没有请求的小时补 0), 图表直接按数组画, 不用在浏览器里补洞
function metricsSeries(hours = 24) {
  const out = []
  const now = Date.now()
  for (let i = hours - 1; i >= 0; i--) {
    const k = hourKey(now - i * 3600e3)
    const b = metricsState.hours[k]
    if (!b) { out.push({ t: k, n: 0, ok: 0, fail: 0, abort: 0, ms_p50: null, ms_p95: null, ms_avg: null, ttfb_avg: null, tin: 0, tout: 0, prov: {} }); continue }
    const s = b.msSamples.slice().sort((a, c) => a - c)
    out.push({
      t: k, n: b.n, ok: b.ok, fail: b.fail, abort: b.abort,
      ms_p50: percentile(s, 0.5), ms_p95: percentile(s, 0.95),
      ms_avg: b.msN ? Math.round(b.msSum / b.msN) : null,
      ttfb_avg: b.ttfbN ? Math.round(b.ttfbSum / b.ttfbN) : null,
      tin: b.tin, tout: b.tout, prov: b.prov,
    })
  }
  return out
}
// 整个窗口的**总体**分位。⚠ 必须合并全部样本再算, 不能把每桶的 p95 平均 —— 分位数不可平均,
// 平均出来的数既不等于任何一桶, 也不等于整体, 只会给出一个没人能解释的中间值。
function metricsOverall(hours = 24) {
  const now = Date.now()
  const s = []
  let ttfbN = 0, ttfbSum = 0
  for (let i = hours - 1; i >= 0; i--) {
    const b = metricsState.hours[hourKey(now - i * 3600e3)]
    if (!b) continue
    for (const v of b.msSamples) s.push(v)
    ttfbN += b.ttfbN; ttfbSum += b.ttfbSum
  }
  s.sort((a, c) => a - c)
  return {
    ms_p50: percentile(s, 0.5), ms_p95: percentile(s, 0.95),
    ms_avg: s.length ? Math.round(s.reduce((a, c) => a + c, 0) / s.length) : null,
    ttfb_avg: ttfbN ? Math.round(ttfbSum / ttfbN) : null,
    ms_samples: s.length,
  }
}
// 把错误翻译成人话原因(仪表盘「模型使用记录」展示用, 不出现 HTTP 状态码)
const KIND_CN = {
  billing: '该模型已转收费，不再免费（已自动拉黑防扣费）',
  retired: '厂商已下架该模型（已自动拉黑）',
  quota: '免费额度已用完，到重置时间自动恢复',
  ratelimit: '请求太频繁触发了速率限制，稍等即可',
  overloaded: '模型当前过载，已自动换下一家',
  ctxtoolong: '请求太大或对话太长，超出该模型上限（10 分钟内自动跳过）',
  auth: '该家的 API Key 失效或无权限',
  notfound: '模型不存在或你的账号无权访问',
  server: '厂商服务器临时故障',
  network: '连不上厂商（网络不通或代理没开）',
}
function failReason(status, bodyText) {
  const kind = classifyUpstreamError(status, bodyText || '')
  const cn = KIND_CN[kind] || (status >= 400 ? '厂商返回异常，本次调用失败' : '调用异常')
  let extra = ''
  try {
    const j = JSON.parse(bodyText)
    extra = (j && (j.error && j.error.message || j.message || (Array.isArray(j.detail) && j.detail[0] && (j.detail[0].msg || j.detail[0].message)))) || ''
  } catch { extra = String(bodyText || '').replace(/\s+/g, ' ') }
  return cn + (extra ? ' · ' + String(extra).slice(0, 90) : '')
}
function parseRetryAfter(res) {
  const v = res.headers['retry-after']
  if (!v) return 0
  const n = parseInt(v, 10)
  return Number.isFinite(n) && n > 0 && n < 3600 ? n : 0
}
function countTokensFromJSON(text) {
  try { const u = JSON.parse(text).usage; return u ? (u.total_tokens || 0) : 0 } catch { return 0 }
}
function countTokensFromSSE(text) {
  // 从流式响应尾部找 usage 字段
  let best = 0
  for (const m of text.matchAll(/"total_tokens"\s*:\s*(\d+)/g)) best = Math.max(best, +m[1])
  return best
}
// 只取"输出"token 数, 用于吞吐统计 —— total_tokens 含 prompt, 拿它算吞吐会把
// "输入很长" 误判成 "输出很快"。取不到返回 0(放弃这次采样, 不猜)。
function countCompletionFromSSE(text) {
  let best = 0
  for (const m of text.matchAll(/"completion_tokens"\s*:\s*(\d+)/g)) best = Math.max(best, +m[1])
  return best
}

// ---------------- 协议适配层: Anthropic / Gemini / Ollama 原生格式 <-> OpenAI ----------------
// 思路: 各原生入口先归一为 OpenAI chat payload -> 复用 attemptChain 路由(冷却/统计/粘性同一套)
//       -> 再把 OpenAI 响应(含流式 SSE)转回目标协议。让 Claude Code / Gemini SDK / Ollama 生态客户端都能直连。
function blocksText(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.filter((b) => b && (b.type === 'text' || b.text)).map((b) => b.text || '').join('')
  return ''
}

// ── 多模态: 把 Anthropic / Gemini 的 content blocks 转成 OpenAI 的 content ──
// 原实现只走 blocksText, **图片块被静默丢弃** —— Claude 客户端贴张截图, 模型收到的是
// "看图说话"的指令却看不到图, 表现为"答得莫名其妙"而不是报错, 极难自查。
// 返回类型刻意分两种(与 OpenAI 规范一致): 纯文本 -> 字符串(老路径一个字节都不变);
// 含图片 -> parts 数组。sanitizePayload 的 part 白名单已放行 type/text/image_url, 不冲突。
// 只做**搬运**不做缩放/转码: 上游认不认这个格式由上游决定, 网关自作主张转码只会多一个失败面。
function blocksToOpenAIContent(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts = []
  let media = false
  for (const b of content) {
    if (!b || typeof b !== 'object') continue
    if (b.type === 'image' && b.source) {            // Anthropic: {type:'image',source:{type:'base64'|'url',...}}
      const s = b.source
      const url = (s.type === 'base64' && s.data) ? `data:${s.media_type || 'image/png'};base64,${s.data}`
        : (s.type === 'url' && s.url) ? s.url : ''
      if (url) { parts.push({ type: 'image_url', image_url: { url } }); media = true }
      continue
    }
    if (b.inlineData || b.inline_data) {             // Gemini: {inlineData:{mimeType,data}}
      const d = b.inlineData || b.inline_data
      if (d && d.data) { parts.push({ type: 'image_url', image_url: { url: `data:${d.mimeType || d.mime_type || 'image/png'};base64,${d.data}` } }); media = true }
      continue
    }
    if (b.fileData || b.file_data) {                 // Gemini: {fileData:{mimeType,fileUri}}
      const d = b.fileData || b.file_data
      const u = d && (d.fileUri || d.file_uri)
      if (u) { parts.push({ type: 'image_url', image_url: { url: u } }); media = true }
      continue
    }
    if (b.type === 'image_url' && b.image_url) {     // 已是 OpenAI 形态, 原样搬运
      parts.push({ type: 'image_url', image_url: b.image_url }); media = true
      continue
    }
    if (b.text) parts.push({ type: 'text', text: b.text })
  }
  if (!media) return parts.map((p) => p.text || '').join('')
  return parts.length ? parts : ''
}
// —— Anthropic Messages (/v1/messages) ——
// —— 工具调用跨协议转换（Anthropic / Gemini / Ollama <-> OpenAI）——
// 网关内部统一用 OpenAI 形态路由, 三家客户端的写法各不相同, 进出都要翻一次。
// 没有 tools 时这些函数一律返回空值, 调用方保持原行为 —— 老路径零影响。

// 请求侧: 把三家声明的工具规整成 OpenAI 的 tools 数组
function toOpenAITools(src) {
  if (!Array.isArray(src) || !src.length) return null
  const out = []
  for (const t of src) {
    if (!t) continue
    // Anthropic: 顶层 {name, description, input_schema}
    if (t.input_schema || (t.name && !t.type && !t.function)) {
      out.push({ type: 'function', function: { name: t.name, description: t.description || '', parameters: t.input_schema || { type: 'object', properties: {} } } })
      continue
    }
    // Gemini: 容器里挂 functionDeclarations(或下划线写法)
    const decls = t.functionDeclarations || t.function_declarations
    if (Array.isArray(decls)) {
      for (const d of decls) {
        if (!d || !d.name) continue
        out.push({ type: 'function', function: { name: d.name, description: d.description || '', parameters: d.parameters || { type: 'object', properties: {} } } })
      }
      continue
    }
    // 已是 OpenAI 形态(Ollama 新 API 就是) -> 原样保留
    if (t.function) out.push(t)
  }
  return out.length ? out : null
}
// tool_choice 三家语义相近但字面不同: Anthropic 用 auto/any/tool, OpenAI 用 auto/required/function
function toOpenAIToolChoice(tc) {
  if (!tc) return null
  const t = typeof tc === 'string' ? tc : tc.type
  if (t === 'auto') return 'auto'
  if (t === 'any' || t === 'required') return 'required'
  if (t === 'none') return 'none'
  if (t === 'tool' || t === 'function') {
    const nm = (typeof tc === 'object' && (tc.name || (tc.function && tc.function.name))) || ''
    return nm ? { type: 'function', function: { name: nm } } : 'required'
  }
  return null
}
// 响应侧: 从 OpenAI 响应里取出规整后的工具调用 [{id, name, input}]
function openAIToolCalls(obj) {
  const msg = (obj.choices && obj.choices[0] && obj.choices[0].message) || {}
  const raw = Array.isArray(msg.tool_calls) ? msg.tool_calls : []
  return raw.filter((tc) => tc && tc.function).map((tc) => ({
    id: tc.id || '',
    name: tc.function.name,
    input: safeJsonArgs(tc.function.arguments),
  }))
}
function safeJsonArgs(s) {
  if (!s) return {}
  try { return JSON.parse(s) } catch { return { _raw: s } }   // 上游吐出半截 JSON 时不丢内容
}
// 流式: OpenAI 把一次工具调用打散 —— 首个 delta 带 id+name, 后续每次只追加几个字符的 arguments。
// 三个协议都要求"攒齐了再整块发"(Anthropic 要 tool_use block, Gemini 要 functionCall),
// 所以统一在这里累积, 各协议只在流结束时取成品。
function toolCallAccumulator() {
  const calls = []
  return {
    feed(delta) {
      for (const tc of ((delta && delta.tool_calls) || [])) {
        const i = tc.index || 0
        if (!calls[i]) calls[i] = { id: '', name: '', args: '' }
        if (tc.id) calls[i].id = tc.id
        if (tc.function && tc.function.name) calls[i].name += tc.function.name
        if (tc.function && tc.function.arguments) calls[i].args += tc.function.arguments
      }
    },
    done() {
      return calls.filter((c) => c && c.name).map((c) => ({
        id: c.id || ('call_' + crypto.randomBytes(4).toString('hex')),
        name: c.name,
        input: safeJsonArgs(c.args),
      }))
    },
  }
}

function anthropicToOpenAI(body) {
  const messages = []
  const sys = body.system ? blocksText(Array.isArray(body.system) ? body.system.map((b) => ({ text: b.text })) : body.system) : ''
  if (sys) messages.push({ role: 'system', content: sys })
  for (const m of (body.messages || [])) messages.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: blocksToOpenAIContent(m.content) })
  const out = { model: body.model || 'auto', messages, stream: !!body.stream }
  if (body.max_tokens) out.max_tokens = body.max_tokens
  if (body.temperature != null) out.temperature = body.temperature
  if (body.top_p != null) out.top_p = body.top_p
  if (body.stop_sequences) out.stop = body.stop_sequences
  // 工具声明必须转: 丢了它上游模型就看不到工具, 客户端表现为"工具调用静默失效"
  const tl = toOpenAITools(body.tools); if (tl) out.tools = tl
  const tc = toOpenAIToolChoice(body.tool_choice); if (tc) out.tool_choice = tc
  return out
}
function openAIToAnthropic(obj, model) {
  const ch = (obj.choices && obj.choices[0]) || {}
  const text = (ch.message && ch.message.content) || ''
  const calls = openAIToolCalls(obj)
  const content = []
  if (text) content.push({ type: 'text', text })
  // Anthropic 用 content block 表达工具调用, 不是独立的 tool_calls 字段
  for (const c of calls) content.push({ type: 'tool_use', id: c.id, name: c.name, input: c.input })
  if (!content.length) content.push({ type: 'text', text: '' })   // content 不允许为空数组
  return {
    id: 'msg_' + ((obj.id || '').replace(/[^a-z0-9]/gi, '') || crypto.randomBytes(8).toString('hex')),
    type: 'message', role: 'assistant', model: obj.model || model,
    content,
    stop_reason: calls.length ? 'tool_use' : (ch.finish_reason === 'length' ? 'max_tokens' : 'end_turn'),
    usage: { input_tokens: (obj.usage && obj.usage.prompt_tokens) || 0, output_tokens: (obj.usage && obj.usage.completion_tokens) || 0 },
  }
}
function pipeOpenAISSEasAnthropic(up, res, model) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
  const msgId = 'msg_' + crypto.randomBytes(8).toString('hex')
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  send('message_start', { type: 'message_start', message: { id: msgId, type: 'message', role: 'assistant', model, content: [], stop_reason: null, usage: { input_tokens: 0, output_tokens: 0 } } })
  send('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
  send('ping', { type: 'ping' })
  const acc = toolCallAccumulator()
  // for await 按序拉取, 不依赖事件监听时序, 快速上游也不会丢块
  ;(async () => {
    let outTokens = 0
    let buf = ''
    try {
      for await (const chunk of up) {
        // 按行缓冲: TCP 分包可能切断一行 JSON, 直接 split 会两头解析失败 → 静默丢字
        buf += String(chunk)
        let nl
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl); buf = buf.slice(nl + 1)
          const t = line.trim()
          if (!t.startsWith('data:')) continue
          const p = t.slice(5).trim(); if (p === '[DONE]') continue
          try {
            const j = JSON.parse(p)
            const delta = j.choices && j.choices[0] && j.choices[0].delta
            if (delta) acc.feed(delta)              // 工具调用是分片来的, 先攒着
            const d = delta && delta.content
            if (d) { send('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: d } }); outTokens += Math.ceil(d.length / 4) }
            if (j.usage && j.usage.completion_tokens) outTokens = j.usage.completion_tokens
          } catch {}
        }
      }
    } catch {}
    send('content_block_stop', { type: 'content_block_stop', index: 0 })
    // 攒齐的工具调用整块补发: Anthropic 客户端要求 tool_use 是一个完整的 content block
    const calls = acc.done()
    calls.forEach((c, i) => {
      const idx = i + 1
      send('content_block_start', { type: 'content_block_start', index: idx, content_block: { type: 'tool_use', id: c.id, name: c.name, input: {} } })
      send('content_block_delta', { type: 'content_block_delta', index: idx, delta: { type: 'input_json_delta', partial_json: JSON.stringify(c.input) } })
      send('content_block_stop', { type: 'content_block_stop', index: idx })
    })
    send('message_delta', { type: 'message_delta', delta: { stop_reason: calls.length ? 'tool_use' : 'end_turn' }, usage: { output_tokens: outTokens } })
    send('message_stop', { type: 'message_stop' })
    STATS.tokens += outTokens; res.end()
  })()
}
// —— OpenAI Responses (/v1/responses) ——
// 2026-10-17 新增: Codex CLI 这类新一代 Agent 只讲 Responses 协议, 之前这里一律回 501,
// 于是"用免费池跑 Codex"根本走不通(客户端不会自己降级)。转换口径和 Anthropic / Gemini
// 那两套完全一致: **只在形状上搬运, 不改语义**; 请求里没有 tools 时不影响任何老路径。
// ⚠ 不支持的 Responses 专有能力(store / previous_response_id / 内置工具 web_search 等)一律
//   静默忽略而不是报错 —— 我们本来就无状态, 报错只会让客户端连第一句都发不出来。
function responsesTools(src) {
  if (!Array.isArray(src) || !src.length) return null
  const out = []
  for (const t of src) {
    if (!t || t.type !== 'function' || !t.name) continue   // 内置工具(web_search/file_search/mcp)直接跳过
    out.push({ type: 'function', function: { name: t.name, description: t.description || '', parameters: t.parameters || { type: 'object', properties: {} } } })
  }
  return out.length ? out : null
}
// Responses 的 content 片段: input_text / output_text / text 都是文本, input_image 的
// image_url 是**字符串**(Chat 那边是对象), 这是两边最容易踩空的一处差异。
function responsesContent(c) {
  if (typeof c === 'string') return c
  if (!Array.isArray(c)) return ''
  const parts = []
  let media = false
  for (const b of c) {
    if (!b || typeof b !== 'object') continue
    if (b.text) { parts.push({ type: 'text', text: b.text }); continue }
    if (b.type === 'input_image' || b.type === 'image_url') {
      const u = typeof b.image_url === 'string' ? b.image_url : ((b.image_url && b.image_url.url) || b.url || '')
      if (u) { parts.push({ type: 'image_url', image_url: { url: u } }); media = true }
    }
  }
  if (!media) return parts.map((p) => p.text || '').join('')
  return parts.length ? parts : ''
}
function responsesToOpenAI(body) {
  const messages = []
  const ins = body.instructions
  if (ins) {
    const t = typeof ins === 'string' ? ins : blocksText(Array.isArray(ins) ? ins : [ins])
    if (t) messages.push({ role: 'system', content: t })
  }
  const input = body.input
  if (typeof input === 'string') messages.push({ role: 'user', content: input })
  else if (Array.isArray(input)) {
    for (const it of input) {
      if (!it || typeof it !== 'object') continue
      // 工具调用历史: Responses 平铺成 output_item, Chat 要求挂在 assistant.tool_calls 上。
      // 连续多个 function_call 必须并进**同一条** assistant 消息, 拆成多条上游会 400。
      if (it.type === 'function_call') {
        const call = {
          id: it.call_id || it.id || ('call_' + crypto.randomBytes(4).toString('hex')),
          type: 'function',
          function: { name: it.name || '', arguments: typeof it.arguments === 'string' ? it.arguments : JSON.stringify(it.arguments || {}) },
        }
        const last = messages[messages.length - 1]
        if (last && last.role === 'assistant' && last.tool_calls) last.tool_calls.push(call)
        else messages.push({ role: 'assistant', content: '', tool_calls: [call] })
        continue
      }
      if (it.type === 'function_call_output') {
        const out = typeof it.output === 'string' ? it.output : JSON.stringify(it.output == null ? '' : it.output)
        messages.push({ role: 'tool', tool_call_id: it.call_id || '', content: out })
        continue
      }
      const role = it.role === 'developer' ? 'system' : it.role   // developer 是 Responses 的 system 别名
      if (!role) continue
      messages.push({ role, content: responsesContent(it.content) })
    }
  }
  const out = { model: body.model || 'auto', messages, stream: !!body.stream }
  if (body.max_output_tokens) out.max_tokens = body.max_output_tokens
  if (body.temperature != null) out.temperature = body.temperature
  if (body.top_p != null) out.top_p = body.top_p
  const tl = responsesTools(body.tools); if (tl) out.tools = tl
  const tc = toOpenAIToolChoice(body.tool_choice); if (tc) out.tool_choice = tc
  return out
}
function responsesSkeleton(id, model, status) {
  return { id, object: 'response', created_at: Math.floor(Date.now() / 1000), status, model, output: [] }
}
function openAIToResponses(obj, model) {
  const ch = (obj.choices && obj.choices[0]) || {}
  const msg = ch.message || {}
  const text = typeof msg.content === 'string' ? msg.content : blocksText(msg.content || [])
  const calls = openAIToolCalls(obj)
  const output = []
  if (text || !calls.length) {
    output.push({
      type: 'message', id: 'msg_' + crypto.randomBytes(8).toString('hex'), role: 'assistant', status: 'completed',
      content: [{ type: 'output_text', text, annotations: [] }],
    })
  }
  // 工具调用是**独立的 output_item**, 不是 message 里的 content block —— 这是 Responses 与
  // Anthropic 最不一样的地方(Anthropic 塞进 content, 这里平铺)。
  for (const c of calls) {
    output.push({
      type: 'function_call', id: 'fc_' + crypto.randomBytes(8).toString('hex'), call_id: c.id,
      name: c.name, arguments: JSON.stringify(c.input), status: 'completed',
    })
  }
  const u = obj.usage || {}
  const resp = responsesSkeleton('resp_' + crypto.randomBytes(8).toString('hex'), obj.model || model, 'completed')
  resp.output = output
  resp.output_text = text
  resp.usage = { input_tokens: u.prompt_tokens || 0, output_tokens: u.completion_tokens || 0, total_tokens: u.total_tokens || ((u.prompt_tokens || 0) + (u.completion_tokens || 0)) }
  return resp
}
function pipeOpenAISSEasResponses(up, res, model) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
  const respId = 'resp_' + crypto.randomBytes(8).toString('hex')
  const itemId = 'msg_' + crypto.randomBytes(8).toString('hex')
  let seq = 0
  const send = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: seq++, ...data })}\n\n`)
  send('response.created', { response: responsesSkeleton(respId, model, 'in_progress') })
  send('response.in_progress', { response: responsesSkeleton(respId, model, 'in_progress') })
  const item = { type: 'message', id: itemId, role: 'assistant', status: 'in_progress', content: [] }
  send('response.output_item.added', { output_index: 0, item })
  send('response.content_part.added', { item_id: itemId, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } })
  const acc = toolCallAccumulator()
  ;(async () => {
    let full = ''
    let outTokens = 0
    let buf = ''
    try {
      for await (const chunk of up) {
        // 按行缓冲(和 Anthropic 那条一样): TCP 分包会切断一行 JSON, 直接 split 会两头解析失败 → 静默丢字
        buf += String(chunk)
        let nl
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl); buf = buf.slice(nl + 1)
          const t = line.trim()
          if (!t.startsWith('data:')) continue
          const p = t.slice(5).trim(); if (p === '[DONE]') continue
          try {
            const j = JSON.parse(p)
            const delta = j.choices && j.choices[0] && j.choices[0].delta
            if (delta) acc.feed(delta)
            const d = delta && delta.content
            if (d) {
              full += d
              send('response.output_text.delta', { item_id: itemId, output_index: 0, content_index: 0, delta: d })
              outTokens += Math.ceil(d.length / 4)
            }
            if (j.usage && j.usage.completion_tokens) outTokens = j.usage.completion_tokens
          } catch {}
        }
      }
    } catch {}
    // 收尾: 文本 item 先落地, 工具调用作为独立 item 逐个补发, 最后才是 completed
    send('response.output_text.done', { item_id: itemId, output_index: 0, content_index: 0, text: full })
    send('response.content_part.done', { item_id: itemId, output_index: 0, content_index: 0, part: { type: 'output_text', text: full, annotations: [] } })
    send('response.output_item.done', { output_index: 0, item: { type: 'message', id: itemId, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: full, annotations: [] }] } })
    const calls = acc.done()
    const out = [{ type: 'message', id: itemId, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: full, annotations: [] }] }]
    calls.forEach((c, i) => {
      const fc = { type: 'function_call', id: 'fc_' + crypto.randomBytes(8).toString('hex'), call_id: c.id, name: c.name, arguments: JSON.stringify(c.input), status: 'completed' }
      send('response.output_item.added', { output_index: i + 1, item: { ...fc, status: 'in_progress' } })
      send('response.function_call_arguments.delta', { item_id: fc.id, output_index: i + 1, delta: fc.arguments })
      send('response.output_item.done', { output_index: i + 1, item: fc })
      out.push(fc)
    })
    const done = responsesSkeleton(respId, model, 'completed')
    done.output = out
    done.output_text = full
    done.usage = { input_tokens: 0, output_tokens: outTokens, total_tokens: outTokens }
    send('response.completed', { response: done })
    STATS.tokens += outTokens; res.end()
  })()
}

// —— Gemini (/v1beta/models/<model>:generateContent | :streamGenerateContent) ——
function geminiToOpenAI(body, model) {
  const messages = []
  const si = body.systemInstruction || body.system_instruction
  if (si) { const t = si.parts ? blocksText(si.parts.map((p) => ({ text: p.text }))) : (si.text || ''); if (t) messages.push({ role: 'system', content: t }) }
  for (const c of (body.contents || [])) messages.push({ role: c.role === 'model' ? 'assistant' : 'user', content: c.parts ? blocksToOpenAIContent(c.parts) : '' })
  const gc = body.generationConfig || body.generation_config || {}
  const out = { model: model || body.model || 'auto', messages, stream: false }
  const mt = gc.maxOutputTokens ?? gc.max_output_tokens; if (mt) out.max_tokens = mt
  if (gc.temperature != null) out.temperature = gc.temperature
  const tp = gc.topP ?? gc.top_p; if (tp != null) out.top_p = tp
  const tl = toOpenAITools(body.tools); if (tl) out.tools = tl
  // Gemini 把"是否必须用工具"放在 toolConfig.functionCallingConfig.mode
  const fcm = body.toolConfig && body.toolConfig.functionCallingConfig && body.toolConfig.functionCallingConfig.mode
  const tc = toOpenAIToolChoice(fcm === 'ANY' ? 'any' : fcm === 'NONE' ? 'none' : fcm === 'AUTO' ? 'auto' : null)
  if (tc) out.tool_choice = tc
  return out
}
function openAIToGemini(obj) {
  const ch = (obj.choices && obj.choices[0]) || {}
  const text = (ch.message && ch.message.content) || ''
  const u = obj.usage || {}
  const parts = []
  if (text) parts.push({ text })
  // Gemini 把工具调用放在 parts 里的 functionCall
  for (const c of openAIToolCalls(obj)) parts.push({ functionCall: { name: c.name, args: c.input } })
  if (!parts.length) parts.push({ text: '' })
  return {
    candidates: [{ content: { role: 'model', parts }, finishReason: ch.finish_reason === 'length' ? 'MAX_TOKENS' : 'STOP' }],
    usageMetadata: { promptTokenCount: u.prompt_tokens || 0, candidatesTokenCount: u.completion_tokens || 0, totalTokenCount: u.total_tokens || 0 },
  }
}
function pipeOpenAISSEasGemini(up, res) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
  const acc = toolCallAccumulator()
  ;(async () => {
    let outTokens = 0
    let buf = ''
    try {
      for await (const chunk of up) {
        // 按行缓冲: TCP 分包可能切断一行 JSON, 直接 split 会两头解析失败 → 静默丢字
        buf += String(chunk)
        let nl
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl); buf = buf.slice(nl + 1)
          const t = line.trim(); if (!t.startsWith('data:')) continue
          const p = t.slice(5).trim(); if (p === '[DONE]') continue
          try {
            const j = JSON.parse(p)
            const delta = j.choices && j.choices[0] && j.choices[0].delta
            if (delta) acc.feed(delta)
            const d = delta && delta.content
            if (d) { res.write(`data: ${JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: d }] } }] })}\n\n`); outTokens += Math.ceil(d.length / 4) }
          } catch {}
        }
      }
    } catch {}
    const gc = acc.done()
    const endParts = gc.length ? gc.map((c) => ({ functionCall: { name: c.name, args: c.input } })) : []
    res.write(`data: ${JSON.stringify({ candidates: [{ content: { role: 'model', parts: endParts } }], usageMetadata: { candidatesTokenCount: outTokens } })}\n\n`)
    STATS.tokens += outTokens; res.end()
  })()
}
// —— Ollama (/api/chat | /api/generate) ——
function ollamaToOpenAI(body, kind) {
  const messages = []
  if (kind === 'generate') {
    if (body.system) messages.push({ role: 'system', content: body.system })
    messages.push({ role: 'user', content: body.prompt || '' })
  } else {
    for (const m of (body.messages || [])) messages.push({ role: m.role === 'assistant' ? 'assistant' : (m.role === 'system' ? 'system' : 'user'), content: typeof m.content === 'string' ? m.content : '' })
  }
  const out = { model: body.model || 'auto', messages, stream: body.stream !== false }
  const o = body.options || {}
  if (o.temperature != null) out.temperature = o.temperature
  if (o.num_predict) out.max_tokens = o.num_predict
  if (o.top_p != null) out.top_p = o.top_p
  const tl = toOpenAITools(body.tools); if (tl) out.tools = tl   // Ollama 已是 OpenAI 形态, 原样透传
  return out
}
// OpenAI finish_reason → Ollama done_reason。Ollama 客户端只认 stop / length,
// 被 max_tokens 截断时必须报 length —— 否则下游会以为回答已完整, 半截内容被当成最终答案。
function ollamaDoneReason(fr) { return fr === 'length' ? 'length' : 'stop' }
function openAIToOllama(obj, model, kind) {
  const ch = (obj.choices && obj.choices[0]) || {}
  const text = (ch.message && ch.message.content) || ''
  const u = obj.usage || {}
  const base = { model: obj.model || model, created_at: new Date().toISOString(), done: true, done_reason: ollamaDoneReason(ch.finish_reason), prompt_eval_count: u.prompt_tokens || 0, eval_count: u.completion_tokens || 0 }
  // Ollama 用的是 OpenAI 形态的 tool_calls, 直接透传原始数组即可(/api/generate 无消息结构, 不支持工具)
  const rawCalls = (ch.message && Array.isArray(ch.message.tool_calls)) ? ch.message.tool_calls : []
  const msg = { role: 'assistant', content: text }
  if (rawCalls.length) msg.tool_calls = rawCalls
  return kind === 'generate' ? { ...base, response: text } : { ...base, message: msg }
}
function pipeOpenAISSEasOllama(up, res, model, kind) {
  res.writeHead(200, { 'content-type': 'application/x-ndjson' })
  const emit = (obj) => res.write(JSON.stringify(obj) + '\n')
  const acc = toolCallAccumulator()
  ;(async () => {
    let outTokens = 0
    let buf = ''
    let finish = null
    try {
      for await (const chunk of up) {
        // 必须按行缓冲: TCP 分包可能把一行 JSON 切成两块, 直接 split 会两头都解析失败 → 静默丢字
        buf += String(chunk)
        let nl
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl); buf = buf.slice(nl + 1)
          const t = line.trim(); if (!t.startsWith('data:')) continue
          const p = t.slice(5).trim(); if (p === '[DONE]') continue
          try {
            const j = JSON.parse(p)
            const choice = j.choices && j.choices[0]
            if (choice && choice.finish_reason) finish = choice.finish_reason
            const delta = choice && choice.delta
            if (delta) acc.feed(delta)
            const d = delta && delta.content
            if (d) { emit(kind === 'generate' ? { model, created_at: new Date().toISOString(), response: d, done: false } : { model, created_at: new Date().toISOString(), message: { role: 'assistant', content: d }, done: false }); outTokens += Math.ceil(d.length / 4) }
          } catch {}
        }
      }
    } catch {}
    // Ollama 认 OpenAI 形态的 tool_calls, 攒齐后整块放在最后一条消息里
    const oCalls = acc.done().map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.input) } }))
    const endMsg = { role: 'assistant', content: '' }
    if (oCalls.length) endMsg.tool_calls = oCalls
    const reason = ollamaDoneReason(finish)
    emit(kind === 'generate' ? { model, created_at: new Date().toISOString(), response: '', done: true, done_reason: reason, eval_count: outTokens } : { model, created_at: new Date().toISOString(), message: endMsg, done: true, done_reason: reason, eval_count: outTokens })
    STATS.tokens += outTokens; res.end()
  })()
}
// 错误响应带上 request_id: 用户报"刚刚那次失败了"时, 凭这个 id 能在 usage_log 里
// 精确捞到那一条, 不用靠时间戳猜是哪次。
function nativeError(res, protocol, e, ctx) {
  const status = e.status || 502
  const rid = ctx && ctx.id
  if (protocol === 'anthropic') return json(res, status, { type: 'error', error: { type: 'api_error', message: e.message, request_id: rid } })
  if (protocol === 'gemini') return json(res, status, { error: { code: status, message: e.message, status: 'UPSTREAM_ERROR', request_id: rid } })
  // ⚠ Ollama 的错误体必须是**字符串**(它的客户端按 {error:"..."} 解析), 不能为了塞
  // request_id 改成对象 —— 那会让 Ollama 客户端读不到错误信息。id 走 x-request-id 响应头。
  return json(res, status, { error: e.message })
}
function newReqId() { return crypto.randomUUID().slice(0, 8) }
// 原生客户端在不同字段带 key, 统一校验网关 Key
function authedAny(req, url) {
  const h = req.headers
  const cands = [
    (h.authorization || '').replace(/^Bearer\s+/i, '').trim(),
    h['x-gateway-key'], h['x-api-key'], h['x-goog-api-key'],
    url.searchParams.get('key'),
  ].filter(Boolean)
  return cands.some((k) => safeEqual(k, CFG.gatewayKey))
}
// ---------------- 管理接口鉴权模式(结构预留) ----------------
// 现状: 服务**硬绑 127.0.0.1**(见 server.listen), 所以 /api/* 管理接口默认不鉴权 ——
// "本机即可信"是"双击即用"的前提, 不能动它。
// 但将来若把网关分享出去(反向代理 / 内网暴露 / 换绑 0.0.0.0), "本机即可信"立刻变成
// "谁都能改我的 Key、解除我的扣费拉黑"。这里预留一个显式开关, 默认**完全不生效**:
//   auth: { mode: 'local' }                       ← 默认, 行为与改造前逐字节一致
//   auth: { mode: 'token', token: '<长随机串>' }   ← 管理接口要求 x-admin-token 头
// 为什么不默认开: 一开用户就得先配令牌才能打开仪表盘, 对单机用户是纯负担;
// 真正的防线是"只监听环回", 这个开关是给"以后要分享"预留的接口, 不是替代它。
// token 模式与网关 Key 是**两套凭据**: 网关 Key 给客户端调模型用, 会被下发到各客户端;
// 管理令牌只给你自己改配置用, 不该跟着客户端到处跑。
// **实际生效**的鉴权模式。对外只报这个值, 不报配置值 ——
// "配了 token 模式却没配有效令牌"是最容易自以为安全的情况(以为开了, 其实没开),
// 报配置值等于帮着一起撒谎。
function effectiveAuthMode() {
  const a = CFG.auth || {}
  if (a.mode !== 'token') return 'local'
  return String(a.token || '').length >= 16 ? 'token' : 'local'
}
function adminAuthed(req) {
  if (effectiveAuthMode() !== 'token') return true
  const t = String(CFG.auth.token)
  const got = String(req.headers['x-admin-token'] || '').trim() ||
    String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim()
  return !!got && safeEqual(got, t)
}

// 客户端断开(点了停止 / 关掉页面 / 网络断) → 立刻中止上游请求。
// 为什么必须做: 上游请求原来会一直跑到 45s(非流式首字节) / 60s(流式空闲) / 90s(总超时) 才结束,
// 期间免费额度已经消耗掉了 —— 而免费额度正是这个网关最稀缺的资源。
// 用 res.writableEnded 区分"正常写完结束"与"客户端中途断连": 前者会先 end 再 close。
// 把"这次实际是谁答的"写进响应头。只给 x-request-id 的话, 调用方想知道走了哪家还得再去翻日志,
// 而很多场景就是想当场知道(比如"为什么这次的回答风格突然变了")。
// 前缀刻意用 x-xiaoji- 而不是 x-provider / x-model: 后者在个别客户端里有既有含义, 不抢名字。
// 整段用 try 包住: 头一旦发出去再 setHeader 会抛异常, 绝不能因为一个提示性的头把响应打死。
function setSourceHeaders(res, r) {
  if (!res || res.headersSent) return
  try {
    res.setHeader('x-xiaoji-provider', (r.provider && r.provider.name) || '')
    res.setHeader('x-xiaoji-model', r.model || '')
    // 打过的候选家数(含成功那家): 1 = 一发命中, >1 = 回退过
    res.setHeader('x-xiaoji-attempts', String((r.attempts || 0) + 1))
    if (r.alias) res.setHeader('x-xiaoji-alias', r.alias)
    // 这次用的是路由组时也标出来: 组名本身不说明"实际是谁答的", 但能说明"候选是被收窄过的",
    // 排查"为什么老是这几个模型"时这一步最省时间。
    if (r.group) res.setHeader('x-xiaoji-group', r.group)
    // 这次为了塞进模型窗口裁过历史 —— 客户端/用户看到"模型忘了我前面说的"时,
    // 这是唯一能查到原因的入口(仪表盘只记日志, 用户不会去看)。
    // 值保持纯 ASCII: `2msg;45000->12000c` = 丢了 2 条历史, 规模从 45000 字符压到 12000。
    if (r.compacted) {
      const c = r.compacted
      res.setHeader('x-xiaoji-compacted', `${c.dropped}msg;${c.before}->${c.after}c`)
    }
    // 这次的结果是**复用**了一个同时在飞的相同请求（没有真的打上游）—— 排查"为什么配额消耗比
    // 请求数少"时, 这个头是唯一能解释的入口。
    if (r.coalesced) res.setHeader('x-xiaoji-coalesced', '1')
  } catch {}
}
function hookClientAbort(res, up, pname, model, ctx) {
  if (CFG.cancelPropagation === false) return   // 出问题可一键关掉(见 config.json)
  const onGone = () => {
    if (res.writableEnded) return      // 正常结束
    if (res.__clientGone) return       // 只处理一次
    res.__clientGone = true
    try { up.destroy() } catch {}
    try { if (up.__upReq) up.__upReq.destroy() } catch {}
    // ⚠ STATS.aborted 的计数统一放在 serveWithSlot 的请求级信号里(那里才是唯一能覆盖
    // "断开发生在拿到响应头之前"的位置), 这里不再自增 —— 否则同一次断开会被记两遍。
    recordUsage(pname, model, false, '客户端已断开，已中止上游请求（不再空烧额度）', ctxExtra(ctx))
    // 指标里记成 abort 而不是 fail: 这是用户自己点的停止, 不该污染"模型成功率"
    recordMetrics('abort', ctx ? Date.now() - ctx.t0 : 0, up && up.__ttfb, 0, 0, pname)
  }
  res.on('close', onGone)
}
// 把请求上下文摊成 recordUsage 的 extra。集中一处, 免得每个调用点各写一遍、早晚漏字段。
function ctxExtra(ctx, more) {
  if (!ctx) return more || {}
  const o = { id: ctx.id, kind: ctx.kind, ...(more || {}) }
  if (more && more.ms == null) o.ms = Date.now() - ctx.t0
  return o
}
async function serveNative(req, res, url, protocol, kind) {
  // 同 handleChat: 复用最外层生成的请求 id, 保证响应头/错误体/日志一致
  const ctx = { id: req.__rid || newReqId(), kind: protocol, t0: Date.now(), req }
  try { res.setHeader('x-request-id', ctx.id) } catch {}
  if (!authedAny(req, url)) return nativeError(res, protocol, Object.assign(new Error('无效的网关 Key'), { status: 401 }), ctx)
  let bodyStr
  try { bodyStr = await readBodyStr(req) }
  catch (e) { return nativeError(res, protocol, e, ctx) }
  let raw
  try { raw = JSON.parse(bodyStr) } catch { return nativeError(res, protocol, Object.assign(new Error('invalid json'), { status: 400 }), ctx) }
  let payload
  if (protocol === 'anthropic') payload = anthropicToOpenAI(raw)
  else if (protocol === 'responses') payload = responsesToOpenAI(raw)
  else if (protocol === 'gemini') { const mm = url.pathname.match(/models\/([^:]+):/); payload = geminiToOpenAI(raw, mm && decodeURIComponent(mm[1])) }
  else payload = ollamaToOpenAI(raw, kind)
  STATS.requests++
  // Gemini 的 :streamGenerateContent 本身就是"我要流式"的语义(SDK 还会带 alt=sse),
  // 但 Gemini 请求体里没有 stream 字段 —— 只信 payload.stream 会永远走聚合分支,
  // 流式客户端拿到的是一次性 JSON, 表现为"卡住直到全部生成完"。
  let isStream = !!payload.stream
  if (protocol === 'gemini' && (/:streamGenerateContent$/.test(url.pathname) || url.searchParams.get('alt') === 'sse')) {
    isStream = true
    payload.stream = true   // 必须同时改 payload, 否则上游返回的是非流式 JSON
  }
  let r
  try { r = await attemptChain(payload.model, payload, ctx) }
  catch (e) {
    // 同 handleChat: 客户端断开记 abort, 别算成模型失败
    if (req.__aborted) { recordMetrics('abort', Date.now() - ctx.t0, 0, 0, 0, null); return }
    recordMetrics(false, Date.now() - ctx.t0, 0, 0, 0, null); return nativeError(res, protocol, e, ctx)
  }
  const up = r.up
  hookClientAbort(res, up, r.provider && r.provider.name, r.model, ctx)
  setSourceHeaders(res, r)
  const sse = (up.headers['content-type'] || '').includes('event-stream')
  if (isStream && sse) {
    // ⚠ 这四个管道函数没接"完成回调", 所以这里只能在**交接时**记一次成功。
    // 若上游中途断流, usage_log 里仍会留下失败记录(见 attemptChain 的 up.once('end')),
    // 只是不体现在小时聚合里 —— 这个取舍是刻意的: 流式热路径已经出过三次事故,
    // 不为了一张图表再往里塞回调。
    recordMetrics(true, Date.now() - ctx.t0, up.__ttfb, 0, 0, r.provider && r.provider.name)
    if (protocol === 'anthropic') return pipeOpenAISSEasAnthropic(up, res, r.model)
    if (protocol === 'responses') return pipeOpenAISSEasResponses(up, res, r.model)
    if (protocol === 'gemini') return pipeOpenAISSEasGemini(up, res)
    return pipeOpenAISSEasOllama(up, res, r.model, kind)
  }
  // 非流式正文已在 attemptChain 里读过并校验(见 chatBodyProblem), 这里直接用;
  // 兜底再读一次是为了兼容"正文没被预读"的情况(读到空串也不会出错)。
  const text = (up.__body !== undefined) ? up.__body : await readBody(up, 4 * 1024 * 1024)
  let obj
  try { obj = JSON.parse(text) } catch { recordMetrics(false, Date.now() - ctx.t0, up.__ttfb, 0, 0, r.provider && r.provider.name); return nativeError(res, protocol, Object.assign(new Error('上游返回非 JSON'), { status: 502 }), ctx) }
  STATS.tokens += (obj.usage && obj.usage.total_tokens) || countTokensFromJSON(text)
  recordMetrics(true, Date.now() - ctx.t0, up.__ttfb, (obj.usage && obj.usage.prompt_tokens) || 0, (obj.usage && obj.usage.completion_tokens) || 0, r.provider && r.provider.name)
  if (protocol === 'anthropic') return json(res, 200, openAIToAnthropic(obj, r.model))
  if (protocol === 'responses') return json(res, 200, openAIToResponses(obj, r.model))
  if (protocol === 'gemini') return json(res, 200, openAIToGemini(obj))
  return json(res, 200, openAIToOllama(obj, r.model, kind))
}

// ---------------- /v1/chat/completions ----------------
// payload 清洗: 各家严格厂商(Mistral/Cerebras 实测)会对消息里的非标准字段直接 422/400 拒收
// (WorkBuddy 等客户端常带 agent/cache_control 等私有字段)。转发前把 message 归一到 OpenAI 标准字段。
function sanitizePayload(payload) {
  if (!payload || typeof payload !== 'object') return payload
  const MSG_KEYS = new Set(['role', 'content', 'name', 'tool_calls', 'tool_call_id', 'function_call'])
  if (Array.isArray(payload.messages)) {
    payload.messages = payload.messages.map((m) => {
      if (!m || typeof m !== 'object') return m
      const o = {}
      for (const [k, v] of Object.entries(m)) if (MSG_KEYS.has(k)) o[k] = v
      // 新版 OpenAI SDK 用 role:"developer" 表达系统提示(旧版是 "system")。不归一的话,
      // 免费池里绝大多数上游只认 system/user/assistant/tool —— 要么直接 400, 要么把这条
      // 系统提示当未知角色静默丢掉。后者更糟: 请求"成功"了, 模型却没收到任何指令,
      // 用户只看到"这模型怎么不听话", 完全查不出原因。
      if (o.role === 'developer') o.role = 'system'
      // content 若是数组(多模态), 清理每个 part 的私有字段
      if (Array.isArray(o.content)) o.content = o.content.map((c) => (c && typeof c === 'object' ? (({ type, text, image_url }) => ({ ...(type && { type }), ...(text && { text }), ...(image_url && { image_url }) }))(c) : c))
      return o
    })
  }
  // 顶层非标准字段(如 WorkBuddy 的 prompt_cache_key 等)对上游无意义, 但多数厂商容忍; 只删已知惹事的
  for (const k of ['agent', 'metadata', 'user', 'prompt_cache_key']) delete payload[k]
  return payload
}

// 链式执行核心: 沿候选链逐个尝试直到成功。所有入口格式(OpenAI/Anthropic/Gemini/Ollama)
// 都先归一为 OpenAI payload 再走这里, 保证路由/冷却/统计/粘性会话只有一套逻辑。
// ── 对冲请求(hedge): 领跑候选迟迟不吐头时, 并行开下一家, 谁先成功用谁 ──
// 为什么需要: 非流式请求要等整段生成完上游才发响应头, 所以 forward 的 headMs(45s) 实际上
// 就等于"总时长上限" —— 不能靠收紧它来提速, 否则会把"慢但正常"的长回答直接截断。
// 而实测(AMD TTFB 飙到 55s)表明, 一家突然变慢会让用户干等几十秒。对冲把最坏情况从
// "等领跑者彻底失败"压缩到"等 HEDGE_MS 后换人", 用户侧基本无感。
// 保守约束:
//   · 最多并行 2 个, 避免把免费额度瞬间打满;
//   · 只在链上还有别家时才对冲, 且落败方一律销毁, 不产生下游输出、不计入成败统计;
//   · 领跑者"已知很快"时不对冲 —— 它马上就回来了, 白开一条纯属浪费额度。
const HEDGE_MS = 3000        // 默认对冲窗口: 领跑者 3s 还没吐响应头 -> 并行开下一家
const HEDGE_MAX = 2          // 最多同时 2 个候选在飞
const HEDGE_FAST_MS = 1500   // "已知很快"的判定阈值
const HEDGE_MIN_MS = 1200    // 已确知领跑者很慢时, 提前到这个窗口并行, 别白等满 3s
const SLOW_LEAD_MS = 6000    // 平均延迟超过它 = 确知很慢

// ── 首字节超时: "有退路才敢早放弃" ──
// 背景(2026-10-23 实测 usage_log): 11 次失败是"上游 15s 内未返回响应头" —— 每次白等满 15 秒。
// 15 秒是个**兜底值**, 对交互式网关偏长; 但直接调小会把"慢但活着"的模型误杀成失败, 更糟。
// 判据只用一个信号: 这个模型**自己的**实测 TTFB(modelLat, 模型级而非供应商级 ——
//   同家模型速度能差一个数量级)。常态 200ms 的模型等它 15 秒, 等于等 75 倍。
// 两道安全阀:
//   ① **只在链上还有没试过的候选时才收紧**。它是最后一个候选时保持 15 秒 ——
//      早放弃只会把"慢一点但能答"变成"报错", 而没有任何人接手。
//   ② 下限 6 秒、且至少 3 个样本才启用。宁可多等几秒, 也不要因为一次网络抖动就误杀。
const HEAD_TIMEOUT_MS = 15000
const HEAD_TIMEOUT_MIN_MS = 6000
const HEAD_SLOW_FACTOR = 5      // 超过自己常态的 5 倍 = 这次真的不对劲
const HEAD_SAMPLE_MIN = 3       // 样本不足不启用(单次采样不能定生死)
function adaptiveHeadMs(p, modelId, hasFallback) {
  if (!hasFallback) return HEAD_TIMEOUT_MS
  const n = (modelId && p.modelLatN && p.modelLatN[modelId]) || 0
  const ms = (modelId && p.modelLat && p.modelLat[modelId]) || 0
  if (n < HEAD_SAMPLE_MIN || !ms) return HEAD_TIMEOUT_MS
  return Math.min(HEAD_TIMEOUT_MS, Math.max(HEAD_TIMEOUT_MIN_MS, Math.round(ms * HEAD_SLOW_FACTOR)))
}

// ── 限流兜底: 全链都栽在"限流"上时, 等一小会儿重排一次 ──
// 免费池最难受的时刻不是"某家限流"(换一家就行), 而是**全池同时限流** —— 客户端直接看到 502。
// 而这类失败里有很大一部分是"再等 2 秒就好了": RPM 窗口是滑动的, 上游回的 `Retry-After`
// 通常只有 1~10 秒。markFail 已经把 `Retry-After` 记进 modelCooldown 了(见那里的说明),
// 所以"还要等多久"是一个**已知量**, 不必猜。
//
// ⚠ 判据刻意保守(四道闸门全过才等), 因为多等几秒是用户可感知的代价:
//   ① 只等 **≤5 秒** 的; 没给 `Retry-After` 时 markFail 默认 90 秒冷却, 天然被排除 ——
//      这条同时挡住了"日额度用完"(冷却到明天)和"网络不通"(不设 modelCooldown);
//   ② **链上每个候选**都必须在窗口内恢复(只要有一个还得等很久, 等这一轮就没意义);
//   ③ 只重试 **一次**, 且重试期间客户端断开立刻放弃;
//   ④ 流式请求也适用 —— 重试发生在"还没拿到上游响应头"时, 响应头一个字节都还没发出去。
// 开关: `config.json` 里 `"retryOnRateLimit": false` 可整条关掉。
const RETRY_WAIT_MAX = 5000


// 领跑者是否"已知很快"(据此跳过对冲)。
// ⚠ 判据必须**两个信号同时成立**: 最近一次实测快(recency) **且** 平均延迟也不慢(aggregate)。
// 只看 lastTtfb 会被一次侥幸的快响应骗过去 —— 之后它卡住时用户就要干等满 45s, 而没人对冲。
// 这也是"单次采样不能定生死"的同一原则: 一个样本可以影响判断, 但不足以单独决定。
//
// ⚠ 2026-10-04: 改为**模型级优先**(与排序里的 ttfbOf 完全同构)。
//   原实现读的是供应商级 lastTtfb/latency, 而排序早已模型级 —— 同一家内 gemini-flash-lite(2s)
//   和 gemini-3.8-flash(12s) 速度差一个数量级, 用供应商均值会把"实际上很慢的那个模型"判成快,
//   从而跳过对冲, 用户干等满 45s。反过来"同家有个快模型"也会让慢模型沾光被跳过对冲。
//   模型级样本不足时才退回供应商级 —— 与 speedSamples 的弱证据口径一致。
const knownFast = (p, modelId) => {
  const ml = (modelId && p.modelLat && p.modelLat[modelId]) || 0
  const mn = (modelId && p.modelLatN && p.modelLatN[modelId]) || 0
  // 有模型级样本 -> 只信它(供应商均值代表不了这个具体模型)
  if (mn >= 1 && ml > 0) return ml < HEDGE_FAST_MS
  const last = p.lastTtfb || 0, avg = p.latency || 0
  return last > 0 && last < HEDGE_FAST_MS && avg > 0 && avg < HEDGE_FAST_MS * 2
}
// 领跑者已经"确知很慢"时把对冲窗口提前 —— 等满 3 秒纯属浪费。
// 样本不足(少于 2 次)时**不提前**: 宁可多等 1.8 秒, 也不要因为一次网络抖动就每次白开一条并发
// (免费额度很贵, 而且多开的那家会真实消耗配额)。
// 同样模型级优先: 这家"平均值慢"不代表这个具体模型慢, 用供应商均值会让快模型被无谓地对冲。
const hedgeDelayFor = (p, modelId) => {
  const ml = (modelId && p.modelLat && p.modelLat[modelId]) || 0
  const mn = (modelId && p.modelLatN && p.modelLatN[modelId]) || 0
  if (mn >= 2 && ml > SLOW_LEAD_MS) return HEDGE_MIN_MS
  if (mn >= 2) return HEDGE_MS                    // 模型级样本够且不慢 -> 用默认窗口, 别被供应商均值带偏
  return ((p.latN || 0) >= 2 && (p.latency || 0) > SLOW_LEAD_MS) ? HEDGE_MIN_MS : HEDGE_MS
}

// 非流式响应体"可用吗" —— 返回空串表示可用, 否则返回一句人话说明问题。
// 为什么必须判:
//   上游回 200 不等于"答出来了"。过载/内部报错时回 200 + 空 body 并不罕见;
//   另外 readBody 有 4MB 上限且是**静默截断**(超限后继续消费但不再累积), 截断后的 JSON 必然解析失败。
//   原实现把这两种响应原样转发并记成功: 用户拿到空回答或半截 JSON, 仪表盘却一片绿 ——
//   与"Ollama done_reason 硬编码 stop"同一类错误: 状态是编的, 不是观察到的。
// 判定刻意宽松: 只要求"能解析出 choices[0]"。**不检查内容非空** ——
//   模型在 max_tokens 极小 / finish_reason=length 时返回空字符串是合法的, 那不是上游的错。
function chatBodyProblem(text) {
  if (!text || !text.trim()) return '响应体为空'
  let j
  try { j = JSON.parse(text) } catch { return '响应体不是合法 JSON（可能已被 4MB 上限截断）' }
  if (!j || typeof j !== 'object') return '响应体不是 JSON 对象'
  // 有些厂商用 200 + {error:{...}} 报错(而非 4xx/5xx), 这种必须换下一家
  if (j.error) return 'HTTP 200 但响应体是错误对象'
  if (!Array.isArray(j.choices) || !j.choices.length) return '响应体里没有 choices'
  return ''
}

// ── 流式首段体检：防"HTTP 200 + SSE 里塞 error"被当成成功 ──
// 为什么需要(实测 2026-10-05)：Kilo 转发的 Nvidia 过载, 回的是 **HTTP 200** 加一条 SSE：
//   data: {"choices":[],"error":{"code":503,"message":"Upstream error from Nvidia: Service temporarily overloaded"}}
// 非流式那条路有 chatBodyProblem() 兜底(它认得 200+{error}), 流式原来**完全不看正文** ——
// 于是这条错误流被原样透传给客户端(客户端直接报错), 而 usage_log 里记的是 ok:true / status:200,
// 仪表盘一片绿。网关存在的全部意义就是"这家不行自动换下一家", 所以这里必须补上。
//
// 判据(失败开放, 宁可放过也不误杀)：
//   读到**第一个可判定的 SSE 事件**就下结论 —— 是 error 就判失败、换下一家；
//   不是 error 立刻放行(绝不为了"再看一眼"拖慢首字节)。
//   超时/超上限还没读到 -> 放行, 由下游的空闲超时兜底(只损失一次体检, 不会挂死)。
const STREAM_PEEK_CAP = 8192   // 最多缓存 8KB
const STREAM_PEEK_MS = 3000    // 最多等 3s(首个事件正常几十~几百毫秒就到)
// 从已收到的 SSE 文本里判定：{error} -> 失败；非空 choices -> 正常；还没读到可判定的 -> null(继续等)
function peekVerdict(text) {
  if (!/\r?\n\r?\n/.test(text)) return null            // 还没有一个完整事件
  for (const ev of text.split(/\r?\n\r?\n/)) {
    for (const line of ev.split(/\r?\n/)) {
      const m = /^data:\s*(.+)$/.exec(line)
      if (!m) continue
      const raw = m[1].trim()
      if (!raw || raw === '[DONE]') continue
      let j
      try { j = JSON.parse(raw) } catch { continue }    // 半截 JSON = 还没收全, 继续等
      if (j && j.error) {
        const e = (typeof j.error === 'object') ? j.error : {}
        return { problem: String(e.message || '上游在流式响应里返回了错误'), code: Number(e.code || e.status || 0) || 0 }
      }
      if (j && Array.isArray(j.choices) && j.choices.length) return { ok: true }
    }
  }
  return null
}
// 读够"第一个可判定的 SSE 事件"再决定。返回值：
//   { ok:true, buffer }             -> 放行, buffer 是体检时读出来的字节(必须原样交回下游)
//   { problem, code }               -> 失败, 换下一家
function peekStreamHead(up, cap = STREAM_PEEK_CAP, ms = STREAM_PEEK_MS) {
  return new Promise((resolve) => {
    const chunks = []
    let size = 0, done = false
    const stop = () => { clearTimeout(timer); up.off('readable', onRead); up.off('end', onEnd); up.off('error', onErr) }
    const finish = (v) => { if (done) return; done = true; stop(); resolve(v) }
    const take = () => { let c; while ((c = up.read()) !== null) { chunks.push(c); size += c.length } }
    const buffer = () => Buffer.concat(chunks)
    const settle = () => {
      const v = peekVerdict(buffer().toString('utf8'))
      if (v) { finish(v.ok ? { ok: true, buffer: buffer() } : { problem: v.problem, code: v.code }); return true }
      return false
    }
    const onRead = () => { take(); if (size >= cap) { if (!settle()) finish({ ok: true, buffer: buffer() }) } else settle() }
    const onEnd = () => {
      take()
      if (settle()) return
      const text = buffer().toString('utf8')
      finish(text.trim() ? { ok: true, buffer: buffer() } : { problem: '上游流式响应为空', code: 0 })
    }
    const onErr = () => finish({ problem: '上游流式响应中断', code: 0 })
    const timer = setTimeout(() => { take(); if (!settle()) finish({ ok: true, buffer: buffer() }) }, ms)
    up.on('readable', onRead)
    up.once('end', onEnd)
    up.once('error', onErr)
    onRead()   // 数据可能已经到了, 不等事件先试一次
  })
}
// 把"体检时已读出来的首段"原样接回流里。
// 为什么不用 up.unshift()：首段可能已经是**整条流**(上游把全部内容塞进一个包就关连接) ——
// 那种情况下 unshift 会在流已 end 后调用, 而且下游 for-await 只会读到一条空流(客户端一个字都收不到)。
// 这里改成"先把首段写进 PassThrough, 再把上游剩余部分泵进去"：下游(OpenAI 的 for-await 与三个
// 协议转换 pipe)拿到的仍是一条完整流, 一个字节都不少。
// ⚠ 消费上游必须用 for-await(而不是 up.pipe) —— 与全项目其余流式路径同一套方式, 见 forward() 里
//   'readable' 保活的注释(2026-09-13 事故: readable 挂过之后再挂 'data' 不会恢复流动)。
// ── 流式中途报错检测 ──
// peekStreamHead 只体检**首段**。上游"先正常吐几个字、再发一条 error 事件"的流会在体检时通过,
// 之后那条错误被原样转发给客户端 —— 与"200 + 首段就是 error"是**同一个根因**, 只是发生在更晚的时刻:
// 客户端报错、而 usage_log 记成 ok:true(面板一片绿)。这里补上后半程的判定。
// 从 SSE 文本里认出 `data: {"error":...}`, 返回人话消息(没有则返回 '')。
// ⚠ 只在**累积文本里出现 `"error":` 这个 JSON 键**时才调用它(见 prependToStream) ——
//   不做逐块 JSON.parse, 那条热路径出过三次事故(见 forward 里 readable 保活的注释)。
function sseErrorEvent(text) {
  for (const ev of String(text).split(/\r?\n\r?\n/)) {
    for (const line of ev.split(/\r?\n/)) {
      const m = /^data:\s*(.+)$/.exec(line)
      if (!m) continue
      const raw = m[1].trim()
      if (!raw || raw === '[DONE]') continue
      let j
      try { j = JSON.parse(raw) } catch { continue }   // 半截 JSON = 还没收全, 下一块再看
      if (j && j.error) {
        const e = (typeof j.error === 'object') ? j.error : {}
        return String(e.message || '上游在流式中途返回了错误')
      }
    }
  }
  return ''
}

function prependToStream(up, head) {
  const pass = new PassThrough()
  // 下游要读的辅助字段必须一起搬过去(状态码 / 响应头 / 首字节耗时 / 可中止的上游请求对象)
  pass.statusCode = up.statusCode
  pass.headers = up.headers
  pass.__ttfb = up.__ttfb
  pass.__upReq = up.__upReq
  pass.__streamErrored = false
  pass.__streamErrMsg = ''          // 中流 error 事件的人话消息(非空 = 上游明确报错, 而不是客户端断开)
  if (head && head.length) pass.write(head)
  ;(async () => {
    // 保留最近 1KB 文本用于中流报错判定 —— 与 handleChat 里那个 tail 同口径, 只是这里覆盖全部协议
    // (OpenAI/Anthropic/Gemini/Ollama 都消费这一条 PassThrough, 所以判定放在这里只需写一次)。
    let tail = head ? head.toString('utf8') : ''
    try {
      for await (const c of up) {
        // 便宜的先做、重的后置: 只在累积文本里出现 JSON 的 error 键时才去精确解析。
        // ⚠ 必须判**累积文本**而不是单块 —— error 事件可能被 TCP 切在两个块之间(单块里看不出 error)。
        if (!pass.__streamErrored) {
          tail = (tail + c).slice(-1000)
          if (/"error"\s*:/.test(tail)) {
            const msg = sseErrorEvent(tail)
            if (msg) { pass.__streamErrored = true; pass.__streamErrMsg = msg }
          }
        }
        pass.write(c)
      }
    } catch { pass.__streamErrored = true }
    pass.end()
  })()
  return pass
}

// ctx = 本次 HTTP 请求的上下文 { id, kind, t0 }。它只用于**记录**(把链上每个候选的事件
// 归属到同一个请求 id), 不参与任何选路判断 —— 记录与决策必须解耦, 否则日志会变成"能改变
// 路由的输入", 一旦写错就同时污染两边。
async function attemptChain(model, payload, ctx) {
  payload = sanitizePayload(payload)
  // 本次请求是否要用工具 —— 只用于"上游拒收 tools 时把它记进 noTools"(见 markFail)。
  const wantsTools = payloadWantsTools(payload)
  // 本次请求是否带图片 —— 只用于"上游拒收图片时把它记进 noVision"(见 markFail)。
  const wantsVision = payloadWantsVision(payload)
  // 本次请求的规模 —— 只用于"上游回'请求太大'时把它记进 ctxLimit"(见 markFail)。
  // ⚠ 与 pickChain 里那个 reqChars 用**同一个函数**算, 两处口径必须一致: 记录时按 A 口径、
  //   跳过时按 B 口径, 就会出现"记了却从不跳过"或"跳过一个其实能用的"。
  // ⚠ 用 let: 上下文降级裁剪之后规模会变小, 之后记进 ctxLimit 的必须是**实际发出去的规模**,
  //   否则会记下一个比真实更大的数, 把该模型多挡掉一段(判据被自己的补救措施污染)。
  let reqChars = payloadChars(payload)
  // 别名解析(与 pickChain 内同一个函数、同样只解析一层, 幂等)。错误信息必须用**解析后的目标**,
  // 否则用户看到"模型 gpt-4o 不在池里"会一头雾水 —— 他明明把 gpt-4o 指到了 auto。
  const target = resolveAlias(model)
  const via = target !== model ? `（别名 ${model} → ${target}）` : ''
  // 目标是不是路由组 —— 只用于把"空链"的报错说清楚: 组空链几乎总是"成员名写错了/成员全被隔离了",
  // 而默认那句"不在任何已启用供应商的可用池里"会让用户以为整站挂了。
  const grp = resolveGroup(target)
  let chain = pickChain(model, payload)
  // ── 上下文降级: 全链都"实测吃不下这么大" ──
  // 走到这里说明: 池里每个候选都被自己的 ctxLimit 判过"这轮太大"。以前这是死路 ——
  // 硬跳过把它们全剔掉 -> 链空 -> 报"模型不在可用池里"(病因完全看不出来)。
  // 现在先按**最小的那个实测撞墙规模**裁一段历史再重排一次: 裁成功 = 请求能答;
  // 裁不动(裁完仍超 / tools 就占满了 / 没有实测数据)就保持原链去打 —— 最坏也只是原来那样。
  // ⚠ 只在"**全部**候选都嫌大"时裁: 只要链上还有一个能吃下的, 就该用那个, 不该擅自改用户的消息。
  let compactInfo = null
  if (chain.length && chain._ctxTight === chain.length) {
    const limits = chain.map((x) => modelCtxLimit(x.ref, x.model)).filter((n) => n > 0)
    const budget = limits.length ? Math.floor(Math.min(...limits) * COMPACT_RATIO) : 0
    const c = compactPayload(payload, budget)
    if (c) {
      payload = c.payload
      compactInfo = c
      reqChars = c.after
      chain = pickChain(model, payload)
      console.log(`[compact] ${ctx && ctx.id} 全链嫌大, 已裁至 ${c.before}→${c.after} 字符（丢 ${c.dropped} 条历史, 截断 ${c.truncated} 条）`)
    }
  }
  if (!chain.length) {
    STATS.fail++
    // "一家都没配" 和 "配了但这个模型用不了" 必须分开说: 混成同一句会让用户以为整站挂了,
    // 实际多半只是模型没勾选 / 被免费闸门隔离 / 名称不匹配。
    const hasProv = CFG.providers.some((p) => p.enabled !== false)
    const e = new Error(!hasProv ? '网关还没有可用的供应商, 请在仪表盘添加'
      : grp ? `路由组 ${target}${via} 的 ${grp.length} 个成员当前一个都不可用(${grp.join(', ')}) —— 检查成员名是否拼错、是否被免费闸门隔离或已下架`
      : `模型 ${target || 'auto'}${via} 当前不在任何已启用供应商的可用池里(可能未勾选、已被免费闸门隔离或名称不匹配)`)
    e.status = hasProv ? 404 : 503
    e.code = hasProv ? 'model_not_found' : 'no_providers_configured'
    throw e
  }
  const attempts = []
  let tried = 0
  let candNo = 0   // 候选序号: 同一次请求里第几个候选, 用来在日志里还原"回退了几次才成功"
  // 同一次请求内, 某家出现"超时/连不上"后跳过它剩下的模型 —— 实测(2026-09-17) AMD 三个模型
  // 各卡 15 秒才回退, 用户白等 45 秒; 这类错误基本是整家的问题, 不是单个模型的问题。
  // 只在"网络/超时"类错误时生效(上游返回 4xx/5xx 不触发, 那属于模型级问题), 且不影响跨请求行为。
  const skipProv = new Set()

  // 启动一个候选的一次尝试。resolve 三种形态:
  //   { ok:true, up, provider, model } | { fail:'原因' } | { skip:'原因' } (skip 可带 usage)
  const launch = (item) => {
    const p = item.ref
    const myCand = ++candNo
    const tCand = Date.now()
    // turns = 本次请求的预估轮次(决定 speed 的评分基准), 同一请求的所有候选共享。
    // 记进 usage_log 是为了事后能回答"当时按几轮的基准排的序" —— 动态基准到底有没有起作用,
    // 不能靠"感觉变快了"来判定, 必须能回溯。chain._turns 由 pickChain 在交错之后挂上。
    const EX = (more) => ctxExtra(ctx, { cand: myCand, ...(chain._turns ? { turns: chain._turns } : {}), ...(more || {}) })
    const st = { cancelled: false, up: null, req: null }
    // 落败方一律销毁: 它可能已经拿到响应头在等正文, 不销毁就白占着连接和上游额度。
    //
    // ⚠ 但必须区分**两种取消语义**, 混在一起会毁掉排序自愈:
    //   · soft(默认, 对冲落败): 只标记落败, 让这条请求跑到"拿到响应头"再自己销毁 ——
    //     那是"慢家"唯一的学习途径(见下面 recordLatency)。掐早了它就永远学不到"我慢",
    //     排序不会把它降下去, 于是**每次**请求都要为它白等一个对冲窗口。
    //   · hard(客户端已断开): 连在飞的请求一起掐。没人在等结果了, 再挂着纯属烧免费额度。
    // 注意 st.up 只在响应头到达后才有值, 所以 hard 必须能碰到 st.req(在飞的请求对象)。
    const cancel = (hard) => {
      st.cancelled = true
      if (st.up) { try { st.up.destroy() } catch {} }
      if (hard && st.req) { try { st.req.destroy() } catch {} }
    }
    // 客户端在"还没拿到上游响应头"时断开 —— 这是最常见的取消时刻(用户等不耐烦点了停止),
    // 而 hookClientAbort 要等拿到 up 才装得上, 那之前没人管这条上游请求: 额度照烧、日志留一条成功。
    // 这里把每个候选挂到请求级中止信号上, 客户端一走就整条链一起停(见 serveWithSlot 的注册处)。
    if (ctx && ctx.req) {
      if (ctx.req.__aborted) return { item, cancel, promise: Promise.resolve({ skip: `${p.name}/${item.model}: 客户端已断开，不再发起` }) }
      if (ctx.req.__abortHooks) ctx.req.__abortHooks.push(() => cancel(true))
    }
    if (skipProv.has(p.id)) return { item, cancel, promise: Promise.resolve({ skip: `${p.name}/${item.model}: 该家本轮已超时/连不上, 跳过` }) }
    const keys = providerKeys(p)
    // 免 Key(anon)厂商没有任何 Key 可用, 但**这不是"打不了"** —— 它恰恰靠"不带 Key"才能调通
    // (见 authHeaderFor)。所以这里必须放行(ki 用 -1 占位), 否则 OVH/Kilo 会被"无可用Key"整家 skip。
    const anon = isAnonProvider(p)
    const ki = anon ? -1 : (item.keyIdx >= 0 ? item.keyIdx : (keys.length ? 0 : -1)) // 兜底也试一把
    if (ki < 0 && !anon) return { item, cancel, promise: Promise.resolve({ skip: `${p.name}/${item.model}: 无可用Key`, usage: [p.name, item.model, false, keysAllDisabled(p) ? '该家的 API Key 全部被手动停用（在仪表盘 Keys 里重新启用）' : '该家的 API Key 全部在冷却中，稍等会自动恢复', EX()] }) }
    const out = { ...payload }
    out.model = item.model
    tried++
    if (tried > 1) STATS.fallbacks++
    rateTrack(p.id)
    // 首字节超时按"该模型实测 TTFB + 链上还有没有退路"收紧(见 adaptiveHeadMs)。
    // 放在 forward 之前算: 此刻 cursor 已经越过当前候选, cursor < chain.length 即"还有退路"。
    st.headMs = adaptiveHeadMs(p, item.model, cursor < chain.length)
    const promise = forward(p, out, 90000, keys[ki], st).then(async (up) => {
      st.up = up
      // 配额头采集(见 recordQuota 的说明)。放在**最前面**: 429 的响应头(remaining=0)
      // 恰恰是最有价值的一条, 放进成功分支会正好漏掉它; 对冲落败方也照记(多一个样本不是坏事)。
      recordQuota(p, up.headers)
      if (st.cancelled) {
        // 落败但确实"活着"(已经吐出响应头) —— 把它真实的 TTFB 记下来。
        // 否则它对冲每次都白开一条请求, 而自己永远学不到"我慢", 排序也不会把它降下去。
        // 只记延迟, 不记成败: 它没跑完, 不该算成功也不该算失败。
        recordLatency(p, up.__ttfb, item.model)
        try { up.destroy() } catch {}
        return { skip: `${p.name}/${item.model}: 已被更快的候选抢先（实测首字节 ${up.__ttfb}ms）` }
      }
      if (up.statusCode >= 300) {
        const text = await readBody(up)
        markFail(p, up.statusCode, item.model, up.statusCode === 429 ? parseRetryAfter(up) : 0, ki, text, { real: true, tools: wantsTools, vision: wantsVision, chars: reqChars })
        STATS.candidateFail++
        recordUsage(p.name, item.model, false, failReason(up.statusCode, text), EX({ status: up.statusCode, ttfb: up.__ttfb, ms: Date.now() - tCand }))
        return { fail: `${p.name}/${item.model}: HTTP ${up.statusCode} ${text.slice(0, 120)}` }
      }
      // ⚠ 非流式: 先把正文读出来验一遍, **再**决定算不算成功。
      //   上游 200 只说明"它回了话", 不说明"它答出来了" —— 空 body / 半截 JSON(被 4MB 上限
      //   静默截断) / 200 包着 error 体都见过。原实现在收到响应头时就 markOk + 记成功,
      //   于是这类响应被原样转发给用户, 面板上却是一片绿。现在不通过的直接换下一家(与 HTTP
      //   错误同一条 fail 通道), 真的一家都过不了就 502 —— 状态是观察到的, 不是编的。
      //   流式那条路径仍按原样: 正文由 handleChat 边收边转, 成功计数推迟到流结束(见下)。
      if (!payload.stream) {
        const text = await readBody(up, 4 * 1024 * 1024)
        const problem = chatBodyProblem(text)
        if (problem) {
          markFail(p, up.statusCode, item.model, 0, ki, text, { real: true, tools: wantsTools, vision: wantsVision, chars: reqChars })
          STATS.candidateFail++
          recordUsage(p.name, item.model, false, `上游响应不可用: ${problem}`, EX({ status: up.statusCode, ttfb: up.__ttfb, ms: Date.now() - tCand }))
          return { fail: `${p.name}/${item.model}: HTTP ${up.statusCode} 但${problem}` }
        }
        // 正文已消费, 交给 handleChat / serveNative 直接写回 —— 不能让它再读一次(流已读完只会得到空串)
        up.__body = text
      }
      // ⚠ 流式也要验首段, 而且必须在 markOk **之前** —— 否则"200 + 流里塞 error"会先被记成一次成功,
      //   那个模型在质量统计里反而加分(与"仪表盘一片绿、客户端却报错"同一个根因)。
      //   只对**真的是 SSE** 的响应体检: 请求流式但上游回了 200-JSON 的, 走上面非流式那条路。
      if (payload.stream && (up.headers['content-type'] || '').includes('event-stream')) {
        const head = await peekStreamHead(up)
        if (head.problem) {
          try { up.destroy() } catch {}
          const code = head.code || 503
          markFail(p, code, item.model, 0, ki, head.problem, { real: true, tools: wantsTools, vision: wantsVision, chars: reqChars })
          STATS.candidateFail++
          recordUsage(p.name, item.model, false, failReason(code, head.problem), EX({ status: code, ttfb: up.__ttfb, ms: Date.now() - tCand }))
          return { fail: `${p.name}/${item.model}: HTTP 200 但流式响应是错误: ${head.problem.slice(0, 100)}` }
        }
        // 体检读出来的字节必须原样交回下游, 否则客户端会丢掉回答的开头。
        // ⚠ **无条件包一层**(即使首段为空) —— 这层 PassThrough 还兼着"中流报错检测"(见 prependToStream)。
        //   漏包会让"首段正常、中途才报错"的流逃过判定, 又退化成"客户端报错、面板一片绿"。
        up = prependToStream(up, head.buffer)
      }
      markOk(p, item.model, ki, { real: true })
      recordLatency(p, up.__ttfb, item.model)
      // 粘性记到**模型**级: 同一对话尽量锁定同一个模型, 让上游的 prompt 前缀缓存能命中,
      // 也避免对话中途换模型导致风格/指令跟随跳变。兼容旧的纯 providerId 记录。
      if (chain._stickyHash) stickySet(chain._stickyHash, `${p.id}|${item.model}`)
      // 流式: 响应头 200 不代表客户端拿到了完整回答(中途卡死/断流都算失败)。
      // 成功计数推迟到流正常结束; 若之后仍收到上游错误(如空闲超时被销毁)则改判失败,
      // 修复"面板显示成功但用户没收到"的统计假象。
      if (payload.stream) {
        // ms 在这里是"整条流跑完"的耗时(而非首个响应头), 因为 end 事件就是流结束的时刻
        up.once('end', () => {
          const errMsg = up.__streamErrMsg || ''
          const ok = !up.__streamErrored
          if (ok) STATS.success++; else STATS.fail++
          recordUsage(p.name, item.model, ok, ok ? '' : (errMsg || '流式中断/空闲超时'), EX({ status: up.statusCode, ttfb: up.__ttfb, ms: Date.now() - tCand }))
          // 中流 error 事件 = 上游明确说"我错了" -> 冷却它, 下条请求别再撞同一个坑(与首段体检同一判据)。
          // ⚠ 只认**明确的 error 事件**(errMsg 非空), 不认通用的流中断: 后者可能是客户端点了停止造成的,
          //   把用户自己的操作算成"模型不行"会冤枉免费池里最慢的那几家(与 abort/fail 的口径一致)。
          if (errMsg) markFail(p, 503, item.model, 0, ki, errMsg, { real: true, tools: wantsTools, vision: wantsVision, chars: reqChars })
        })
        up.on('error', () => { up.__streamErrored = true })
      } else {
        STATS.success++
        recordUsage(p.name, item.model, true, '', EX({ status: up.statusCode, ttfb: up.__ttfb, ms: Date.now() - tCand }))
      }
      return { ok: true, up, provider: p, model: item.model }
    }).catch((e) => {
      // 被我们主动取消的候选不算它的错: 不记失败、不冷却、不拉黑 —— 否则对冲会"惩罚"无辜的供应商
      if (st.cancelled) return { skip: `${p.name}/${item.model}: 已被更快的候选抢先` }
      // 把错误正文带上: markFail 要用它判"是不是本机代理不通"(见 isProxyDown) ——
      // 不传的话那条分支永远进不去, 又变成"整家冷却 90 秒"。
      markFail(p, 0, item.model, 0, -1, e.message, { real: true, tools: wantsTools, vision: wantsVision, chars: reqChars })
      STATS.candidateFail++
      // 代理不通单独给一句人话: "连不上厂商（网络不通或代理没开）· connect ECONNREFUSED 127.0.0.1:10808"
      // 让用户要自己把两件事串起来才看得懂, 而修法只有一种 —— 把代理打开。
      const why = isProxyDown(p, 0, e.message)
        ? `本机代理连不上（${CFG.proxy}），先把代理打开再重试 · ${e.message}`
        : `${KIND_CN.network} · ${e.message}`
      recordUsage(p.name, item.model, false, why.slice(0, 200), EX({ status: 0, ms: Date.now() - tCand }))
      // 超时/连不上 -> 整家本轮不再试(见上方 skipProv 说明)
      if (/超时|卡死|timeout|ECONN|ENOTFOUND|socket|aborted|网络/i.test(String(e.message))) skipProv.add(p.id)
      return { fail: `${p.name}/${item.model}: ${e.message}` }
    })
    return { item, cancel, promise }
  }

  const inflight = []
  let cursor = 0
  const push = () => { if (cursor >= chain.length) return false; inflight.push(launch(chain[cursor++])); return true }

  // ── 限流兜底: 一轮跑完还是全败时, 判断"再等几秒有没有意义"(判据见 RETRY_WAIT_MAX) ──
  // 返回要等的毫秒数; 0 = 不值得等(直接按原样报错)。
  // ⚠ 要求**链上每个候选**都有冷却且都在窗口内恢复 —— 只要有一个还得等很久(日额度/网络),
  //   等这一轮就是纯浪费用户时间, 不如立刻把真实错误告诉他。
  const retryWaitMs = () => {
    if (CFG.retryOnRateLimit === false) return 0
    if (!chain.length) return 0
    const t = Date.now()
    let soonest = Infinity
    for (const x of chain) {
      const cd = (x.ref.modelCooldown && x.ref.modelCooldown[x.model]) || 0
      if (cd <= t) return 0                    // 没有限流冷却 -> 这次失败不是"等一会儿就好"
      const wait = cd - t
      if (wait > RETRY_WAIT_MAX) return 0      // 有一个要等太久 -> 整轮不值得等
      if (wait < soonest) soonest = wait
    }
    return Number.isFinite(soonest) ? Math.max(soonest, 300) : 0
  }
  // 可中断的等待: 客户端在等上游时断开, 必须立刻放弃(否则会白等满 5 秒再回一个没人要的错误)
  const waitAbortable = async (ms) => {
    const t0 = Date.now()
    while (Date.now() - t0 < ms) {
      if (ctx && ctx.req && ctx.req.__aborted) return true
      await new Promise((r) => setTimeout(r, 100))
    }
    return !!(ctx && ctx.req && ctx.req.__aborted)
  }

  // 最多两轮: 第 2 轮只可能是"限流兜底"(见下方), 不会无限重试。
  for (let round = 0; round < 2; round++) {
  cursor = 0
  inflight.length = 0
  skipProv.clear()      // 上一轮的"整家跳过"结论对重试那一轮不成立(它可能只是刚才限流)

  while (true) {
    // 客户端已断开: 不再开新候选, 并把在飞的都**硬掐**(hard) —— 结果没人要, 继续跑只是烧额度
    if (ctx && ctx.req && ctx.req.__aborted) { for (const h of inflight) h.cancel(true); break }
    if (!inflight.length && !push()) break
    const racers = inflight.map((h) => h.promise.then((r) => ({ r, h })))
    // 还能再开一家 && 领跑者不是"已知很快" -> 带对冲定时器赛跑
    const canHedge = inflight.length < HEDGE_MAX && cursor < chain.length && !knownFast(inflight[0].item.ref, inflight[0].item.model)
    let out
    if (canHedge) {
      let timer
      // 窗口自适应: 领跑者已确知很慢就提前并行(见 hedgeDelayFor), 否则用默认 3s
      const hedge = new Promise((res) => { timer = setTimeout(() => res({ hedge: true }), hedgeDelayFor(inflight[0].item.ref, inflight[0].item.model)) })
      out = await Promise.race([...racers, hedge])
      clearTimeout(timer)
    } else {
      out = await Promise.race(racers)
    }
    if (out.hedge) { push(); continue }        // 领跑者迟迟不吐头 -> 并行再加一家, 继续赛
    const { r, h } = out
    inflight.splice(inflight.indexOf(h), 1)    // 已结算, 移出跑道
    if (r.usage) recordUsage(r.usage[0], r.usage[1], r.usage[2], r.usage[3], r.usage[4])
    if (r.skip) { attempts.push(r.skip); continue }
    if (r.fail) { attempts.push(r.fail); continue }
    for (const x of inflight) x.cancel()       // 赢了: 取消所有还在飞的候选
    // target/alias/attempts 只用于**响应头**(告诉调用方这次实际走了谁、回退过几次),
    // 不参与任何路由判断 —— 与 ctx 同一条原则: 记录与决策解耦。
    // compacted: 本次是否为了塞进模型窗口裁过历史。交给 setSourceHeaders 下发成响应头 ——
    // 用户看到"模型怎么忘了我前面说的", 得能在响应里找到原因, 而不是去猜。
    return { up: r.up, provider: r.provider, model: r.model, chain, target, alias: target !== model ? model : null, group: grp ? target : null, attempts: attempts.length, compacted: compactInfo }
  }

  // 本轮全败。第 1 轮先问一句"再等几秒有没有意义"(见 retryWaitMs 的四道闸门);
  // 值得等就重排一次候选链再来一轮, 否则直接按原样报错。
  if (round === 0) {
    const wait = retryWaitMs()
    if (wait) {
      const secs = Math.round(wait / 100) / 10
      console.log(`[retry] ${ctx && ctx.id} 全链限流, ${secs}s 后重排一次（上游 Retry-After 给的就是这么短）`)
      const aborted = await waitAbortable(wait)
      if (!aborted) {
        // 冷却已到期 -> 重排后这些候选回到健康档。仍然走同一套 pickChain, 不另写一套调度。
        chain = pickChain(model, payload)
        if (chain.length) continue
      }
    }
  }
  break
  }   // for (round)

  STATS.fail++
  // 注意: Math.min(...[]) = Infinity 且 Infinity 是 truthy, || 0 兜不住 —— 会让
  // new Date(Infinity).toISOString() 抛 RangeError, 502 错误响应反而发不出去(客户端干等)。
  const futureCds = chain.map((x) => x.ref.cooldownUntil || 0).filter((t) => t > Date.now())
  const retryAt = futureCds.length ? Math.min(...futureCds) : 0
  const e = new Error(`链上 ${chain.length} 个候选全部失败`)
  e.status = 502; e.code = 'all_upstream_failed'; e.attempts = attempts; e.retryAt = retryAt
  throw e
}

// ── 并发合并(coalesce): 同一个请求正在飞的时候, 再来一个一模一样的, 就等它, 不重复打上游 ──
// 为什么值得做: 免费池的瓶颈是配额(RPM/RPD), 不是钱。agent 客户端重试、用户连点、多个客户端
// 同时问同一句 —— 这些**完全相同**的请求并发打出去, 每一发都真实消耗一次额度, 而答案本该一样。
//
// 边界(每一条都是"不做就会出问题"):
//   ① **只合并非流式**。流式要把一条上游流 tee 给多个 res, 而流式热路径在本项目历史上出过三次
//      事故(挂死 / 保活挂错响应 / 未定义常量)。省配额不值得拿它冒险 —— 非流式的正文在
//      attemptChain 里已经读完了, 复制的成本几乎为零。
//   ② **key 必须覆盖整个 payload**(稳定序列化后 sha1), 不能用 stickyHash 那种"取前 200 字符"的
//      粗哈希 —— 那会把"同一句话但换了模型/温度/工具"的请求错并成一个, 是**给出错误答案**级别的 bug。
//   ③ 合并的那次**失败时自己重跑一遍**。别人的失败不该连坐: 同样的请求它自己走一遍路由,
//      可能选到另一家就成功了(顶多多花一次配额, 正确性优先)。
//   ④ 每个等待者拿到的是**独立的响应流副本**, 不共享可读流 —— 共享的话第一个消费者读空,
//      第二个就永远等不到数据(这类 bug 表现为"偶发空白回答", 极难查)。
// 开关: `config.json` 里 `"coalesce": false` 可整条关掉。
const COALESCE_INFLIGHT = new Map()
const COALESCE_MAX = 64          // 兜底上限: 正常情况下 Map 里只有"正在飞的那几个"

function payloadKey(payload) {
  try {
    // 稳定序列化: 递归按 key 排序。同一个请求换个字段顺序不该算出两个 key —— 那会让合并永远不命中。
    const norm = (v) => {
      if (Array.isArray(v)) return v.map(norm)
      if (v && typeof v === 'object') {
        const o = {}
        for (const k of Object.keys(v).sort()) o[k] = norm(v[k])
        return o
      }
      return v
    }
    return crypto.createHash('sha1').update(JSON.stringify(norm(payload))).digest('hex')
  } catch { return null }
}

// 造一份独立的响应流副本。非流式时正文已在 up.__body 里(attemptChain 读完并校验过),
// 所以这里不需要 tee —— 直接把那段字符串重新灌进一个新的 PassThrough。
function cloneUp(up) {
  const s = new PassThrough()
  s.statusCode = up.statusCode
  s.headers = up.headers
  s.__ttfb = up.__ttfb
  s.__body = up.__body
  s.end(up.__body === undefined ? '' : up.__body)
  return s
}

async function coalesceRun(key, fn) {
  if (!key || CFG.coalesce === false) return fn()
  const hit = COALESCE_INFLIGHT.get(key)
  if (hit) {
    try {
      const r = await hit
      // ⚠ 正文必须**确实已经读完**才能复用。正常路径下非流式的 __body 一定存在
      //   （attemptChain 在返回前就读完并校验过），但"复用别人的结果"是一条新路径，
      //   而它一旦拿到 undefined，下游就会给客户端一个**空回答**——那种 bug 表现为
      //   "偶发空白"，极难查。宁可多一次判断：拿不到正文就自己重跑一遍（多花一次配额，
      //   但绝不给出空白回答）。
      if (!r || !r.up || r.up.__body === undefined) return fn()
      STATS.coalesced = (STATS.coalesced || 0) + 1
      return { ...r, up: cloneUp(r.up), coalesced: true }
    } catch {
      // 合并的那次失败了 -> 自己老老实实走一遍(见上面边界③)
      return fn()
    }
  }
  if (COALESCE_INFLIGHT.size >= COALESCE_MAX) return fn()   // 兜底: 异常堆积时不影响正常服务
  const p = fn()
  COALESCE_INFLIGHT.set(key, p)
  try { return await p } finally { COALESCE_INFLIGHT.delete(key) }
}

async function handleChat(req, res, user, bodyStr) {
  // 复用最外层生成的 id（见 createServer 顶部注释），别再生成一个 —— 否则响应头与日志对不上
  const ctx = { id: req.__rid || newReqId(), kind: 'openai', t0: Date.now(), req }
  try { res.setHeader('x-request-id', ctx.id) } catch {}
  let payload
  try { payload = JSON.parse(bodyStr) }
  catch { return json(res, 400, { error: { message: 'invalid json', request_id: ctx.id } }) }

  const model = payload.model || 'auto'
  const t0 = Date.now()   // 用于估算输出耗时(= 总耗时 - 首字节延迟) -> 学输出吞吐
  STATS.requests++
  let r
  try {
    // 非流式才合并（见 coalesceRun 的边界①）；流式走原路径，一个字节都不变。
    // ⚠ key 用**归一化之前的** payload 算：两个客户端若连私有字段都一样，才算"同一个请求"。
    r = payload.stream
      ? await attemptChain(model, payload, ctx)
      : await coalesceRun(payloadKey(payload), () => attemptChain(model, payload, ctx))
  }
  catch (e) {
    // 客户端在等上游时断开 -> 记 abort, 不是失败。否则"用户点了停止"会被算进模型成功率,
    // 免费池里最慢的那几家会被反复冤枉(与流式路径的 abort/fail 口径保持一致)。
    if (req.__aborted) { recordMetrics('abort', Date.now() - ctx.t0, 0, 0, 0, null); return }
    // 请求体解析失败/鉴权失败这类"没走到模型"的情况不记 metrics —— 指标的口径是
    // "模型调用", 把客户端自己的错算进去会让成功率莫名其妙地掉。
    recordMetrics(false, Date.now() - ctx.t0, 0, 0, 0, null)
    return json(res, e.status || 502, { error: { code: e.code || 'upstream_error', message: e.message, request_id: ctx.id, retry_at: e.retryAt ? new Date(e.retryAt).toISOString() : undefined, attempts: e.attempts } })
  }
  const up = r.up
  const pname = r.provider && r.provider.name
  hookClientAbort(res, up, pname, r.model, ctx)
  setSourceHeaders(res, r)
  const headers = {}
  for (const [k, v] of Object.entries(up.headers)) {
    if (['content-type', 'cache-control'].includes(k)) headers[k] = v
  }
  res.writeHead(up.statusCode, headers)
  const isSSE = (up.headers['content-type'] || '').includes('event-stream')
  if (isSSE) {
    // 教训(2026-09-13): forward 里用 'readable' 保活后, 这里再挂 'data' 并不会让流恢复流动
    // (Node 的 readable 事件一旦触发过, 后挂 data 监听器可能永远收不到数据) —— 结果 OpenAI
    // 协议的流式请求全部挂死超时, 而 Anthropic/Gemini/Ollama 分支因为用 for-await 消费所以正常。
    // 统一改为 for-await: 按序拉取, 与其余三个协议分支同一套消费方式。
    let tail = ''
    ;(async () => {
      let broke = false
      try {
        for await (const c of up) {
          tail = (tail + c).slice(-4000)
          res.write(c)
        }
      } catch (e) {
        broke = true
        // 以前这里是 catch {} —— 下游写失败(客户端已断开)被完全吞掉, 无日志无统计。
        STATS.streamAbort = (STATS.streamAbort || 0) + 1
        console.warn('[stream] 转发中断:', (e && e.message) || e)
      }
      const n = countTokensFromSSE(tail)
      STATS.tokens += n
      // 吞吐采样: 只在流里真的带了 usage 时才记。
      // ⚠ 刻意**不在流式热路径上加逐块解析** —— 这条路径历史上出过三次事故
      // (readable/data 混用挂死、保活挂到错误响应、未定义常量打死进程), 不值得为一个
      // 排序权重去动它。非流式请求的 usage 是精确值, 已足够喂饱吞吐学习。
      recordThroughput(r.provider, countCompletionFromSSE(tail), Date.now() - t0 - (up.__ttfb || 0), r.model)
      // 指标口径: 用户点了停止 / 关掉页面导致的中断记 abort(不是模型的错, 不能算进失败率);
      // 客户端还在、流却断了 = 真失败(上游断流)。这两者混为一谈会让"成功率"失去意义。
      const clientGone = !!res.__clientGone || res.destroyed
      const outcome = clientGone ? 'abort' : (!broke && !up.__streamErrored)
      recordMetrics(outcome, Date.now() - ctx.t0, up.__ttfb, 0, countCompletionFromSSE(tail), pname)
      if (!res.destroyed) res.end()
    })()
  } else {
    // 非流式正文已在 attemptChain 里读过并校验(见 chatBodyProblem), 这里直接用
    const text = (up.__body !== undefined) ? up.__body : await readBody(up, 4 * 1024 * 1024)
    const n = countTokensFromJSON(text)
    // 合并来的结果**没有真的消耗上游 token**, 也不能再采一次吞吐:
    // 同一个响应采样两次会把 EMA 往"这一次的速度"上多拉一遍, 而 EMA 的更新权重只有 0.4,
    // 被重复采样污染后要好几轮才冲掉(与 recordThroughput 那段注释同一条理由)。
    if (!r.coalesced) STATS.tokens += n
    // 非流式: usage.completion_tokens 是上游给的精确值 —— 注意不能拿 countTokensFromJSON 的
    // total_tokens 去算吞吐, 它含 prompt, 会把"输入很长"误判成"输出很快"。取不到就放弃这次采样,
    // 不猜(猜出来的数字会污染 EMA, 而 EMA 只有 0.4 的更新权重, 污染后要好几轮才冲掉)。
    let comp = 0, ptok = 0
    try { const u = JSON.parse(text).usage || {}; comp = u.completion_tokens || 0; ptok = u.prompt_tokens || 0 } catch {}
    if (!r.coalesced) recordThroughput(r.provider, comp, Date.now() - t0 - (up.__ttfb || 0), r.model)
    recordMetrics(!res.__clientGone, Date.now() - ctx.t0, up.__ttfb, ptok, comp, pname)
    if (!res.destroyed) res.end(text)
  }
}

// ---------------- 工具 ----------------
// ⚠ 必须对"响应已经结束/连接已断"保持沉默: 客户端在等上游时断开后, 上层仍可能走到这里
// 试图回一个 502 —— 对一个已销毁的 socket 调 writeHead 会抛异常, 而它发生在 catch 块里,
// 会直接变成 unhandledRejection。写不出去就什么都不做, 这是唯一正确的处理。
function json(res, status, obj) {
  if (res.writableEnded || res.destroyed) return
  const s = JSON.stringify(obj)
  try { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }); res.end(s) } catch {}
}
function safeEqual(a, b) {
  const ba = Buffer.from(a), bb = Buffer.from(b)
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb)
}
function authed(req) {
  const h = req.headers.authorization || ''
  const key = h.replace(/^Bearer\s+/i, '').trim() || (req.headers['x-gateway-key'] || '')
  return key && safeEqual(key, CFG.gatewayKey)
}

// ---------------- 管理 API ----------------
async function handleAdmin(req, res, url, bodyStr) {
  const seg = url.pathname.split('/').filter(Boolean) // ['api', ...]
  if (url.pathname === '/api/state' && req.method === 'GET') {
    // 供应商展开体里的成败数（2026-09-26 修）：原来直接用 p.ok / p.err —— 那是**全期累计**
    // （写进 config.json、跨重启保留），而用户点开卡片问的是"这家**现在**怎么样"。
    // 实测这份日志里两个方向都会骗人：openrouter 累计 281/45（看着优秀），最近 50 条却是 21/29；
    // 反过来 gemini 累计 13/75 看着惨，近 7 天也确实是 1/26。**"最近 50 条"也不够** ——
    // 某家很久没调用时，那 50 条全是几天前的老数据。所以按**时间窗口**算，不用条数。
    // ⚠ 刻意不落盘、不给 provider 加持久化字段 —— config.json 一个字节不动，也就不必同步改
    //   sb-util.cjs 的 VOLATILE_KEYS（"新增运行时会自己写的字段"必踩的那个坑）。
    // 成本：usageRecords 上限 2000 条，全量遍历 + Date.parse 实测 < 1ms，/api/state 承受得起。
    const RECENT_MS = 7 * 24 * 3600 * 1000
    const recentCutoff = Date.now() - RECENT_MS
    const recentByProv = {}
    for (const r of usageRecords) {
      const t = Date.parse(r.at)
      // 不用 break：记录理论上最新在前，但一旦有时间乱序的脏数据，break 会静默漏统计。
      if (!(t >= recentCutoff)) continue
      const a = recentByProv[r.provider] || (recentByProv[r.provider] = { ok: 0, err: 0, n: 0 })
      a.n++
      if (r.ok) a.ok++; else a.err++
    }
    // 代理可达性: 走代理的清单源失败时, 仪表盘要能说清"是源挂了还是代理没开"。
    // 60s 缓存, 所以这个 await 每 60 秒才真的做一次 TCP 探测。
    const proxyState = await probeProxyAlive()
    const STATE = {
      // ⚠ 这里以前回传明文 CFG.gatewayKey, 而 GET 是免鉴权的 —— 本机任何脚本/浏览器扩展
      // 都能取到 Key, 进而调用全部写接口(改 Key、解除扣费拉黑)。现在只回掩码;
      // 仪表盘自己需要完整 Key 时, 由服务端在返回 dashboard.html 时注入 window.__GK__。
      gatewayKey: maskKey(CFG.gatewayKey),
      // 配置损坏/从备份恢复的告警, 由仪表盘显示成常驻红色提示条
      configRecovered: CONFIG_RECOVERED,
      port: CFG.port,
      // 手工把 config.json 里的 port 改了、但还没重启 —— 仪表盘据此提示"重启后生效"。
      // 不给这个字段的话, 用户改完端口发现"什么都没变", 会以为是自己改错了。
      portPending: CFG_PORT_PENDING || 0,
      proxy: CFG.proxy,
      proxyAlive: proxyState,
      // 当前管理接口鉴权模式(local = 本机即可信, token = 需要 x-admin-token)。只回模式不回令牌。
      // 报的是**实际生效**值; authTokenMisconfigured 用于让仪表盘把"配了但没生效"显式提示出来。
      authMode: effectiveAuthMode(),
      authTokenMisconfigured: !!(CFG.auth && CFG.auth.mode === 'token' && effectiveAuthMode() !== 'token'),
      maxConcurrent: Number(CFG.maxConcurrent) || 0,
      ruleset: {
        ...RULESET,
        whitelist: (() => {
          const w = loadWhitelist()
          if (!w) return null
          const hs = w.hosts || {}
          return {
            fetched_at: w.fetched_at,
            list_date: w.list_date,
            sources: w.sources || null,
            hosts: Object.keys(hs).length,
            // 免 Key 实测可调用的家数。这批是"巡检无 Key 真调通过、且没有账号所以没有扣费通道"的,
            // 与"源声称免费"不是一个可信度等级, 仪表盘要能分开说。
            anonHosts: Object.values(hs).filter((v) => v && v.anon).length,
            // 供仪表盘展示"白名单里有、但还没接入的免费厂商" —— 名单每天自动更新,
            // 自动抓到的新厂商会自己出现在这里, 用户不必去别处找
            hostList: Object.entries(hs).map(([h, v]) => ({ host: h, source: v.source || h, models: (v.models || []).length, anon: !!v.anon, anonModel: v.anonModel || '' })),
            // 发现源捞到但**未收录**的候选(未实测, 按用户要求不进正式名单/不污染主列表)。
            // ⚠ 2026-09-21 改成**回名单**而不再只回计数: 用户原话"我不信每次都是那18家,
            //   总有新的大厂给到免费模型, 比如阶跃星辰"。只回计数等于"发现能力在跑但用户看不见",
            //   感受就是"名单固死了"。现在挂到仪表盘的独立折叠区, 由用户自己决定要不要接入 ——
            //   既不污染主列表(仍是独立区块、默认收起), 又让"新厂商"这件事变得可见可选。
            // ⚠ 口径必须与 candidateList 完全一致(都是 models > 0)。否则 meta 行写"候选 48 家可查"、
            //   下面面板只列 47 行, 用户一眼就看出对不上 —— 这种"两个数字不一致"最伤信任,
            //   而它恰恰是用户来问"其他厂商信子准吗"的动机。宁可少报一个, 也不能对不上。
            candidates: Object.values(w.candidates || {}).filter((v) => ((v && v.models) || []).length > 0).length,
            candidateList: Object.entries(w.candidates || {})
              // 0 个模型的候选不进列表: 它所有模型都被 DENY_FREE/NON_CHAT_RE 筛掉了,
              // 列出来只是一行"0 个免费"的噪音(与 hostList 的 h.models > 0 同一口径)。
              .filter(([, v]) => (v.models || []).length > 0)
              .map(([h, v]) => candidateBrief(h, v, w.probe))
              // 排序: 有中文名的(已知大厂)在前 -> **实测状态**(能匿名列模型的证据最强) ->
              //       可疑的沉底 -> 模型数降序。
              // 用户要先看到"阶跃/腾讯/火山", 而不是一堆 `api.xyz.ai` 裸域名或 52 个可疑模型;
              // 但同样眼熟的厂商之间, "真测过"的应该排在"只是抄来的"前面。
              .sort((a, b) => (b.label ? 1 : 0) - (a.label ? 1 : 0)
                || probeRank(a) - probeRank(b)
                || (a.suspect ? 1 : 0) - (b.suspect ? 1 : 0)
                || b.models - a.models
                || a.host.localeCompare(b.host)),
            // 各数据源的新鲜度：让用户看清"名单到底刷没刷到新东西"，否则会以为是网关没在刷新。
            // ⚠ 2026-09-25 移除了 mnfst 源（自 2026-08-21 停更）—— 它曾是"厂商行数长期不变"的
            //   结构性原因；现在新鲜度由 freellm（每日实测）承担，见 WHITELIST_SOURCES 顶部注释。
            sourceAge: (() => {
              const src = w.sources || {}
              const now = Date.now()
              return Object.entries(src).map(([id, v]) => {
                const isDate = /^\d{4}-\d{2}-\d{2}$/.test(String(v))
                const days = isDate ? Math.floor((now - new Date(v + 'T00:00:00Z').getTime()) / 86400000) : null
                return { id, value: v, live: v === '实时', days, stale: days != null && days >= 7 }
              })
            })(),
          }
        })(),
      },
      // 厂商列表**每次请求都由当前白名单重新推导**（computePresets），所以名单本身就是每天最新的：
      // 新厂商自动出现、无免费层的自动归到 paid 分组，不存在写死的清单。
      // 手工改过 config.json 时，热重载合并了什么（2026-10-17）。只在本次进程内有效。
      configDrift: CFG_DRIFT,
      presets: computePresets(),
      providers: CFG.providers.map((p) => ({
        ...p,
        // 最近 7 天的成败（口径同「模型使用记录」的卡头）。没记录时是 null，前端退回累计。
        recent: recentByProv[p.name] || null,
        api_key: maskKey(p.api_key),
        // keys[] 只回传数量与掩码串, 绝不外泄明文
        keys: undefined,
        keyCount: (Array.isArray(p.keys) && p.keys.length) ? p.keys.length : (p.api_key ? 1 : 0),
        // 该家免费判定来源: closed=每日封闭白名单(最准) / open=免费plan视野放行 / heuristic=兜底规则
        freePolicy: (() => { const w = whitelistFor(p); return w ? (w.openFree ? 'open' : 'closed') : 'heuristic' })(),
        freeListCount: (() => { const w = whitelistFor(p); return w && !w.openFree ? w.models.length : 0 })(),
      })),
    }
    // ── 静态大块按内容哈希下发 ──
    // 实测: /api/state 53KB 里 ruleset(19.8KB) + presets(14.6KB) 占 65%, 而这两块**几乎从不变化**
    // (白名单每天同步一次, 预设随白名单走)。仪表盘每 8 秒轮询一次, 等于反复搬运同一份 34KB 且
    // 服务端每次都要重新 computePresets()。
    // 做法: 算这两块的 sha1 作为版本号; 前端带上它手里的版本(?v=), 一致时**不回这两块**, 前端用缓存。
    // ⚠ 不带 v(旧页面 / 直接 curl) 时照旧全量回 —— 兼容性优先, 且便于排查。
    // 前端可能分两次拿到(先全量、后增量), 所以 ruleset 与 presets 各自独立判版本更稳
    const rV = crypto.createHash('sha1').update(JSON.stringify(STATE.ruleset)).digest('hex').slice(0, 16)
    const pV = crypto.createHash('sha1').update(JSON.stringify(STATE.presets)).digest('hex').slice(0, 16)
    const wantR = url.searchParams.get('rv') || ''
    const wantP = url.searchParams.get('pv') || ''
    const out = { ...STATE, rulesetV: rV, presetsV: pV }
    if (wantR === rV) out.ruleset = null      // 未变化: 前端用缓存
    if (wantP === pV) out.presets = null      // 未变化: 前端用缓存
    return json(res, 200, out)
  }
  if (url.pathname === '/api/changes' && req.method === 'GET') {
    const cat = loadCatalog()
    return json(res, 200, { ok: true, updated_at: cat ? cat.updated_at : null, changes: (cat && cat.changes) || [] })
  }
  // 候选级事件日志的查询口。默认仍返回 100 条(兼容老仪表盘), 但支持过滤/分页 ——
  // 日志上限提到 2000 之后, "整份倒给前端、前端自己 slice" 这种用法就不合适了。
  if (url.pathname === '/api/usage' && req.method === 'GET') {
    const q = url.searchParams
    const limit = Math.max(1, Math.min(1000, Number(q.get('limit')) || 100))
    const prov = (q.get('provider') || '').trim()
    const mdl = (q.get('model') || '').trim()
    const rid = (q.get('id') || '').trim()
    const okF = q.get('ok')   // '1'=只看成功 / '0'=只看失败 / 缺省=全部
    let list = usageRecords
    if (prov) list = list.filter((x) => x.provider === prov)
    // 模型名走**子串**匹配, 不做精确匹配: 仪表盘那个框写着"搜模型名", 而全名往往很长
    // (gemini-3.8-flash-preview), 要求用户敲全才出结果等于没有这个功能。
    // provider 仍是精确匹配 —— 它是下拉框, 值由服务端给, 不存在"用户敲不准"的问题。
    if (mdl) { const m = mdl.toLowerCase(); list = list.filter((x) => String(x.model || '').toLowerCase().includes(m)) }
    if (rid) list = list.filter((x) => x.id === rid)
    if (okF === '1') list = list.filter((x) => x.ok)
    else if (okF === '0') list = list.filter((x) => !x.ok)
    const okCount = list.reduce((a, x) => a + (x.ok ? 1 : 0), 0)
    return json(res, 200, {
      ok: true,
      total: usageRecords.length,          // 日志里一共多少条
      matched: list.length,                // 命中过滤条件的有多少条
      okCount, failCount: list.length - okCount,
      records: list.slice(0, limit),
    })
  }
  // 请求级指标时序 —— 仪表盘所有图表的唯一数据源。只读、免鉴权(不含任何密钥)。
  // ?hours=24(1~168, 默认 24)
  if (url.pathname === '/api/metrics' && req.method === 'GET') {
    // ⚠ 不能写 `Number(get('hours')) || 24`: hours=0 时 `0 || 24` 会得到 24, 而下限是 1。
    // 区分"没传"和"传了但很小" —— 没传才用默认值, 传了就按 1~168 钳。
    const rawH = url.searchParams.get('hours')
    const hours = (rawH === null || rawH.trim() === '') ? 24 : Math.max(1, Math.min(METRICS_HOURS, Number(rawH) || 1))
    const series = metricsSeries(hours)
    const totals = series.reduce((a, b) => {
      a.n += b.n; a.ok += b.ok; a.fail += b.fail; a.abort += b.abort
      a.tin += b.tin; a.tout += b.tout
      for (const [k, v] of Object.entries(b.prov || {})) a.prov[k] = (a.prov[k] || 0) + v
      return a
    }, { n: 0, ok: 0, fail: 0, abort: 0, tin: 0, tout: 0, prov: {} })
    // ⚠ 成功率的分母不含 abort: 用户自己点"停止"不该拉低成功率, 否则越爱中断的人越像"网关不行"
    const denom = totals.ok + totals.fail
    totals.success_rate = denom ? Math.round((totals.ok / denom) * 1000) / 10 : null
    totals.overall = metricsOverall(hours)
    return json(res, 200, {
      ok: true, hours,
      from: series.length ? series[0].t : null,
      to: series.length ? series[series.length - 1].t : null,
      totals, series,
      metrics_updated_at: metricsState.updated_at,
    })
  }
  // 只读: 解释 auto 会怎么排。**按需排查用, 不往仪表盘上挂** ——
  // 它给的是一个"假想请求"下的排序, 而每次 auto 的真实情景都不一样(工具数量、轮数、上下文长短
  // 都会改变权重), 把某一次的排序快照摆到页面上只会误导。
  // 真要看"这次为什么选它", 带参数问这个接口即可。
  // 参数: ?tools=1(带工具) &messages=8(轮数) &chars=50000(正文规模) &n=12(看前几名)
  if (url.pathname === '/api/route' && req.method === 'GET') {
    const q = url.searchParams
    const n = Math.max(1, Math.min(50, Number(q.get('n')) || 12))
    const msgs = []
    const turns = Math.max(1, Math.min(200, Number(q.get('messages')) || 1))
    const chars = Math.max(0, Math.min(2000000, Number(q.get('chars')) || 0))
    for (let i = 0; i < turns; i++) msgs.push({ role: i % 2 ? 'assistant' : 'user', content: 'x'.repeat(Math.round(chars / turns)) })
    const payload = { model: 'auto', messages: msgs }
    // ask=<文本>: 把最后一条用户消息换成这句话 —— 用来排查**任务类型**的判定。
    // detectTask 只看最后一条 user 消息(见其注释), 所以这里换掉它就能复现"某句话会被判成什么题"。
    // 例: /api/route?ask=帮我写个排序函数   -> 响应里的 task 会变成 code, 代码模型随之升档。
    const ask = q.get('ask')
    // ⚠ 换的是**最后一条 user 消息**, 不是"最后一条消息" —— detectTask 只看前者(见其注释)。
    //   原来写的是 msgs[msgs.length-1], 而 messages 为偶数时最后一条是 assistant, 于是
    //   `?ask=` 这个排查入口在偶数轮次下**静默失效**(task 恒为 general), 差点让人误判
    //   "任务类型判定没生效"。排查入口自己先出 bug 是最坑的一种。
    if (ask) for (let i = msgs.length - 1; i >= 0; i--) { if (msgs[i].role === 'user') { msgs[i].content = ask; break } }
    if (q.get('tools') === '1') payload.tools = [{ type: 'function', function: { name: 'demo', parameters: { type: 'object' } } }]
    // vision=1: 把最后一条消息的 content 换成"文字 + 图片"数组 —— 用来排查**带图请求**的排序。
    // 带图时"名字无视觉信号"的模型会被降档(见 pickChain 的 visionMismatch), 这个开关就是它的排查入口。
    const wantsVision = q.get('vision') === '1'
    if (wantsVision) {
      // 同样挂在**最后一条 user 消息**上(真实客户端就是往用户那一轮附图), 而不是"最后一条消息"
      for (let i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i].role !== 'user') continue
        msgs[i].content = [{ type: 'text', text: String(msgs[i].content || 'x') }, { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } }]
        break
      }
    }
    // model=<名字>: 换掉被测模型名 —— 用来排查**路由组**与显式写法的排序。
    // 不传就是 auto, 老行为一个字节不变。组名/别名照样能传, 因为 pickChain 就是按名字解析的。
    // ⚠ 只调用一次 pickChain: 传了 model 就不要再先算一遍 auto(那是白跑一次全池排序)。
    const modelQ = String(q.get('model') || 'auto').trim() || 'auto'
    const chain = pickChain(modelQ, payload)
    return json(res, 200, {
      ok: true,
      model: modelQ,
      // 组被认出来没有 —— 名字拼错时这里是 null, 而 candidates 会变成 0, 一眼就能定位。
      group: resolveGroup(resolveAlias(modelQ)),
      request_tier: chain._reqTier,
      task: chain._task,
      weights: weightsFor(chain._reqTier),
      candidates: chain.length,
      vision: wantsVision,
      top: chain.slice(0, n).map((x, i) => {
        const p = x.ref
        // 直接读排序时真正用过的分数与加权分项，**不重算** —— 见 pickChain 里 partsW 的说明
        const pw = x.partsW || {}
        return {
          rank: i + 1, provider: p.name, model: x.model,
          score: Math.round((x.score || 0) * 1000) / 1000,
          tier: modelTier(x.model, chain._task),
          ttfb_ms: (p.modelLat && p.modelLat[x.model]) || p.latency || null,
          tokps: (p.modelTokps && p.modelTokps[x.model]) || p.tokps || null,
          rpm_cap: p.rpmCap || null, rpm_now: recentReqs(p.id),
          quality_err: qualityErrRate(p), samples: x.samples || null,
          cooling: !!((p.cooldownUntil || 0) > Date.now() || modelCooling(p, x.model, Date.now())),
          very_slow: isVerySlow(x),
          // 与 pickChain 里 tierShort 同一条判据(低档模型在复杂题上不领跑) —— 展示必须与真实排序一致
          tier_short: chain._reqTier >= 2 && x.tier < chain._reqTier,
          vision_ok: visionLikely(x.model),
          // 真实路由档位(0 领跑 / 1 不领跑 / 2 硬门槛)与**不领跑的原因**。
          // 注意与上面的 `rank` 区分: rank 是**列表位置**(1 起), route_rank 才是排序用的档位 ——
          // 同一个名字曾经让人误读(列表位置看着像档位), 所以这里用不同字段名把两者分开。
          route_rank: x.routeRank === undefined ? null : x.routeRank,
          demoted: x.demoted || [],
          parts: {
            tier: +(pw.tier || 0).toFixed(3), quality: +(pw.quality || 0).toFixed(3),
            avail: +(pw.avail || 0).toFixed(3), speed: +(pw.speed || 0).toFixed(3), load: +(pw.load || 0).toFixed(3),
          },
        }
      }),
    })
  }
  // ── 免费判定依据 ──
  // 回答"这个模型为什么被判免费 / 收费"。与 /api/route 同定位：只读、免鉴权、不含任何密钥。
  // 判定引擎的每个出口都会说明「哪一层 + 依据是什么」，可被第三方逐条核对 —— 这是判定可审计的前提。
  // 参数: ?provider=gemini&model=gemini-3-flash-preview
  if (url.pathname === '/api/why' && (req.method === 'GET' || req.method === 'POST')) {
    // GET  = 用实时状态判定（上游元数据未知）
    // POST = 可带上游元数据，跑**完整四层判定** —— 这是判定引擎的自验证入口：
    //        你不必读 server.mjs，就能自己核对"这个模型凭什么被判免费 / 收费"。
    //        判定规则的价值全在"可被第三方验证"，所以这个入口是刻意开放的。
    let pname = ''
    let model = ''
    let meta = null
    let metaGiven = false
    if (req.method === 'POST') {
      let b = {}
      try { b = JSON.parse(bodyStr || '{}') } catch { return json(res, 400, { ok: false, error: '请求体不是合法 JSON' }) }
      pname = String((b && b.provider) || '').trim()
      model = String((b && b.model) || '').trim()
      if (b && b.meta && typeof b.meta === 'object') { meta = b.meta; metaGiven = true }
    } else {
      pname = String(url.searchParams.get('provider') || '').trim()
      model = String(url.searchParams.get('model') || '').trim()
    }
    if (!pname || !model) return json(res, 400, { ok: false, error: '需要 provider 与 model 两个参数' })
    const p = (CFG.providers || []).find((x) => String(x.name || '').toLowerCase() === pname.toLowerCase())
    if (!p) {
      return json(res, 404, {
        ok: false,
        error: `没有名为 ${pname} 的供应商`,
        providers: (CFG.providers || []).map((x) => x.name),
      })
    }
    // live：实时判定。GET 时 meta 未知（上游元数据在扫描结束后就丢弃了，复现不了「元数据层」）；
    // POST 时用请求体给的 meta，四层判定全跑。两者结论不一致时，以"谁掌握了元数据"为准。
    const v = judgeFree(p.name, model, meta, p)
    const wl = whitelistFor(p)
    const q = (p.quarantine && p.quarantine[model]) || null
    // catalog：最近一次目录扫描**当时**留下的判定依据（why = 判定所在层 + 该厂商的白名单来源）。
    // 与 live 的差异本身就是信息 —— catalog 说 whitelist、live 说 closed-list，通常意味着
    // 它已从免费名单里掉了出去。
    const cat = loadCatalog()
    const ce = cat && Array.isArray(cat.providers) ? cat.providers.find((x) => x.name === p.name) : null
    const cm = ce && Array.isArray(ce.models)
      ? ce.models.find((x) => x.id === model || normId(x.id) === normId(model))
      : null
    return json(res, 200, {
      ok: true,
      provider: p.name,
      model,
      free: v.free,
      layer: v.layer,
      reason: v.reason,
      meta_available: metaGiven,
      catalog: cm
        ? { why: cm.why || null, source: ce.why_source || null, at: cat.updated_at || null, rec: !!cm.rec }
        : null,
      whitelist: wl
        ? {
          source: wl.source || null,
          openFree: !!wl.openFree,
          hybrid: !!wl.hybrid,
          models: wl.models.length,
          hit: wl.models.some((x) => sameId(x, model)),
        }
        : null,
      // 判定结果与实际去向应当一致：判免费却在池外，就是 quarantine/blocked/手动停用造成的，逐一列出。
      in_pool: providerModels(p).includes(model),
      blocked: !!(p.blocked && p.blocked[model]),
      quarantine: q,
      disabled: !!(p.disabledModels && p.disabledModels[model]),
    })
  }
  // ── 模型别名 ──
  // GET 返回全部; POST {name, target} 新增/更新, target 为空串则删除该条。
  // 增删改合成一个端点而不是 REST 三件套: 别名就是一张很小的映射表, 拆成三个端点只会让
  // 调用方多写两段代码, 没有任何好处。
  if (url.pathname === '/api/aliases') {
    if (req.method === 'GET') return json(res, 200, { ok: true, aliases: CFG.aliases || {} })
    if (req.method === 'POST') {
      let body
      try { body = JSON.parse(bodyStr || '{}') } catch { return json(res, 400, { error: 'invalid json' }) }
      const name = String(body.name || '').trim()
      const target = String(body.target == null ? '' : body.target).trim()
      CFG.aliases = CFG.aliases || {}
      if (!target) {
        if (!CFG.aliases[name]) return json(res, 404, { error: `别名 ${name} 不存在` })
        delete CFG.aliases[name]
        saveConfig()
        return json(res, 200, { ok: true, removed: name, aliases: CFG.aliases })
      }
      const bad = aliasProblem(name, target)
      if (bad) return json(res, 400, { error: bad })
      // 只解析一层是硬约束: 目标本身若是别名, a→b→a 就永远转不出来(见 resolveAlias)。
      if (CFG.aliases[target]) return json(res, 400, { error: `目标 ${target} 本身是一个别名; 别名不能指向别名(只解析一层)` })
      CFG.aliases[name] = target
      saveConfig()
      return json(res, 200, { ok: true, aliases: CFG.aliases })
    }
  }
  // ── 路由组 ──
  // GET 返回全部; POST {name, members:[...]} 新增/更新, members 为空数组则删除该组。
  // 与 /api/aliases 同一取舍: 一张很小的映射表, 合成一个端点而不是 REST 三件套。
  if (url.pathname === '/api/groups') {
    if (req.method === 'GET') return json(res, 200, { ok: true, groups: CFG.groups || {} })
    if (req.method === 'POST') {
      let body
      try { body = JSON.parse(bodyStr || '{}') } catch { return json(res, 400, { error: 'invalid json' }) }
      const name = String(body.name || '').trim()
      const members = Array.isArray(body.members) ? body.members.map((m) => String(m).trim()).filter(Boolean) : []
      CFG.groups = CFG.groups || {}
      if (!members.length) {
        if (!CFG.groups[name]) return json(res, 404, { error: `路由组 ${name} 不存在` })
        delete CFG.groups[name]
        saveConfig()
        return json(res, 200, { ok: true, removed: name, groups: CFG.groups })
      }
      const bad = groupProblem(name, members)
      if (bad) return json(res, 400, { error: bad })
      CFG.groups[name] = members
      saveConfig()
      return json(res, 200, { ok: true, groups: CFG.groups })
    }
  }
  // ── 配置导出 / 导入 ──
  // 换机器、备份、或手工改坏了之后的恢复通道。
  // ⚠ 导出内容**含各家明文 API Key**, 与 /api/state 的"只回掩码"策略正好相反 —— 这不是矛盾:
  //   掩码是为了防"本机任意脚本顺手偷 Key", 而导出是用户自己要备份, 给掩码等于没导出。
  //   两道防线: ① 必须通过管理鉴权(createServer 里已挡); ② 走 POST 而不是 GET ——
  //   GET 的完整 URL 会被浏览器历史、代理日志、Referer 留痕, POST 的正文不会。
  if (url.pathname === '/api/config/export' && req.method === 'POST') {
    return json(res, 200, {
      ok: true,
      exported_at: new Date().toISOString(),
      warning: '本文件含各家 API Key 明文, 请勿同步到网盘或提交仓库',
      config: CFG,
    })
  }
  if (url.pathname === '/api/config/import' && req.method === 'POST') {
    let body
    try { body = JSON.parse(bodyStr || '{}') } catch { return json(res, 400, { error: 'invalid json' }) }
    const incoming = body && body.config ? body.config : body
    const bad = configProblem(incoming)
    if (bad) return json(res, 400, { error: bad })
    // 先落一份当前配置的备份 —— 与结构迁移同一套思路: 出事能原样退回去。
    const ts = new Date().toISOString().replace(/[:.]/g, '-')
    const bak = CONFIG_PATH + '.import-bak.' + ts
    try { fs.copyFileSync(CONFIG_PATH, bak) } catch (e) { return json(res, 500, { error: '备份当前配置失败, 已放弃导入: ' + ((e && e.message) || e) }) }
    // 只覆盖白名单字段: 导入文件里多出来的杂键不会污染内存配置(它可能是别的版本的产物)。
    const KEEP = ['providers', 'aliases', 'proxy', 'port', 'gatewayKey', 'auth', 'maxConcurrent']
    const applied = []
    for (const k of KEEP) if (k in incoming) { CFG[k] = incoming[k]; applied.push(k) }
    if (!CFG.aliases || typeof CFG.aliases !== 'object') CFG.aliases = {}
    saveConfig()
    return json(res, 200, { ok: true, applied, backup: path.basename(bak), providers: CFG.providers.length, note: '已生效; 重启网关后全部生效(端口/代理改动需重启)' })
  }
  // ── 配置快照: 存 / 列 / 回滚 / 删（2026-10-17）────────────────────────────
  // 为什么需要: 本项目**没有 git**，改坏 config.json 之后唯一的退路是 .prev，而它只保留上一版。
  // 快照 = 用户主动打的时间点（改大动作之前存一个）。回滚只覆盖纯配置键，见 snapshotMerge。
  if (url.pathname === '/api/snapshots') {
    if (req.method === 'GET') {
      const items = []
      try {
        for (const f of fs.readdirSync(__dirname)) {
          const m = f.match(/^config\.json\.snap-(.+)$/)
          if (!m) continue
          const full = path.join(__dirname, f)
          let st
          try { st = fs.statSync(full) } catch { continue }
          let providers = 0, at = st.mtime.toISOString()
          try { const j = JSON.parse(fs.readFileSync(full, 'utf8')); providers = (j.providers || []).length; at = j.__snapshot_at || at } catch {}
          items.push({ name: m[1], at, providers, bytes: st.size })
        }
      } catch {}
      items.sort((a, b) => String(b.at).localeCompare(String(a.at)))
      return json(res, 200, { ok: true, items })
    }
    if (req.method === 'POST') {
      let body
      try { body = JSON.parse(bodyStr || '{}') } catch { return json(res, 400, { error: 'invalid json' }) }
      const action = String(body.action || 'save')
      // 文件名即用户输入 —— 必须过滤掉路径分隔符与空白，否则 ../ 能写到目录外
      const name = String(body.name || '').trim().replace(/[\\/:*?"<>|\s]+/g, '_').replace(/^\.+/, '').slice(0, 24)
      if (action === 'save') {
        if (!name) return json(res, 400, { error: '快照名不能为空' })
        const data = JSON.parse(JSON.stringify(CFG))
        data.__snapshot_at = new Date().toISOString()
        try { writeJsonAtomic(path.join(__dirname, 'config.json.snap-' + name), data) } catch (e) { return json(res, 500, { error: '写快照失败: ' + ((e && e.message) || e) }) }
        return json(res, 200, { ok: true, name, providers: (CFG.providers || []).length })
      }
      if (!name) return json(res, 400, { error: '缺少快照名' })
      const full = path.join(__dirname, 'config.json.snap-' + name)
      if (!fs.existsSync(full)) return json(res, 404, { error: '没有这个快照' })
      if (action === 'delete') {
        try { fs.unlinkSync(full) } catch (e) { return json(res, 500, { error: '删除失败: ' + ((e && e.message) || e) }) }
        return json(res, 200, { ok: true, deleted: name })
      }
      if (action === 'restore') {
        let snap
        try { snap = JSON.parse(fs.readFileSync(full, 'utf8')) } catch { return json(res, 400, { error: '快照文件不是合法 JSON' }) }
        if (!snap || typeof snap !== 'object' || !Array.isArray(snap.providers)) return json(res, 400, { error: '快照内容不像一份配置' })
        // 回滚前先把当前配置留档 —— 回滚本身也是一次破坏性操作，必须可撤销。
        const ts = new Date().toISOString().replace(/[:.]/g, '-')
        const bak = CONFIG_PATH + '.pre-restore.' + ts
        try { fs.copyFileSync(CONFIG_PATH, bak) } catch (e) { return json(res, 500, { error: '备份当前配置失败, 已放弃回滚: ' + ((e && e.message) || e) }) }
        const merged = snapshotMerge(CFG, snap)
        for (const k of Object.keys(CFG)) delete CFG[k]
        Object.assign(CFG, merged)
        if (!CFG.aliases || typeof CFG.aliases !== 'object') CFG.aliases = {}
        saveConfig()
        return json(res, 200, {
          ok: true, restored: name, backup: path.basename(bak),
          providers: (CFG.providers || []).length,
          note: '配置已回滚; 冷却/拉黑等运行时状态保留当前值',
        })
      }
      return json(res, 400, { error: '未知 action: ' + action })
    }
  }
  // 手动立即同步免费白名单（每日自动之外的兜底入口）
  if (url.pathname === '/api/whitelist/sync' && req.method === 'POST') {
    // ⚠ 同步进行中时**不能**报"同步失败" —— 那会让用户以为源挂了。
    //   网关启动时本来就会自动同步一轮（要拉 models.dev 的 4.7MB），用户在这期间点「同步白名单」
    //   必然撞上 _wlSyncing：syncUpstreamWhitelist() 直接 return undefined -> ok=false
    //   -> 前端弹"同步失败（网络不通或源不可用）"。实测耗时 0.008s 就返回，文案却指向网络问题。
    if (_wlSyncing) return json(res, 200, { ok: false, busy: true, error: '同步正在进行中（首次要拉 models.dev 的 4.7MB 清单，约 1–3 分钟），稍后刷新即可' })
    const ok = await syncUpstreamWhitelist()
    const w = loadWhitelist()
    return json(res, 200, {
      ok,
      synced: ok && w ? { fetched_at: w.fetched_at, list_date: w.list_date, sources: w.sources || null, hosts: Object.keys(w.hosts).length } : null,
      error: ok ? undefined : '同步失败（网络不通或源不可用），已沿用本地缓存名单',
    })
  }
  if (url.pathname === '/api/providers' && req.method === 'POST') {
    let body
    try { body = JSON.parse(bodyStr) } catch { return json(res, 400, { error: 'invalid json' }) }
    const picked = Array.isArray(body.models) ? body.models.filter(Boolean) : []
    // 手动填写的模型名单独传(见 dashboard 的 manual_model 输入框): 它们没经过 /api/fetchfree 的
    // isFree 过滤, 是唯一需要补校验的来源; picked 勾选来的已带元数据校验过, 不能再校验一次
    // —— 这里的 isFree 拿不到元数据, 重复校验会把"靠元数据判免费"的模型误伤成未验证。
    const manual = Array.isArray(body.manual) ? body.manual.map((x) => String(x).trim()).filter(Boolean) : []
    const models = [...picked, ...manual]
    if (!models.length) return json(res, 400, { error: '至少选择一个模型' })
    for (const k of ['name', 'base_url', 'api_key']) if (!body[k]) return json(res, 400, { error: `缺少字段 ${k}` })
    try { body.base_url = normalizeBaseUrl(body.base_url) } catch (e) { return json(res, 400, { error: e.message }) }
    if (CFG.providers.some((p) => p.name === body.name)) body.name += '-' + Date.now().toString(36)
    const provider = {
      id: crypto.randomUUID(),
      name: body.name,
      label: body.label || body.name,
      base_url: body.base_url,
      api_key: body.api_key,
      model: models[0],
      models,
      needs_proxy: !!body.needs_proxy,
      enabled: true,
      ok: 0, err: 0, cooldownUntil: 0, lastError: '',
    }
    CFG.providers.push(provider)
    // 免费校验闸门: 只卡手动填写的模型名(详见 gateUnverifiedModels 注释)
    const unverified = gateUnverifiedModels(provider, manual)
    saveConfig()
    // 新加的供应商立刻扫一次免费池, 目录/推荐即时更新(无需等下一次 6 小时轮询)
    refreshCatalogSafe().catch((e) => console.error('[catalog]', e.message))
    return json(res, 200, { ok: true, id: provider.id, unverified })
  }
  if (url.pathname === '/api/listmodels' && req.method === 'POST') {
    let body
    try { body = JSON.parse(bodyStr) } catch { return json(res, 400, { error: 'invalid json' }) }
    let p = CFG.providers.find((x) => x.id === body.id)
    if (!p) p = { base_url: body.base_url, api_key: body.api_key, needs_proxy: !!body.needs_proxy }
    if (!p.base_url || !p.api_key) return json(res, 400, { error: '缺少 base_url 或 api_key' })
    listUpstreamModels(p)
      .then((models) => json(res, 200, { ok: true, models }))
      .catch((e) => json(res, 200, { ok: false, error: e.message }))
    return
  }
  const mp = url.pathname.match(/^\/api\/providers\/([\w-]+)$/)
  if (mp && req.method === 'DELETE') {
    CFG.providers = CFG.providers.filter((p) => p.id !== mp[1])
    saveConfig()
    return json(res, 200, { ok: true })
  }
  const up1 = url.pathname.match(/^\/api\/providers\/([\w-]+)\/update$/)
  if (up1 && req.method === 'POST') {
    const p = CFG.providers.find((x) => x.id === up1[1])
    if (!p) return json(res, 404, { error: 'not found' })
    let body
    try { body = JSON.parse(bodyStr) } catch { return json(res, 400, { error: 'invalid json' }) }
    const prevPool = new Set(p.models || [])
    if (Array.isArray(body.models) && body.models.length) { p.models = body.models; p.model = body.models[0] }
    else if (body.model) { p.model = body.model; p.models = [body.model] }
    // 同一道免费校验闸门: 只校验"本次新写进来的"模型 —— 池里原有的早经目录扫描验证过,
    // 重复校验会因拿不到元数据而把"靠元数据判免费"的模型误伤成未验证。
    const unverified = gateUnverifiedModels(p, (p.models || []).filter((m) => !prevPool.has(m)))
    if (Array.isArray(body.keys) && body.keys.length) {
      p.keys = body.keys.map((k) => String(k).trim()).filter(Boolean)
      p.api_key = p.keys[0]
      p.keyCooldown = {}
      // 整份替换 Key 列表 = 下标全部作废, 逐 Key 的统计与启停必须一起清掉,
      // 否则旧的"第 2 把已停用"会莫名其妙套到新的第 2 把上
      p.keyStats = {}; p.keyDisabled = {}
    } else if (body.api_key) {
      p.api_key = body.api_key; p.keys = [body.api_key]
      p.keyCooldown = {}; p.keyStats = {}; p.keyDisabled = {}
    }
    p.cooldownUntil = 0; p.err = 0
    saveConfig()
    return json(res, 200, { ok: true, unverified })
  }
  // ---------------- 逐 Key 精细管理 ----------------
  // 一个供应商可以配多把 Key 轮换, 但原来只有"整体覆盖粘贴"一个入口, 而且看不见每把 Key 的健康 ——
  // 某把 Key 悄悄失效后, 用户只能从"这家最近老失败"里猜。这里补上逐 Key 的读与改。
  // ⚠ 全部接口(含 list)都要求网关 Key: 掩码虽然只露前 6 后 4, 但那是密钥的一部分,
  // 没有理由让免鉴权的 GET 就能枚举出来。
  const km = url.pathname.match(/^\/api\/providers\/([\w-]+)\/keys(?:\/(add|remove|toggle|reset))?$/)
  if (km) {
    if (!authedAny(req, url)) return json(res, 401, { error: 'Key 管理需要网关 Key' })
    // ⚠ 供应商的 id 是 UUID, name 才是 groq/gemini 这种可读标识。仪表盘用 id 寻址(精确),
    // 但人用 curl 排查时手上只有名字 —— 这里两种都认, 否则"用名字查一下这把 Key 的状态"
    // 会得到 404, 而用户会以为是"这家没配 Key"。
    const p = CFG.providers.find((x) => x.id === km[1] || x.name === km[1])
    if (!p) return json(res, 404, { error: 'not found' })
    const action = km[2] || 'list'
    if (action === 'list') return json(res, 200, { ok: true, keys: keyInfoList(p), activeIdx: pickKeyIdx(p, Date.now()), allDisabled: keysAllDisabled(p) })
    if (req.method !== 'POST') return json(res, 405, { error: '该操作请用 POST' })
    let kb
    try { kb = JSON.parse(bodyStr || '{}') } catch { return json(res, 400, { error: 'invalid json' }) }
    const keys = providerKeys(p)
    const idxOk = (i) => Number.isInteger(i) && i >= 0 && i < keys.length
    if (action === 'add') {
      const k = String(kb.key || '').trim()
      if (!k) return json(res, 400, { error: '请填写要添加的 Key' })
      if (keys.includes(k)) return json(res, 400, { error: '这把 Key 已经在该供应商里了' })
      keys.push(k)
      p.keys = keys; p.api_key = keys[0]
      p.cooldownUntil = 0
      saveConfig()
      return json(res, 200, { ok: true, keys: keyInfoList(p), added: keys.length - 1 })
    }
    if (action === 'remove') {
      const i = Number(kb.idx)
      if (!idxOk(i)) return json(res, 400, { error: 'idx 越界' })
      // ⚠ 不允许删到 0 把: 那会留下一家"永远没有 Key"却仍占着路由池的供应商 ——
      // 每次路由都会选中它、再白等一个往返才发现没 Key。要清空请直接删供应商。
      if (keys.length <= 1) return json(res, 400, { error: '至少要保留一把 Key；想清空请直接删除该供应商' })
      keys.splice(i, 1)
      reindexKeys(p, i)          // ⚠ 必须在写入新 keys 之前重建索引(见 reindexKeys 说明)
      p.keys = keys; p.api_key = keys[0]
      p.cooldownUntil = 0
      saveConfig()
      return json(res, 200, { ok: true, keys: keyInfoList(p) })
    }
    if (action === 'toggle') {
      const i = Number(kb.idx)
      if (!idxOk(i)) return json(res, 400, { error: 'idx 越界' })
      p.keyDisabled = p.keyDisabled || {}
      const toEnable = kb.enabled !== undefined ? !!kb.enabled : !!p.keyDisabled[i]
      if (toEnable) delete p.keyDisabled[i]; else p.keyDisabled[i] = true
      // 同样不许把最后一把可用 Key 也停掉 —— 那等于把这家静默变成死供应商, 却还在池子里被选中
      if (keysAllDisabled(p)) {
        delete p.keyDisabled[i]
        return json(res, 400, { error: '至少要保留一把启用中的 Key' })
      }
      saveConfig()
      return json(res, 200, { ok: true, keys: keyInfoList(p) })
    }
    if (action === 'reset') {
      const i = Number(kb.idx)
      p.keyCooldown = p.keyCooldown || {}
      if (idxOk(i)) delete p.keyCooldown[i]
      else if (kb.idx === undefined || kb.idx === null) p.keyCooldown = {}   // 不带 idx = 全部解除
      else return json(res, 400, { error: 'idx 越界' })
      p.cooldownUntil = 0
      saveConfig()
      return json(res, 200, { ok: true, keys: keyInfoList(p) })
    }
    return json(res, 400, { error: '未知操作' })
  }
  // 添加前: 用表单里的 base_url+key 直接拉取免费模型列表(带推荐标注)
  if (url.pathname === '/api/fetchfree' && req.method === 'POST') {
    let body
    try { body = JSON.parse(bodyStr) } catch { return json(res, 400, { error: 'invalid json' }) }
    const p = { base_url: body.base_url, api_key: body.api_key, needs_proxy: !!body.needs_proxy }
    if (!p.base_url || !p.api_key) return json(res, 400, { error: '缺少 base_url 或 api_key' })
    const pname = (body.name || '').toLowerCase()
    // 兜底: 上游列表接口没返回 / 拉取失败时, 改用每日同步的免费白名单直接展示,
    // 免得用户对着"未识别出免费模型"手动猜模型 ID(典型: Cloudflare search 接口无权限或返回空)。
    // 统一条目构造。两个新标记都是"免费之外"的信息, 用户勾选前应该看到:
    //   log    = 上游会记录 prompt 用于改进服务(Empero/Kilo-auto/NVIDIA 免费端点都有这条), 敏感数据别用
    //   router = 路由型模型, 名字不对应固定模型, 由厂商内部转发
    const mkItem = (id, meta) => ({
      id, rec: isRecommended(pname, id), promo: promoOf(pname, id), type: '文字对话',
      log: !!(meta && meta.mayTrainOnYourPrompts),
      router: isRouterModel({ id, meta }),
    })
    const wlFallback = () => {
      const wl = whitelistFor(p)
      if (!wl || !Array.isArray(wl.models) || !wl.models.length) return []
      return wl.models
        .filter((id) => modelRouteType(id, null).chat && !DENY_FREE.some((re) => re.test(String(id))))
        .map((id) => mkItem(id, null))
    }
    listUpstreamModels(p)
      .then((list) => {
        const excluded = list.map((x) => ({ id: x.id, type: modelRouteType(x.id, x.meta) }))
          .filter((x) => !x.type.chat)
          .map((x) => ({ id: x.id, kind: x.type.kind }))
        let free = list.filter((x) => isFree(pname, x.id, x.meta, p)).map((x) => mkItem(x.id, x.meta))
        let note = excluded.length ? `已自动排除 ${excluded.length} 个非文字对话模型（不会接入 auto）` : ''
        if (!free.length) {
          free = wlFallback()
          if (free.length) note = `${note ? note + '；' : ''}上游列表接口没有识别出免费模型，已按每日同步的免费名单显示 ${free.length} 个`
        }
        json(res, 200, { ok: true, total: list.length, models: free, excluded, note, all: list.map((x) => x.id) })
      })
      .catch((e) => {
        const models = wlFallback()
        if (models.length && !/ACCOUNT_ID/.test(e.message)) {
          json(res, 200, { ok: true, total: 0, models, note: `拉取失败（${e.message.slice(0, 80)}），已按每日同步的免费名单显示 ${models.length} 个` })
        } else {
          json(res, 200, { ok: false, error: e.message })
        }
      })
    return
  }
  // 限时活动公告页巡检状态(含手动触发, 供仪表盘"检查活动"按钮用)
  if (url.pathname === '/api/promo') {
    if (url.searchParams.get('refresh') === '1') {
      watchPromoPages().catch((e) => console.warn('[promo]', e.message))
      return json(res, 200, { ok: true, refreshing: true, promo: promoStatusPayload() })
    }
    return json(res, 200, { ok: true, promo: promoStatusPayload() })
  }
  // 聚合目录
  if (url.pathname === '/api/catalog') {
    if (url.searchParams.get('refresh') === '1') {
      // 手动刷新 = 用户明确要"最新的"，所以走**完整链路**: 先同步源, 再扫上游。
      // 顺序不能反: 白名单是目录扫描的判定依据(判"这个模型免不免费"), 先扫后同步等于
      // 用旧口径判一遍, 然后立刻还要再判一遍。
      // ⚠ 白名单没变时同步会走 304 短路、**不会**自己触发扫描, 所以这里必须显式再调一次 ——
      //   用户点"刷新"要的是"重新看一遍上游", 而不是"确认源没变"。
      //   (若同步内部已因"源有变化"触发过扫描, refreshCatalogSafe 的 catalogRefreshing 旗标
      //    会让这一次直接返回, 不会扫两遍。)
      ;(async () => {
        try { await syncUpstreamWhitelist() } catch (e) { console.warn('[whitelist] 手动刷新同步失败:', (e && e.message) || e) }
        refreshCatalogSafe().catch((e) => console.error('[catalog]', e.message))
      })()
      return json(res, 200, { ok: true, refreshing: true, catalog: loadCatalog() })
    }
    return json(res, 200, { ok: true, catalog: loadCatalog() || (catalogRefreshing ? { refreshing: true } : null) })
  }
  // 模型勾选开关: 取消勾选 = 不参与路由(保留在池中, 重新勾选立即生效)
  const mt = url.pathname.match(/^\/api\/providers\/([\w-]+)\/modeltoggle$/)
  if (mt && req.method === 'POST') {
    const p = CFG.providers.find((x) => x.id === mt[1])
    if (!p) return json(res, 404, { error: 'not found' })
    let body
    try { body = JSON.parse(bodyStr) } catch { return json(res, 400, { error: 'invalid json' }) }
    if (!body.model) return json(res, 400, { error: '缺少 model' })
    p.disabledModels = p.disabledModels || {}
    if (body.enabled === false) p.disabledModels[body.model] = { at: new Date().toISOString() }
    else delete p.disabledModels[body.model]
    // 默认模型若被停用, 换成第一个启用的
    if (p.disabledModels[p.model]) {
      const first = providerModels(p)[0]
      if (first) p.model = first
    }
    saveConfig()
    return json(res, 200, { ok: true, enabled: body.enabled !== false })
  }
  const up2 = url.pathname.match(/^\/api\/providers\/([\w-]+)\/unblock$/)
  if (up2 && req.method === 'POST') {
    const p = CFG.providers.find((x) => x.id === up2[1])
    if (!p) return json(res, 404, { error: 'not found' })
    let body
    try { body = JSON.parse(bodyStr) } catch { return json(res, 400, { error: 'invalid json' }) }
    // 同时解除"永久拉黑"(blocked) 与 "自动隔离"(quarantine)
    // ⚠ 光删标记不够, 必须把模型**显式放回 p.models** —— 否则这个按钮等于没反应:
    //   refreshCatalog 的 pool_sync 只把"当前判定免费"的模型写进 p.models
    //   (`free = r.models.filter(id => !isBlocked(p,id) && !p.quarantine[id])`),
    //   被隔离/拉黑的模型在那一轮就已经被从池里剔掉了。于是用户点「解除」, 标记没了、
    //   仪表盘还弹"已放回可用池", 可模型根本不在池里 —— 路由永远选不到它。
    //   手动解除本身就是"用户确信它免费"的显式人工确认, 放回池是它的语义。
    if (body.model) {
      if (p.blocked) delete p.blocked[body.model]
      if (p.quarantine) delete p.quarantine[body.model]
      if (body.model && !providerModels(p).includes(body.model)) {
        p.models = Array.isArray(p.models) ? p.models : []
        if (!p.models.includes(body.model)) p.models.push(body.model)
        if (!p.model) p.model = p.models[0]
      }
    } else {
      // 全部解除: 把 blocked/quarantine 里记着的模型名一并放回, 不然"全部解除"只清了标记
      const back = [...Object.keys(p.blocked || {}), ...Object.keys(p.quarantine || {})]
      p.blocked = {}
      p.quarantine = {}
      p.models = Array.isArray(p.models) ? p.models : []
      for (const m of back) if (m && !p.models.includes(m)) p.models.push(m)
      if (!p.model && p.models.length) p.model = p.models[0]
    }
    saveConfig()
    return json(res, 200, { ok: true })
  }
  // 一键体检: 对已接入的每个模型发一条最小请求, 主动发现"已转收费 / 已失效"的模型,
  // 而不是等真实请求撞上 402 才知道。命中计费特征会被立即拉黑。
  const ck = url.pathname.match(/^\/api\/providers\/([\w-]+)\/check$/)
  if (ck && req.method === 'POST') {
    const p = CFG.providers.find((x) => x.id === ck[1])
    if (!p) return json(res, 404, { error: 'not found' })
    const models = (p.models && p.models.length) ? p.models : [p.model]
    const keys = providerKeys(p)
    const results = await mapLimit(models, 2, async (m) => {
      const ki = pickKeyIdx(p, Date.now())
      const key = ki >= 0 ? keys[ki] : (keys[0] || p.api_key)
      try {
        const up = await forward(p, { model: m, max_tokens: 4, messages: [{ role: 'user', content: 'ping' }] }, 30000, key)
        const text = await readBody(up)
        if (up.statusCode >= 400) {
          markFail(p, up.statusCode, m, 0, ki, text)
          const kind = classifyUpstreamError(up.statusCode, text)
          return { model: m, ok: false, status: up.statusCode, kind, blocked: kind === 'billing' || kind === 'retired', detail: text.slice(0, 160) }
        }
        markOk(p, m, ki)
        return { model: m, ok: true, status: up.statusCode }
      } catch (e) {
        markFail(p, 0, m, 0, ki)
        return { model: m, ok: false, status: 0, error: e.message }
      }
    })
    saveConfig()
    return json(res, 200, { ok: true, results })
  }
  const tp = url.pathname.match(/^\/api\/providers\/([\w-]+)\/(toggle|test)$/)
  if (tp) {
    const p = CFG.providers.find((x) => x.id === tp[1])
    if (!p) return json(res, 404, { error: 'not found' })
    // 注意: 全项目判定"是否启用"用的是 `enabled !== false`(undefined 也算启用),
    // 所以这里必须用同一口径取反 —— 若写成 `p.enabled === false`, 对 enabled 为 undefined 的
    // 供应商首次点击会把它置为 false(停用), 与用户预期正好相反。
    if (tp[2] === 'toggle') {
      p.enabled = (p.enabled !== false) ? false : true
      if (p.enabled) {
        // ⚠ 启用不是"翻个标志位"那么简单(2026-09-21 用户实测踩到): 原先只 saveConfig 就返回,
        //   于是重新启用 = 模型立刻回到 auto 路由池, 却**没有任何校验** —— 首次体检最晚 6 小时后
        //   才轮到它。这中间如果厂商早就换了模型/砍了免费档, 网关会拿一个死模型去撞每条请求。
        //   实测样本: empero 被停用期间官方把 glm-5.3-flash 换成了 Qwen/Qwen3.8-27B-FP8,
        //   重新启用后卡片上还挂着 4 天前的旧报错, 模型却已经进了池。
        // 两件事必须一起做:
        //   ① 清掉停用期间残留的陈旧状态(旧报错/旧冷却/旧账号标记) —— 它们描述的是"上一段人生",
        //      继续显示就是谎报(用户原话:"上游故障为什么模型还勾选在里面")。
        //   ② 立刻扫一轮(含全池体检) —— 做到"启用即体检", 不留零校验窗口。
        p.lastError = ''
        p.modelCooldown = {}
        p.cooldownUntil = 0
        p.keyCooldown = {}
        clearAccountIssue(p)
        saveConfig()
        refreshCatalogSafe().catch((e) => console.error('[catalog]', e.message))
      } else {
        saveConfig()
      }
      return json(res, 200, { ok: true, enabled: p.enabled })
    }
    // test: 直接向该供应商发一条最小请求
    forward(p, { model: p.model, max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] }, 45000, providerKeys(p)[0])
      .then(async (up) => {
        const text = await readBody(up)
        if (up.statusCode >= 400) { markFail(p, up.statusCode, p.model, 0, 0, text); json(res, 200, { ok: false, status: up.statusCode, blocked: up.statusCode === 402 || BILLING_RE.test(text), detail: text.slice(0, 300) }) }
        else { markOk(p, p.model, 0); json(res, 200, { ok: true, status: up.statusCode, detail: text.slice(0, 300) }) }
      })
      .catch((e) => { markFail(p, 0, p.model, 0, 0); json(res, 200, { ok: false, error: e.message }) })
    return
  }
  json(res, 404, { error: 'not found' })
}

// ---------------- 入站并发闸门 ----------------
// 为什么需要: 免费池的配额是"每分钟/每天多少次", 而 agent 客户端(WorkBuddy / Cursor /
// Cline)常常一次并发好几条请求。放开不管时, 瞬时并发会把某家的 rpm 打满 → 撞 429 →
// 触发冷却 → 表现成"突然所有模型都不可用", 而根因只是本地一次并发。
// 与其让上游来惩罚我们, 不如在本地先排一下队。
//
// ⚠ 默认 maxConcurrent = 0 = **不限**, 与改造前完全一致 —— 这是个 opt-in 的阀门,
//   不改变任何现有用户的行为。想用的人在 config.json 里写个数即可。
// ⚠ 只对"调用模型"的端点计数。管理接口与 /healthz / /v1/models 一律不排队 ——
//   健康检查要是被排队挡住, 监控会误判"网关挂了", 那是比限流更糟的故障。
const QUEUE_MAX = 32          // 队列上限: 超过就直接 503, 不让客户端无限堆积
const QUEUE_WAIT_MS = 20000   // 排队最长等 20s, 超时按"忙"处理
let inflightChat = 0
const chatQueue = []
function acquireChatSlot() {
  const max = Number(CFG.maxConcurrent) || 0
  if (max <= 0) return Promise.resolve(true)                    // 不限(默认)
  if (inflightChat < max) { inflightChat++; return Promise.resolve(true) }
  if (chatQueue.length >= QUEUE_MAX) return Promise.resolve(false)
  return new Promise((resolve) => {
    const entry = { resolve, timer: null }
    entry.timer = setTimeout(() => {
      const i = chatQueue.indexOf(entry)
      if (i >= 0) { chatQueue.splice(i, 1); resolve(false) }     // 超时: 从队列摘掉再回绝
    }, QUEUE_WAIT_MS)
    chatQueue.push(entry)
  })
}
function releaseChatSlot() {
  inflightChat = Math.max(0, inflightChat - 1)
  const next = chatQueue.shift()
  if (next) { clearTimeout(next.timer); inflightChat++; next.resolve(true) }
}
// 包住一次"调用模型"的请求。名额的释放挂在响应结束上, **不能**用 finally:
// 流式请求里 handleChat 把转发交给了一个后台异步任务就返回了, finally 会在流还没推完时
// 就把名额还掉, 闸门等于形同虚设。
async function serveWithSlot(req, res, fn) {
  // 请求级"客户端已断开"信号。注册点必须在**进入 attemptChain 之前** ——
  // hookClientAbort 要等上游回话(拿到 up)才装得上, 而用户等不耐烦点停止恰恰发生在那之前;
  // 那段时间里上游请求无人管理: 免费额度照烧, 日志里还留一条"成功"。
  // 这里只负责"广播中止", 统计仍由 hookClientAbort / 各处 catch 记录, 免得同一件事记两遍。
  if (CFG.cancelPropagation !== false) {
    req.__aborted = false
    req.__abortHooks = []
    res.on('close', () => {
      const hooks = req.__abortHooks || []
      req.__abortHooks = []          // 无论正常结束还是断开都清空, 别把候选闭包一直挂在请求上
      if (res.writableEnded || req.__aborted) return   // 正常结束: 什么都不做
      req.__aborted = true
      STATS.aborted = (STATS.aborted || 0) + 1
      for (const h of hooks) { try { h() } catch {} }
    })
  }
  const got = await acquireChatSlot()
  if (!got) {
    const max = Number(CFG.maxConcurrent) || 0
    try { res.setHeader('retry-after', '5') } catch {}
    return json(res, 503, { error: { code: 'too_many_requests', message: `本机网关并发已达上限 ${max}（config.json 的 maxConcurrent），请稍后重试或调大该值`, request_id: req.__rid } })
  }
  let released = false
  const release = () => { if (!released) { released = true; releaseChatSlot() } }
  res.on('close', release)
  res.on('finish', release)
  return fn()
}

// ---------------- HTTP 服务 ----------------
// 本项目只聚合"文字对话"模型, 以下 OpenAI/Gemini 端点一律不实现。
// 单独列出来是为了回 501(能力不支持)而不是泛化 404(路径写错) —— 客户端探测时能看懂原因。
const NOT_IMPLEMENTED_RE = [
  /^\/v1\/embeddings$/,
  /^\/v1\/completions$/,
  /^\/v1\/(audio|images|moderations|rerank|batches)(\/|$)/,
  /^\/v1\/models\/[^/]+$/,
  /^\/v1beta\/models$/,
]
const PID_PATH = path.join(__dirname, 'gateway.pid')

// ---------------- 健康检查: 存活 vs 就绪 ----------------
// 背景: 原来的 /healthz 只回 {ok:true, providers:N}, 它回答的是"进程还在监听吗"。
// 但真正让人踩坑的场景是"网关活着、可上游一家都连不上"(典型: 代理没开) —— 此时浅检照样
// 一片绿, 客户端却一直 502。反过来也不能让浅检去依赖外网: 它是 小鸡开关.bat 与各类客户端
// 判断"网关起没起"的唯一依据, 一旦它也会因上游不通而失败, 就再没人能区分
// "网关没起来"和"上游连不上"了。所以拆成两层, 由 ?deep=1 选择。
//
// ⚠ 深检刻意**不走 forward()**: forward 会写供应商成败统计、触发冷却与拉黑 ——
//   一次健康检查不该改变路由状态(与"体检/复审/测试按钮的合成探针不进质量窗口"同一条原则)。
const PROBE_MS = 4000
// 代理连通性: 只做 TCP 连接, 不发协议数据 —— 目的是回答"代理端口开着吗",
// 而不是"这个代理能不能翻出去"(后者要么很贵要么不可靠, 交给上游可达性去反映)。
function probeProxy(proxyUrl) {
  return new Promise((resolve) => {
    let u
    try { u = new URL(proxyUrl) } catch { return resolve({ configured: true, ok: false, error: '代理地址格式错误: ' + proxyUrl }) }
    const port = Number(u.port) || (u.protocol === 'https:' ? 443 : 80)
    const t0 = Date.now()
    const sock = net.connect({ host: u.hostname, port })
    let done = false
    const fin = (ok, error) => {
      if (done) return
      done = true
      try { sock.destroy() } catch {}
      resolve({ configured: true, host: u.hostname, port, ok, ms: Date.now() - t0, error })
    }
    sock.setTimeout(2500)
    sock.once('connect', () => fin(true))
    sock.once('timeout', () => fin(false, '连接超时'))
    sock.once('error', (e) => fin(false, (e && e.code) || (e && e.message) || '连接失败'))
  })
}
// 单家上游可达性: 裸 GET /models + 短超时。2xx/4xx 都算"可达"(4xx 说明网络通、Key 或路径有问题,
// 那是另一种故障, 不该混进"就绪"里); 5xx 与网络错误算不可达。
function probeUpstream(p) {
  const t0 = Date.now()
  return new Promise((resolve) => {
    let u
    try { u = new URL(normalizeBaseUrl(p.base_url).replace(/\/+$/, '') + '/models') }
    catch { return resolve({ name: p.name, ok: false, ms: 0, error: 'base_url 格式错误' }) }
    const useProxy = p.needs_proxy && CFG.proxy
    const agent = useProxy ? getTunnelAgent(CFG.proxy) : undefined
    const mod = u.protocol === 'https:' ? https : http
    let done = false
    let r0 = null
    const fin = (r) => { if (done) return; done = true; clearTimeout(timer); resolve(r) }
    const timer = setTimeout(() => { try { if (r0) r0.destroy() } catch {} ; fin({ name: p.name, ok: false, ms: Date.now() - t0, error: '超时' }) }, PROBE_MS)
    r0 = mod.request({
      hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search, method: 'GET', agent,
      headers: authHeaderFor(p, providerKeys(p)[0]),
    }, (res) => {
      res.resume()   // 丢弃响应体: 只要状态码, 别把整份模型列表读进来
      fin({ name: p.name, ok: res.statusCode < 500, status: res.statusCode, ms: Date.now() - t0 })
    })
    r0.on('error', (e) => fin({ name: p.name, ok: false, ms: Date.now() - t0, error: (e && e.code) || (e && e.message) }))
    r0.end()
  })
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${CFG.port}`)
  // ⚠ 请求 ID 必须在**进入处理器的第一件事**就定下来并写进响应头。
  // 此前它只在 handleChat / serveNative 里生成 —— 而鉴权失败的 401 发生在那两者**之前**,
  // 于是"Key 填错了"这个用户最常拿来报障的响应, 既没有 x-request-id 也没有 request_id,
  // 拿到日志也认不出是哪一次调用。下游复用同一个 id, 保证响应头 / 错误体 / 日志三处一致。
  const rid = newReqId()
  req.__rid = rid
  try { res.setHeader('x-request-id', rid) } catch {}

  // CORS: 只对 /v1 与 /v1beta 模型端点开放(供浏览器内客户端调用);
  // /api/* 管理接口不加 CORS 头, 浏览器跨域无法读取, 防止恶意网页偷 Key
  if (url.pathname.startsWith('/v1') || url.pathname.startsWith('/v1beta')) {
    res.setHeader('access-control-allow-origin', '*')
    res.setHeader('access-control-allow-headers', 'authorization,content-type,x-gateway-key,x-api-key,x-goog-api-key,anthropic-version')
    res.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS')
  }
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end() }

  // 静态资源: /assets/* 映射到 ./assets/。仅供仪表盘引用本地缓存的厂商 logo,
  // 路径严格白名单(仅 logos/ 子目录) + 防穿越, 不暴露 ./ 任意文件。
  if (url.pathname.startsWith('/assets/')) {
    const rel = url.pathname.slice('/assets/'.length).split('/').filter(Boolean)
    // 只允许 logos/ 一层子目录,文件名必须是 ASCII + 限制扩展
    if (rel.length !== 2 || rel[0] !== 'logos' || !/^[a-z0-9_.-]+$/i.test(rel[1])) {
      return json(res, 400, { error: 'bad assets path' })
    }
    const filePath = path.join(__dirname, 'assets', ...rel)
    let st
    try { st = fs.statSync(filePath) } catch { return res.writeHead(404).end() }
    if (!st.isFile()) return res.writeHead(404).end()
    const ext = path.extname(filePath).toLowerCase()
    const mime = ext === '.svg' ? 'image/svg+xml' : ext === '.png' ? 'image/png' : ext === '.ico' ? 'image/x-icon' : ext === '.webp' ? 'image/webp' : 'application/octet-stream'
    res.setHeader('content-type', mime)
    res.setHeader('cache-control', 'public, max-age=3600')
    res.setHeader('content-length', String(st.size))
    fs.createReadStream(filePath).pipe(res)
    return
  }

  if (url.pathname === '/' || url.pathname === '/dashboard') {
    // 网关 Key 通过 HTML 占位符注入页面(页面自己用, 不经过任何 JSON 接口),
    // 这样 /api/state 就能只回掩码而不影响仪表盘的复制/写操作。
    let html
    try { html = dashboardHtml() }
    catch (e) { return json(res, 500, { error: '仪表盘文件读取失败: ' + ((e && e.message) || e) }) }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    return res.end(html)
  }
  // /healthz —— 浅检回答"存活", ?deep=1 再回答"就绪"(见上面 probeProxy/probeUpstream 的注释)
  if (url.pathname === '/healthz') {
    const enabled = CFG.providers.filter((p) => p.enabled !== false)
    const base = { ok: true, alive: true, version: VERSION, providers: CFG.providers.length, enabled: enabled.length }
    if (url.searchParams.get('deep') !== '1') return json(res, 200, base)
    const needProxy = enabled.some((p) => p.needs_proxy) && !!CFG.proxy
    const proxy = CFG.proxy
      ? (needProxy ? await probeProxy(CFG.proxy) : { configured: true, needed: false, ok: true })
      : { configured: false, needed: false, ok: true }
    const upstreams = await mapLimit(enabled, 4, (p) => probeUpstream(p))
    const reachable = upstreams.filter((x) => x.ok).length
    // 就绪 = 至少有一家配了、至少有一家能连上、且需要代理时代理端口是开的。
    // 全连不上时返回 503, 让"活着但干不了活"这件事在状态码上就看得见。
    const ready = enabled.length > 0 && reachable > 0 && proxy.ok
    return json(res, ready ? 200 : 503, {
      ...base, ok: ready, ready, deep: true,
      proxy, upstreams, reachable_upstreams: reachable,
      reason: ready ? undefined
        : enabled.length === 0 ? '没有启用的供应商'
          : !proxy.ok ? `代理不可达(${proxy.host}:${proxy.port}) —— 需要代理的厂商全部会失败`
            : '所有上游都连不上(检查网络 / 代理是否开启)',
    })
  }
  // 浏览器/爬虫的自动探测路径。不处理的话会落到最后的 401(鉴权拦截), 打开仪表盘时
  // 控制台就多一条"401 Unauthorized"的红色报错, 看着像 Key 出了问题 —— 其实只是要图标。
  // 图标本身已内嵌在 dashboard.html 里, 这里只是给别的客户端一个干净回应。
  if (url.pathname === '/favicon.ico' || url.pathname === '/robots.txt') { res.writeHead(204); return res.end() }
  // /metrics —— Prometheus 文本格式(零依赖手写, 不引任何库)。
  // 定位与 /healthz 相同: 只读、免鉴权、**不含任何密钥**。
  // 数据全部来自内存里已有的聚合(STATS / metricsState / CFG.providers), 不额外计算任何东西,
  // 所以它没有维护成本 —— 这也是"该不该加"的唯一判据: 加一个没人看的指标, 就是纯负债。
  if (url.pathname === '/metrics') {
    const esc = (s) => String(s == null ? '' : s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, ' ')
    const L = []
    const metric = (name, help, type, lines) => {
      if (!lines.length) return
      L.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`, ...lines)
    }
    const uptime = Math.round((Date.now() - new Date(STATS.startedAt).getTime()) / 1000)
    metric('xiaoji_uptime_seconds', '网关进程运行时长(秒)', 'gauge', [`xiaoji_uptime_seconds ${uptime}`])
    // 进程内累计(自本次启动起)
    metric('xiaoji_requests_total', '本进程内累计请求数', 'counter', [
      `xiaoji_requests_total{result="ok"} ${STATS.success || 0}`,
      `xiaoji_requests_total{result="fail"} ${STATS.fail || 0}`,
      `xiaoji_requests_total{result="fallback"} ${STATS.fallbacks || 0}`,
      `xiaoji_requests_total{result="candidate_fail"} ${STATS.candidateFail || 0}`,
      `xiaoji_requests_total{result="stream_abort"} ${STATS.streamAbort || 0}`,
    ])
    metric('xiaoji_tokens_total', '本进程内累计近似 token 数', 'counter', [`xiaoji_tokens_total ${STATS.tokens || 0}`])
    // 窗口内(默认 24h, 与 /api/metrics 同一口径)。abort 单列 —— 用户自己点停止不算模型失败。
    const series = metricsSeries(24)
    const win = series.reduce((a, b) => ({ n: a.n + b.n, ok: a.ok + b.ok, fail: a.fail + b.fail, abort: a.abort + b.abort }), { n: 0, ok: 0, fail: 0, abort: 0 })
    metric('xiaoji_window_requests', '最近 24 小时请求数(按结果)', 'gauge', [
      `xiaoji_window_requests{result="ok"} ${win.ok}`,
      `xiaoji_window_requests{result="fail"} ${win.fail}`,
      `xiaoji_window_requests{result="abort"} ${win.abort}`,
    ])
    const ov = metricsOverall(24)
    metric('xiaoji_request_duration_ms', '最近 24 小时请求耗时(合并样本后算的分位)', 'gauge', [
      ...(ov.ms_p50 != null ? [`xiaoji_request_duration_ms{quantile="0.5"} ${ov.ms_p50}`] : []),
      ...(ov.ms_p95 != null ? [`xiaoji_request_duration_ms{quantile="0.95"} ${ov.ms_p95}`] : []),
      ...(ov.ms_avg != null ? [`xiaoji_request_duration_ms{quantile="avg"} ${ov.ms_avg}`] : []),
    ])
    metric('xiaoji_ttfb_ms_avg', '最近 24 小时平均首字节耗时(毫秒)', 'gauge', ov.ttfb_avg != null ? [`xiaoji_ttfb_ms_avg ${ov.ttfb_avg}`] : [])
    // 逐供应商: 只看"现在能不能用", 不堆历史
    const now = Date.now()
    metric('xiaoji_provider_up', '供应商是否参与路由(1=参与, 0=已停用)', 'gauge',
      CFG.providers.map((p) => `xiaoji_provider_up{provider="${esc(p.name)}"} ${p.enabled === false ? 0 : 1}`))
    metric('xiaoji_provider_cooldown_seconds', '供应商级冷却剩余秒数(0=未冷却)', 'gauge',
      CFG.providers.map((p) => `xiaoji_provider_cooldown_seconds{provider="${esc(p.name)}"} ${Math.max(0, Math.round(((p.cooldownUntil || 0) - now) / 1000))}`))
    metric('xiaoji_provider_models', '供应商已接入模型数(按状态)', 'gauge',
      CFG.providers.flatMap((p) => {
        const models = providerModels(p)
        const blocked = Object.keys(p.blocked || {}).filter((m) => models.includes(m)).length
        const cooling = models.filter((m) => modelCooling(p, m, now)).length
        return [
          `xiaoji_provider_models{provider="${esc(p.name)}",state="enabled"} ${models.length}`,
          `xiaoji_provider_models{provider="${esc(p.name)}",state="blocked"} ${blocked}`,
          `xiaoji_provider_models{provider="${esc(p.name)}",state="cooling"} ${cooling}`,
        ]
      }))
    // 窗口内请求数按供应商(metricsState 里现成的 prov 计数, 不额外统计)
    const provHits = {}
    for (const h of series) for (const [name, n] of Object.entries(h.prov || {})) provHits[name] = (provHits[name] || 0) + n
    metric('xiaoji_provider_requests', '最近 24 小时该供应商承担的请求数', 'gauge',
      Object.entries(provHits).map(([name, n]) => `xiaoji_provider_requests{provider="${esc(name)}"} ${n}`))
    res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8', 'cache-control': 'no-store' })
    return res.end(L.join('\n') + '\n')
  }
  if (url.pathname === '/api/stats') {
    const cat = loadCatalog()
    return json(res, 200, {
      ...STATS,
      catalog_updated_at: cat ? cat.updated_at : null,
      providers: CFG.providers.map((p) => ({ name: p.name, ok: p.ok || 0, err: p.err || 0, models: providerModels(p).length })),
    })
  }

  // —— Ollama 原生端点: 路径以 /api/ 开头, 必须在管理接口块之前拦截 ——
  if (url.pathname === '/api/tags' && req.method === 'GET') {
    if (!authedAny(req, url)) return json(res, 401, { error: '无效的网关 Key' })
    const models = [{ model: 'auto' }]
    for (const p of CFG.providers) for (const m of providerModels(p)) models.push({ model: `${p.name}/${m}` })
    return json(res, 200, { models })
  }
  if ((url.pathname === '/api/chat' || url.pathname === '/api/generate') && req.method === 'POST') return serveWithSlot(req, res, () => serveNative(req, res, url, 'ollama', url.pathname === '/api/generate' ? 'generate' : 'chat'))

  // 管理 API: 服务只监听 127.0.0.1, 本机访问即可信
  if (url.pathname.startsWith('/api/')) {
    // 管理令牌闸门(见 adminAuthed): 默认 mode='local' 时恒真, 行为与改造前一致。
    // 放在 CSRF 检查**之前** —— 令牌不对就没必要再谈 content-type, 而且先判令牌能少暴露一点信息。
    if (!adminAuthed(req)) {
      return json(res, 401, { error: { code: 'admin_token_required', message: '该网关已启用管理令牌模式（config.json 的 auth.mode=token），请在请求头带上 x-admin-token' }, request_id: req.__rid })
    }
    // CSRF 防护: 写操作强制要求 JSON content-type。
    // 浏览器跨站的"简单请求"只能用 text/plain 等类型, 会被这里挡掉;
    // 带 application/json 的跨站请求会触发预检, 而 /api 不下发 CORS 头 -> 同样过不来。
    if (req.method === 'POST' && !String(req.headers['content-type'] || '').includes('application/json')) {
      return json(res, 415, { error: 'content-type 必须为 application/json' })
    }
    // 写操作额外要求网关 Key: /update 能改供应商配置, /unblock 能把已确认收费的模型从拉黑名单
    // 放回可用池 —— 这是防扣费链路的人工开关, 只靠"只监听 127.0.0.1"挡不住本机脚本/恶意扩展。
    // 读操作(GET)保持开放: 仪表盘要先从 /api/state 拿到 Key 才签得出后续写请求, 这里不能自锁。
    if (req.method === 'POST' && !authedAny(req, url)) {
      return json(res, 401, { error: '管理类写操作需要网关 Key' })
    }
    // 通过鉴权的写操作 = 配置可能变了 -> /v1/models 缓存立刻失效。
    // 放这里而不是 saveConfig 里: saveConfig 每次请求成败都会被调, 挂那儿等于没缓存。
    if (req.method !== 'GET') MODELS_CACHE.at = 0
    let bodyStr = ''
    try { bodyStr = await readBodyStr(req) }
    catch (e) { return json(res, (e && e.status) || 400, { error: (e && e.message) || '请求体读取失败' }) }
    // ⚠ 以前这里没 await: handleAdmin 内部抛错会走 unhandledRejection, 且该请求可能永不响应。
    try { return await handleAdmin(req, res, url, bodyStr) }
    catch (e) {
      console.error('[admin]', (e && e.stack) || e)
      if (!res.writableEnded) json(res, 500, { error: '管理接口异常: ' + ((e && e.message) || e) })
      return
    }
  }

  // 模型 API: 需要统一网关 Key
  if (!authed(req) && !authedAny(req, url)) return json(res, 401, { error: { message: '无效的网关 Key', request_id: rid } })

  // —— 原生协议端点(Anthropic / Gemini / Ollama), 各自鉴权字段不同, 统一校验后转 OpenAI 链 ——
  if (url.pathname === '/v1/responses' && req.method === 'POST') return serveWithSlot(req, res, () => serveNative(req, res, url, 'responses'))
  if (url.pathname === '/v1/messages' && req.method === 'POST') return serveWithSlot(req, res, () => serveNative(req, res, url, 'anthropic'))
  if (url.pathname === '/v1/messages/count_tokens' && req.method === 'POST') {
    let bodyStr = ''
    try { bodyStr = await readBodyStr(req) }
    catch (e) { return json(res, (e && e.status) || 400, { error: { message: (e && e.message) || '请求体读取失败' } }) }
    let raw = {}
    try { raw = JSON.parse(bodyStr) } catch {}
    const approx = Math.ceil(JSON.stringify(raw.messages || '').length / 4)
    return json(res, 200, { input_tokens: approx })
  }
  const gm = url.pathname.match(/^\/(?:v1beta\/|v1\/)?models\/([^:]+):(generateContent|streamGenerateContent)$/)
  if (gm && req.method === 'POST') return serveWithSlot(req, res, () => serveNative(req, res, url, 'gemini'))
  if (url.pathname === '/v1/models') {
    // 30s 内存缓存(见 MODELS_CACHE 定义处): 客户端启动时会连打好几次, 而这里要遍历
    // 7 家 × 上百个模型、给每个模型生成"厂商/模型"与裸名两条记录再序列化, 重复做没意义。
    if (MODELS_CACHE.body && Date.now() - MODELS_CACHE.at < MODELS_TTL_MS) return json(res, 200, MODELS_CACHE.body)
    const data = [{ id: 'auto', object: 'model', owned_by: 'xiaoji-free-gateway' }]
    // 别名排最前: 它们是用户自己配的"熟名字", 客户端下拉里应该一眼就能选到。
    // x_alias 是自定义字段(非 OpenAI 规范), 认它的客户端能显示"这名字实际指到哪", 不认的直接忽略。
    for (const [k, v] of Object.entries(CFG.aliases || {})) data.push({ id: k, object: 'model', owned_by: 'xiaoji-alias', x_alias: v })
    // 路由组紧随别名: 同样是用户自己起的名字, 下拉里要能选到。
    // x_group 是自定义字段(非 OpenAI 规范), 认它的客户端能显示"这个组包含哪些模型"。
    for (const [k, v] of Object.entries(CFG.groups || {})) data.push({ id: k, object: 'model', owned_by: 'xiaoji-group', x_group: v })
    for (const p of CFG.providers) {
      for (const m of providerModels(p)) {
        // x_tools: 该模型**明确不支持** function calling 时才带(判据来自实测学习, 见 modelSupportsTools)。
        // 刻意不给支持的模型标 x_tools:true —— 那会被读成"官方保证", 而我们的依据只是"还没撞到它拒收"。
        const noTools = !modelSupportsTools(p, m)
        // x_vision: 同理, 只在**实测确知**不支持图片时才带(见 modelVisionBlocked)。
        // 也刻意不标 x_vision:true —— 名字启发式判"可能支持"不是保证, 标了会被读成官方承诺。
        const noVision = modelVisionBlocked(p, m)
        const flags = { ...(noTools ? { x_tools: false } : {}), ...(noVision ? { x_vision: false } : {}) }
        data.push({ id: `${p.name}/${m}`, object: 'model', owned_by: p.name, ...flags })
        data.push({ id: m, object: 'model', owned_by: p.name, ...flags })
      }
    }
    MODELS_CACHE.body = { object: 'list', data }
    MODELS_CACHE.at = Date.now()
    return json(res, 200, MODELS_CACHE.body)
  }
  if (url.pathname === '/v1/chat/completions' && req.method === 'POST') {
    let bodyStr = ''
    try { bodyStr = await readBodyStr(req) }
    catch (e) { return json(res, (e && e.status) || 400, { error: { message: (e && e.message) || '请求体读取失败' } }) }
    return serveWithSlot(req, res, () => handleChat(req, res, null, bodyStr))
  }
  // 未实现的 OpenAI 端点: 明确回 501 + 说明, 而不是落到泛化 404。
  // 501="本网关不提供这个能力"(只聚合文字对话), 404="路径写错了" —— 两者混在一起时,
  // 客户端(如 Cursor 探测 embeddings)只会看到"未知路径", 让人以为是自己配错了。
  if (NOT_IMPLEMENTED_RE.some((re) => re.test(url.pathname))) {
    return json(res, 501, {
      error: {
        code: 'not_implemented',
        message: `本网关只聚合文字对话模型，${url.pathname} 未实现。可用端点: /v1/chat/completions、/v1/responses、/v1/models、/v1/messages、/v1/messages/count_tokens、/v1beta/models/<model>:generateContent、/api/chat`,
      },
    })
  }
  json(res, 404, { error: { message: `未知路径 ${url.pathname}` } })
})

// 读取请求体。⚠ 原实现超 4MB 后**静默丢弃**剩余字节且不报错 —— 用户拿到的是"JSON 解析失败",
// 完全看不出真实原因(请求体太大); 而且没有读取超时, 慢速请求能长期占着连接。
// 现在: 预检 content-length → 超限立刻 413; 累加超限同样 413; 30s 读不到完整请求体 → 408。
// ⚠ 超限时用 req.pause() 而不是 req.destroy(): destroy 会把 socket 一起掐掉, 客户端只能看到
// "连接被重置"(fetch failed), 拿不到 413 和原因 —— 等于白做了这个提示。
function readBodyStr(req, limit = 4 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const tooLarge = () => Object.assign(new Error(`请求体超过 ${Math.round(limit / 1024 / 1024)}MB 上限`), { status: 413 })
    const stopReading = () => { try { req.pause() } catch {} }
    const cl = Number(req.headers['content-length'] || 0)
    if (cl > limit) { stopReading(); return reject(tooLarge()) }
    let s = '', over = false
    const timer = setTimeout(() => {
      stopReading()
      reject(Object.assign(new Error('读取请求体超时(30s)'), { status: 408 }))
    }, 30000)
    const settle = (fn, v) => { clearTimeout(timer); fn(v) }
    req.on('data', (c) => {
      if (over) return
      s += c
      if (s.length > limit) { over = true; stopReading(); settle(reject, tooLarge()) }
    })
    req.on('end', () => settle(resolve, s))
    req.on('error', (e) => settle(reject, e))
  })
}

// 兜底: 任何未捕获异常只记日志、不杀进程。
// 教训: 一个流式分支的 ReferenceError 曾把整个网关打死, 本地网关宁可坏一次请求也别坏全部。
process.on('uncaughtException', (e) => console.error('[uncaught]', e && e.stack || e))
process.on('unhandledRejection', (e) => console.error('[unhandled]', e && e.stack || e))

// 日志体积保护: 已由文件顶部的 logger 接管(按大小滚动 + 保留历史)。
// 这里只做一件事: 老版本留在项目根目录的 server.log 不再写入, 但它可能还有内容 ——
// 保留原地不动, 不删用户的历史日志。启动脚本 [5] 看的是 logs\xiaoji.log。

// 退出前把"防抖中"的状态落盘。没有它, 300ms/800ms 防抖窗口里的改动会随进程一起消失 ——
// 而 config.json 存着冷却状态与拉黑名单, 丢了等于防扣费防线被重置回出厂状态。
function flushAll() {
  try {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; saveDirtyAt = 0; writeJsonAtomic(CONFIG_PATH, CFG) }
  } catch (e) { console.error('[config] 退出落盘失败', (e && e.message) || e) }
  try {
    if (usageSaveTimer) { clearTimeout(usageSaveTimer); usageSaveTimer = null; writeJsonAtomic(USAGE_PATH, usageRecords.slice(0, USAGE_CAP), 0) }
  } catch (e) { console.warn('[usage] 退出落盘失败', (e && e.message) || e) }
  try {
    if (metricsSaveTimer) { clearTimeout(metricsSaveTimer); metricsSaveTimer = null; writeJsonAtomic(METRICS_PATH, metricsState, 0) }
  } catch (e) { console.warn('[metrics] 退出落盘失败', (e && e.message) || e) }
}
// ⚠ Windows 现实: 本机没有真正的信号, 小鸡开关.bat 停止网关用的是 taskkill /F(硬杀),
// 所以下面的 exit 钩子不会执行、gateway.pid 会残留。它因此只当"调试时查 PID"用,
// 存活判断一律以 netstat 端口监听 / /healthz 为准, 不要拿 pid 文件当权威。
// (SIGINT/SIGTERM 钩子对"控制台里 Ctrl+C"和类 Unix 环境仍然有效。)
process.on('exit', () => { flushAll(); try { fs.unlinkSync(PID_PATH) } catch {} })
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => { console.log(`[exit] 收到 ${sig}，落盘后退出`); flushAll(); process.exit(0) })
}

// 端口占用必须明确报错退出。
// 原实现没有 'error' 监听 → EADDRINUSE 走 uncaughtException 只记一行日志, 进程存活但
// **根本没在监听**(假活), 而 小鸡开关.bat 用 netstat 判断还会显示"运行中", 极难排查。
server.on('error', (e) => {
  if (e && e.code === 'EADDRINUSE') {
    console.error(`[fatal] 端口 ${CFG.port} 已被占用，网关未启动。请先停止占用进程（双击 小鸡开关.bat 选 [2]），或改 config.json 里的 port。`)
  } else {
    console.error('[fatal] 服务启动失败:', (e && e.stack) || e)
  }
  process.exit(1)
})

// 监听地址。默认**硬绑 127.0.0.1**（不对外网暴露）—— 这是项目的安全姿态，不改默认值。
// 只有容器/NAS 场景才需要覆盖：容器里 127.0.0.1 只对容器自身可见，必须绑 0.0.0.0
// 才能被宿主机的端口映射访问到。所以只开放环境变量 HOST，而不是写进 config.json ——
// 免得"图方便"把安全姿态变成默认行为。非环回地址会在启动横幅上显式告警。
const HOST = process.env.HOST || '127.0.0.1'

server.listen(CFG.port, HOST, () => {
  // 记录 PID: 小鸡开关.bat 用它区分"真在监听"与"进程还在但监听失败"的假活状态。
  try { fs.writeFileSync(PID_PATH, String(process.pid)) } catch {}
  console.log('==================================================')
  console.log(`  小鸡免费模型 XiaoJi Free Model  v${VERSION}`)
  console.log('  本地免费大模型聚合网关')
  console.log(`  仪表盘:       http://localhost:${CFG.port}`)
  console.log(`  OpenAI 端点:  http://localhost:${CFG.port}/v1`)
  if (HOST !== '127.0.0.1' && HOST !== 'localhost' && HOST !== '::1') {
    console.log(`  ⚠ 监听地址: ${HOST}（非环回）—— 已超出"只给本机用"的默认安全边界，`)
    console.log('    请确认前面有反向代理/防火墙，并考虑把 config.json 的 auth 改成 token 模式。')
  }

  // ⚠ 只打印掩码（2026-09-26 修）：这里原来打**完整 Key**，而 server.mjs 的日志会落盘到
  //   logs/xiaoji.log（leveled + 5 个滚动备份）—— 实测那份日志里躺着 **50 处明文 Key**，
  //   直接违反项目自己的红线"不得记录明文网关 Key"（连免鉴权的 /api/state 都只回掩码）。
  //   而 bat 是**隐藏窗口启动**（VBS: shell.Run(cmdLine, 0, False)），用户根本看不到这一行，
  //   打完整值只有泄漏风险、没有收益 —— 要复制 Key 时仪表盘「统一出口」卡上有复制按钮。
  console.log(`  统一网关 Key: ${maskKey(CFG.gatewayKey)}（完整值见仪表盘「统一出口」卡）`)
  if (CONFIG_RECOVERED) {
    console.log(`  ⚠ 配置曾损坏: ${CONFIG_RECOVERED.backup ? '已备份为 ' + CONFIG_RECOVERED.backup : ''}${CONFIG_RECOVERED.restoredFrom ? '，已从 ' + CONFIG_RECOVERED.restoredFrom + ' 恢复' : '（未能恢复，当前为空配置）'}`)
  }
  // 管理接口鉴权模式: 这里必须**说清楚**到底生效没有 —— "配了 token 模式却没配令牌"
  // 是最容易自以为安全的情况(以为开了, 其实没开), 沉默等于误导。
  if (effectiveAuthMode() === 'token') console.log('  管理接口鉴权: token 模式（需请求头 x-admin-token）')
  else if (CFG.auth && CFG.auth.mode === 'token') console.log('  ⚠ auth.mode 写了 token 但 auth.token 缺失或短于 16 位 —— 已忽略，仍按 local 运行（本机即可信）')
  if (Number(CFG.maxConcurrent) > 0) console.log(`  入站并发上限: ${CFG.maxConcurrent}（超出的请求排队，队满或排队超时回 503）`)
  console.log('==================================================')
  // 免费白名单: 启动即同步一次(多源), 之后每 30 分钟一次。
  // ⚠ 30 分钟能成立的前提是**条件请求**(见 syncUpstreamWhitelist 的 allNotModified 短路):
  //   源没变就是一次 304(几百字节) + 一次日志, 不重建 hosts、不触发目录扫描。
  //   2026-10-25 之前是固定 6 小时 —— 那时没有条件请求, 每轮都要把 791KB + 5.9MB 全拉一遍。
  syncUpstreamWhitelist().catch((e) => console.warn('[whitelist] 启动同步失败:', (e && e.message) || e))
  // ⚠ 所有定时器都要 unref(): 否则它们会阻止进程自然退出(手动 Ctrl+C 之外的退出路径全被吊住)。
  setInterval(() => syncUpstreamWhitelist().catch((e) => console.warn('[whitelist] 同步失败:', (e && e.message) || e)), WHITELIST_SYNC_MS).unref()
  // 启动后自动扫描一次目录; 之后按 CATALOG_REFRESH_MS 兜底刷新(白名单有变动时会提前触发)
  if (CFG.providers.length) setTimeout(() => refreshCatalogSafe().catch((e) => console.error('[catalog]', e.message)), 3000).unref()
  setInterval(() => { if (CFG.providers.length) refreshCatalogSafe().catch((e) => console.error('[catalog]', e.message)) }, CATALOG_REFRESH_MS).unref()
  // 限时活动公告页巡检: 启动 10s 后跑一次(等白名单/目录先就位), 之后每 2 小时一次。
  // 它是"活动型免费"的唯一自动发现途径 —— 白名单源覆盖不到 B.AI / SenseNova 这类厂商。
  // ⚠ 2026-10-25 由 6h 提到 2h: 活动型免费是**最有时效性**的信息(开始晚了等于没赶上, 结束
  //   晚了等于在拿已收费的模型打请求), 而它只打 6 个公告页, 2 小时一轮完全在礼貌范围内。
  setTimeout(() => watchPromoPages().catch((e) => console.warn('[promo]', e.message)), 10000).unref()
  setInterval(() => watchPromoPages().catch((e) => console.warn('[promo]', e.message)), 2 * 3600 * 1000).unref()
  // 名单巡检: 启动 20s 后跑一次(等白名单同步先落盘), 之后每天一次。
  // 上游源写的"这家免费"只是声称, 巡检负责给出我们自己的旁证(端点通不通 / 模型存不存在)。
  setTimeout(() => patrolWhitelist().catch((e) => console.warn('[patrol]', (e && e.message) || e)), 20000).unref()
  setInterval(() => patrolWhitelist().catch((e) => console.warn('[patrol]', (e && e.message) || e)), PATROL_INTERVAL_H * 3600 * 1000).unref()
})
