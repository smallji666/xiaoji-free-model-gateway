// 假上游：用于对冲请求的量化测试。
//   node fake-up.cjs <port> <delayMs>
// /v1/models 固定返回空列表 —— 这样网关的 pool_sync 不会改写我们的测试路由池
// （scanProvider 扫到 0 个模型会走"可疑"分支直接跳过，完全不干扰）。
// /v1/chat/completions 延迟 <delayMs> 后返回，支持 stream。
const http = require('http')
const port = Number(process.argv[2])
const delay = Number(process.argv[3] || 0)

http.createServer((req, res) => {
  let body = ''
  req.on('data', (c) => { body += c })
  req.on('end', () => {
    if (req.url.includes('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ object: 'list', data: [] }))
    }
    setTimeout(() => {
      if (res.writableEnded || res.destroyed) return
      const stream = /"stream"\s*:\s*true/.test(body)
      if (stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.write('data: ' + JSON.stringify({ id: 'x', object: 'chat.completion.chunk', model: 'm', choices: [{ index: 0, delta: { content: 'hi' } }] }) + '\n\n')
        res.write('data: [DONE]\n\n')
        res.end()
      } else {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({
          id: 'x', object: 'chat.completion', model: 'm',
          choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }))
      }
    }, delay)
  })
}).listen(port, '127.0.0.1', () => console.log(`[fake-up] :${port} delay=${delay}ms`))
