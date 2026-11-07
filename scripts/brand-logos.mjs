// post-process: 给 simple-icons 的 SVG 注入品牌色 fill。
// 关键: 不仅要在 <svg> 根上 fill, 还要给每个 <path> 也加 fill ——
// gemini 这类 simple-icons 的 path 完全没有 fill 属性, 依赖根继承,
// 但 <img> 加载 SVG 时根 fill 不会可靠继承到子元素 (实测: 浏览器里渲染成黑)。
// mistral/openrouter/amd/nvidia/... 这类原版带 fill="currentColor" 的,
// 替换成品牌色后本身就显示对了; 但为了统一兜底, 也给它们 path 加一遍 fill。
// groq.svg 自带品牌 fill, 跳过以免覆盖。
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const OUT_DIR = resolve(__dirname, '../assets/logos')

// vendor.name → 品牌色 (按各家官网 VI 取主色; 缺失的不动, 保持默认黑)
// 颜色不在 dashboard.html 里写, 这里给 SVG 内嵌, 浏览器加载 <img> 就直接显示品牌色
const BRANDS = {
  gemini:     '#4285F4',  // Google Gemini 蓝 (官方)
  mistral:    '#FA520F',  // Mistral 橙
  openrouter: '#4F46E5',  // OpenRouter 紫蓝
  ollama:     '#1A1A1A',  // Ollama 主色 (黑白)
  hf:         '#FFD21E',  // Hugging Face 黄
  amd:        '#ED1C24',  // AMD 红
  ovh:        '#123F6D',  // OVH 蓝
  bailian:    '#FF6A00',  // 阿里云橙 (bailian)
  nvidia:     '#76B900',  // NVIDIA 绿
  cloudflare: '#F38020',  // Cloudflare 橙
  deepseek:   '#4D6BFE',  // DeepSeek 蓝
}

for (const [name, color] of Object.entries(BRANDS)) {
  const file = resolve(OUT_DIR, `${name}.svg`)
  if (!existsSync(file)) { console.log(`SKIP ${name} (no file)`); continue }

  let svg = readFileSync(file, 'utf8')

  // 已经注入了品牌色 (fill="#xxxxxx" on root) 且没有 currentColor → 跳过
  if (/fill\s*=\s*["']#[0-9A-Fa-f]{3,8}["']/i.test(svg) && !/currentColor/i.test(svg)) {
    // 但仍然要补 path 上的 fill (这是本轮的关键修复)
    let patched = svg.replace(/<path\b([^>]*?)(\/>|>)/g, (m, attrs, end) => {
      if (/\bfill\s*=/.test(attrs)) return m
      return `<path${attrs} fill="${color}"${end}`
    })
    if (patched !== svg) {
      writeFileSync(file, patched)
      console.log(`FIX  ${name} → +path fill ${color}`)
    } else {
      console.log(`KEEP ${name}`)
    }
    continue
  }

  let newSvg = svg
    // 替换 fill="currentColor" → fill="<color>"
    .replace(/\s+fill\s*=\s*["']currentColor["']/gi, ` fill="${color}"`)
    // 根 <svg> 上加 fill="<color>" (兜底)
    .replace(/<svg\b(?![^>]*\bfill\s*=)/i, `<svg fill="${color}"`)

  // 给每个 <path> 加 fill (如果还没有的话) —— 这是关键, 防止 <img> 渲染时
  // 根 fill 不继承导致子元素变黑
  newSvg = newSvg.replace(/<path\b([^>]*?)(\/>|>)/g, (m, attrs, end) => {
    if (/\bfill\s*=/.test(attrs)) return m
    return `<path${attrs} fill="${color}"${end}`
  })

  writeFileSync(file, newSvg)
  console.log(`OK   ${name} → ${color} (root + path)`)
}