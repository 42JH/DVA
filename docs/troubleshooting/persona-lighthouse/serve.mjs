// 빌드본(dist)을 실서버 nginx처럼 내줌 — /assets는 gzip 5단계 · 30일 캐시, 없는 주소는 index.html
// /api는 record.cjs로 받아 적은 응답을 돌려줌 (API_DELAY ms 뒤 — 실서버처럼 화면이 먼저 그려진 뒤 자료가 오게)
// 실행: node serve.mjs <dist 폴더> <받아 적은 파일> [포트]
import fs from 'fs'
import http from 'http'
import path from 'path'
import zlib from 'zlib'

const [dist, fixtures, port = '4180'] = process.argv.slice(2)
const root = path.resolve(dist)
const api = JSON.parse(fs.readFileSync(fixtures, 'utf8'))
const DELAY = Number(process.env.API_DELAY ?? 80)
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.json': 'application/json', '.txt': 'text/plain' }
const SEC = 128
const WAV = Buffer.alloc(44 + 8000 * SEC, 128)
WAV.write('RIFF', 0), WAV.writeUInt32LE(36 + 8000 * SEC, 4), WAV.write('WAVEfmt ', 8), WAV.writeUInt32LE(16, 16)
WAV.writeUInt16LE(1, 20), WAV.writeUInt16LE(1, 22), WAV.writeUInt32LE(8000, 24), WAV.writeUInt32LE(8000, 28)
WAV.writeUInt16LE(1, 32), WAV.writeUInt16LE(8, 34), WAV.write('data', 36), WAV.writeUInt32LE(8000 * SEC, 40)

http
  .createServer((req, res) => {
    const u = new URL(req.url, 'http://x')
    // 진행 통화 수 스트림 (명세 11/04 §4): 붙자마자 현재값, 5초마다 heartbeat
    if (u.pathname.endsWith('/calls/active-count/stream')) {
      const send = (event, data) => res.write(`event: ${event}
data: ${JSON.stringify({ ...data, observedAt: new Date().toISOString() })}

`)
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      send('active-call-count', { activeCallCount: 2 })
      const beat = setInterval(() => send('heartbeat', {}), 5000)
      return req.on('close', () => clearInterval(beat))
    }
    // 녹음: 2분짜리 무음 WAV (8kHz · 8bit · 약 1MB) — 재생기가 부분 요청(Range)으로 받음
    if (u.pathname.endsWith('/audio')) {
      const [from, to] = (/bytes=(\d+)-(\d*)/.exec(req.headers.range ?? '') ?? []).slice(1).map(Number)
      const part = WAV.subarray(from || 0, to ? to + 1 : WAV.length)
      res.writeHead(req.headers.range ? 206 : 200, { 'content-type': 'audio/wav', 'accept-ranges': 'bytes', 'content-length': part.length, ...(req.headers.range && { 'content-range': `bytes ${from}-${from + part.length - 1}/${WAV.length}` }) })
      return res.end(part)
    }
    if (u.pathname.startsWith('/api/')) {
      const hit = api[`${req.method} ${u.pathname}${u.search}`] ?? api[`${req.method} ${u.pathname}`]
      if (!hit) console.log('없는 응답', req.method, req.url)
      return setTimeout(() => {
        res.writeHead(hit?.status ?? 404, { 'content-type': hit?.type || 'application/json' })
        res.end(hit ? Buffer.from(hit.body, 'base64') : '{}')
      }, DELAY)
    }
    let file = path.join(root, decodeURIComponent(u.pathname))
    if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(root, 'index.html')
    const head = { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' }
    if (u.pathname.startsWith('/assets/')) head['cache-control'] = 'public, max-age=2592000, immutable'
    let body = fs.readFileSync(file)
    if (/\.(js|css|svg|json|html)$/.test(file) && /gzip/.test(req.headers['accept-encoding'] ?? '')) {
      body = zlib.gzipSync(body, { level: 5 })
      head['content-encoding'] = 'gzip'
      head.vary = 'Accept-Encoding'
    }
    res.writeHead(200, head)
    res.end(body)
  })
  .listen(Number(port), () => console.log('http://localhost:' + port, root))
