// 一次性脚本：把各家 logo 拉下来落到 assets/logos/，生成 manifest.json
// 拉取源：simple-icons（首选）→ 官网 favicon/svg（多源兜底）。拉不到的 manifest 留 null。
// 保留已有文件，只补缺；新拉的更好可以覆盖。
// 并发拉，每个 URL 重试 3 次，超时 10s。
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const OUT_DIR = resolve(__dirname, '../assets/logos')
mkdirSync(OUT_DIR, { recursive: true })

// 代理：**Node 内置 fetch（undici）不读 HTTP(S)_PROXY**，只有 Node ≥ 24 且显式设
// NODE_USE_ENV_PROXY=1 才生效（本机 v22，所以下面这两行对本脚本的 fetch 毫无作用）。
// 别以为"设了代理就一定走代理"—— 这条以前写在注释里，是错的。
// 需要走代理时的实际做法：先手动把 svg 放进 assets/logos/，或换 Node ≥ 24 再设 NODE_USE_ENV_PROXY=1。
const PROXY = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || ''
if (PROXY) {
  process.env.HTTPS_PROXY = PROXY
  process.env.HTTP_PROXY = PROXY
  if (!process.env.NODE_USE_ENV_PROXY) {
    console.log(`⚠ 检测到代理 ${PROXY}，但 Node ${process.version} 的内置 fetch 不会走它（直连失败时请换 Node ≥24 + NODE_USE_ENV_PROXY=1）`)
  }
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 xiaoji-logo-fetch/1.0'
const SLUG_BASE = 'https://cdn.jsdelivr.net/npm/simple-icons@latest/icons'

// vendor.name -> [simple-icons-slug | null, ...fallback URLs]
// 排序: simple-icons 优先(单色 SVG + 后续 brand-logos.mjs 注入颜色) > 官网 favicon
const SOURCES = {
  groq:        [null,                           'https://groq.com/favicon.svg', 'https://groq.com/favicon.ico'],
  gemini:      ['googlegemini',                 'https://ai.google.dev/favicon.ico', 'https://gemini.google.com/favicon.ico', 'https://deepmind.google/favicon.ico'],
  mistral:     ['mistralai',                    'https://chat.mistral.ai/favicon.ico', 'https://docs.mistral.ai/favicon.ico', 'https://mistral.ai/favicon.svg'],
  openrouter:  ['openrouter',                   'https://openrouter.ai/favicon.ico', 'https://openrouter.ai/favicon.svg'],
  cohere:      ['cohere',                       'https://cohere.com/favicon.ico'],
  kilo:        [null,                           'https://kilo.ai/favicon.ico', 'https://kilo.so/favicon.ico'],
  nvidia:      ['nvidia',                       'https://nvidia.com/favicon.ico'],
  ollama:      ['ollama',                       'https://ollama.com/favicon.ico', 'https://ollama.com/favicon.svg'],
  hf:          ['huggingface',                  'https://huggingface.co/favicon.ico'],
  ovh:         ['ovh',                          'https://ovhcloud.com/favicon.ico'],
  cloudflare:  ['cloudflare',                   'https://cloudflare.com/favicon.ico'],
  siliconflow: [null,                           'https://siliconflow.cn/favicon.ico'],
  zhipu:       [null,                           'https://zhipuai.cn/favicon.ico', 'https://bigmodel.cn/favicon.ico', 'https://zhipu-ai.com/favicon.ico'],
  modelscope:  [null,                           'https://modelscope.cn/favicon.ico', 'https://www.modelscope.cn/favicon.ico'],
  amd:         ['amd',                          'https://www.amd.com/favicon.ico', 'https://amd.com/favicon.svg'],
  sensenova:   [null,                           'https://platform.sensenova.cn/favicon.ico', 'https://sensenova.cn/favicon.ico', 'https://sensenova.cn/favicon.svg'],
  empero:      [null,                           'https://free.empero.org/favicon.ico', 'https://free.empero.org/favicon.svg'],
  llm7:        [null,                           'https://llm7.io/favicon.ico'],
  aionlabs:    [null,                           'https://aionlabs.ai/favicon.ico', 'https://www.aionlabs.ai/favicon.ico'],
  longcat:     [null,                           'https://longcat.chat/favicon.ico', 'https://www.longcat.chat/favicon.ico', 'https://meituan.com/favicon.ico'],
  cerebras:    [null,                           'https://cloud.cerebras.ai/favicon.ico', 'https://cerebras.ai/favicon.ico', 'https://inference.cerebras.ai/favicon.ico'],
  deepseek:    ['deepseek',                     'https://deepseek.com/favicon.ico'],
  kimi:        [null,                           'https://kimi.moonshot.cn/favicon.ico', 'https://kimi.com/favicon.ico'],
  bailian:     ['alibabacloud',                 'https://bailian.console.aliyun.com/favicon.ico'],
  volc:        [null,                           'https://volcengine.com/favicon.ico', 'https://www.volcengine.com/favicon.ico', 'https://volcengine.com/favicon.svg'],
  bai:         [null,                           'https://b.ai/favicon.ico', 'https://api.b.ai/favicon.ico', 'https://www.b.ai/favicon.ico'],
}

async function fetchOnce(url) {
  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'image/svg+xml,image/x-icon,image/png;q=0.9,*/*;q=0.5' },
      redirect: 'follow',
      signal: AbortSignal.timeout(10000),
    })
    if (!r.ok) return null
    const buf = Buffer.from(await r.arrayBuffer())
    if (buf.length < 80) return null
    // 拒绝 HTML 页面（favicon 经常 404 但返回 HTML）
    const head = buf.subarray(0, 200).toString('utf8').trim()
    if (head.startsWith('<!') || head.startsWith('<html') || head.startsWith('<?xml version=')) return null
    const isSvg = head.startsWith('<?xml') || head.startsWith('<svg') || head.includes('<svg')
    const isIco = buf[0] === 0 && buf[1] === 0 && buf[2] === 1 && buf[3] === 0
    const isPng = buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47
    if (!isSvg && !isIco && !isPng) return null
    return { buf, kind: isSvg ? 'svg' : isPng ? 'png' : 'ico' }
  } catch (e) {
    return null
  }
}

