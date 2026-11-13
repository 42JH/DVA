// AI 상담가 화면 Lighthouse — 데스크톱 · 첫 방문(매번 캐시 비움) · 화면마다 RUNS번, 원본(lhr)은 <TAG>/<화면>-<회차>.json
// BASE: 측정할 곳. LH_ID · LH_PW가 있으면 로그인부터(실서버 · mock), 없으면 그대로(serve.mjs — 받아 적은 응답이 로그인한 상태)
// 실행: BASE=http://localhost:4180 TAG=before RUNS=3 node audit.mjs
import { createRequire } from 'module'
import fs from 'fs'
import lighthouse from 'lighthouse'
import desktop from 'lighthouse/core/config/desktop-config.js'
const require = createRequire(import.meta.url)
const { chromium } = require(process.env.PW_CORE ?? 'playwright-core')

const BASE = process.env.BASE ?? 'http://localhost:4180'
const TAG = process.env.TAG ?? 'run'
const PORT = Number(process.env.PORT ?? 9333)
const RUNS = Number(process.env.RUNS ?? 3)
const PATHS = (process.env.PATHS ?? '/personas,/personas/1/tests/6,/personas/1/tests/6/A4').split(',')
const OUT = new URL(`./${TAG}/`, import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1')
fs.rmSync(OUT, { recursive: true, force: true })
fs.mkdirSync(OUT, { recursive: true })
const ctx = await chromium.launchPersistentContext(OUT + 'profile', {
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  args: ['--remote-debugging-port=' + PORT],
})
const p = ctx.pages()[0] ?? (await ctx.newPage())
const cdp = await ctx.newCDPSession(p)

if (process.env.LH_ID) {
  await p.goto(`${BASE}/login`)
  await p.waitForSelector('input')
  const ins = await p.$$('input')
  await ins[0].fill(process.env.LH_ID)
  await ins[1].fill(process.env.LH_PW)
  await p.keyboard.press('Enter')
  await p.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 15000 })
} else {
  // 로그인 표시(shared/auth/session.ts)만 넣음 — 세션 확인(/auth/me)은 받아 적은 응답이 답함
  await p.goto(`${BASE}/login`)
  await p.evaluate(() => localStorage.setItem('dva.sessionExpiresAt', new Date(Date.now() + 9 * 3600e3).toISOString()))
}

const mid = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]
const rows = []
for (const path of PATHS) {
  const name = path.replace(/^\//, '').replace(/\//g, '-') || 'home'
  const runs = []
  for (let i = 1; i <= RUNS; i++) {
    await cdp.send('Network.clearBrowserCache')
    const { lhr } = await lighthouse(BASE + path, { port: PORT, disableStorageReset: true, onlyCategories: ['performance', 'accessibility', 'best-practices'] }, desktop)
    if (lhr.finalDisplayedUrl.includes('/login')) throw new Error(`${name}: 로그인 화면으로 넘어감`)
    fs.writeFileSync(`${OUT}${name}-${i}.json`, JSON.stringify(lhr))
    const n = (id) => lhr.audits[id]?.numericValue ?? 0
    const cat = (k) => Math.round(lhr.categories[k].score * 100)
    runs.push({ perf: cat('performance'), a11y: cat('accessibility'), bp: cat('best-practices'), fcp: Math.round(n('first-contentful-paint')), lcp: Math.round(n('largest-contentful-paint')), si: Math.round(n('speed-index')), tbt: Math.round(n('total-blocking-time')), cls: Number(n('cumulative-layout-shift').toFixed(4)), kb: Math.round(n('total-byte-weight') / 1024) })
    console.log(name, i, JSON.stringify(runs.at(-1)))
  }
  const row = { name, runs, mid: Object.fromEntries(Object.keys(runs[0]).map((k) => [k, mid(runs.map((r) => r[k]))])) }
  console.log(name, '중앙값', JSON.stringify(row.mid))
  rows.push(row)
}
fs.writeFileSync(`${OUT}summary.json`, JSON.stringify(rows, null, 1))
await ctx.close()