async function fetchWithRetry(url, retries = 3) {
  for (let i = 0; i < retries; i++) {
    const r = await fetchOnce(url)
    if (r) return r
    if (i < retries - 1) await new Promise(r => setTimeout(r, 600 + i * 400))
  }
  return null
}

async function fetchOne(name, sources) {
  for (let i = 0; i < sources.length; i++) {
    const s = sources[i]
    if (!s) continue
    const url = s.startsWith('http') ? s : `${SLUG_BASE}/${s}.svg`
    const r = await fetchWithRetry(url)
    if (r) return { ...r, url, idx: i }
  }
  return null
}

// ── 保留已有：manifest.json 现在是**手写维护**的 `{_comment, _brand_color_script, vendors:{...}}` ──
// ⚠ 这里曾经把它当扁平表 `{name: {...}}` 读 —— 于是 `prev['groq']` 永远是 undefined，
//   "保留已有、只补缺"实际变成"把 26 个精选 logo 全部重下并覆盖"：sensenova 是手绘的 4 个 rect、
//   zhipu 是真矢量，重下只会退化成 favicon 位图；而且写回时会把 `vendors` 包装整层丢掉，
//   文档结构当场毁掉。所以两种形状都要认。
const MANIFEST_PATH = resolve(OUT_DIR, 'manifest.json')
const rawManifest = (() => {
  try { return existsSync(MANIFEST_PATH) ? JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) : null } catch { return null }
})()
const prev = (rawManifest && rawManifest.vendors && typeof rawManifest.vendors === 'object')
  ? rawManifest.vendors
  : (rawManifest || {})
// 写回时保留 _comment / _brand_color_script 等顶层键，只替换 vendors 这一层
const wrapper = (rawManifest && rawManifest.vendors) ? { ...rawManifest, vendors: null } : null

const entries = Object.entries(SOURCES)
console.log(`\n=== fetch ${entries.length} vendors (have ${Object.values(prev).filter(Boolean).length}) ===\n`)

// 分批并发（每批 8 个）
const BATCH = 8
const manifest = { ...prev }
let okNew = 0, missNew = 0, keepOld = 0

for (let i = 0; i < entries.length; i += BATCH) {
  const batch = entries.slice(i, i + BATCH)
  await Promise.all(batch.map(async ([name, srcs]) => {
    // 已有记录且文件真在盘上 → 一律不动（连网络都不打）。
    // 记录在但文件被删了 → 当成缺的重新拉，否则 manifest 会指向一个不存在的文件。
    const old = prev[name]
    if (old && old.file && existsSync(resolve(OUT_DIR, old.file))) {
      keepOld++
      console.log(`KEEP ${name.padEnd(13)} ${old.file}  (已有，不覆盖)`)
      return
    }
    const r = await fetchOne(name, srcs)
    if (r) {
      const ext = r.kind === 'svg' ? 'svg' : r.kind === 'png' ? 'png' : 'ico'
      const file = `${name}.${ext}`
      writeFileSync(resolve(OUT_DIR, file), r.buf)
      okNew++
      manifest[name] = { file, source: r.url, kind: r.kind, priority: r.idx }
      console.log(`OK   ${name.padEnd(13)} ${ext}  ${r.buf.length.toString().padStart(7)}B  [${r.idx}] ${r.url}`)
    } else if (!old) {
      manifest[name] = null
      missNew++
      console.log(`MISS ${name.padEnd(13)} -                       (${srcs.filter(Boolean).join(' | ')})`)
    } else {
      // 记录在但文件没了、这次也没拉到 → 保留原记录（不要写成 null，否则下次还得重试）
      keepOld++
      console.log(`MISS ${name.padEnd(13)} -                       文件缺失且重拉失败，保留原记录`)
    }
  }))
}

const outManifest = wrapper ? { ...wrapper, vendors: manifest } : manifest
// 没有任何增删就不写盘：manifest.json 是**手写对齐排版**的文档，
// 无脑 JSON.stringify 会把它整份重排（105 行 insert / 27 行 delete 的纯格式 diff），
// 把真正的内容变化淹没在噪音里。
if (okNew === 0 && missNew === 0) {
  console.log('\n无新增/缺失变化 → manifest.json 未改写（保持手写排版）')
} else {
  writeFileSync(MANIFEST_PATH, JSON.stringify(outManifest, null, 2) + '\n')
}
const totalOk = Object.values(manifest).filter(Boolean).length
console.log(`\nDONE  new=${okNew}  miss=${missNew}  keep_old=${keepOld}  total_ok=${totalOk}/${entries.length}`)