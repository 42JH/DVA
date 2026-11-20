// 전 항목 점검 — 로그인한 채 화면마다 1회, 4개 카테고리, 실패 감사와 원인 목록만 뽑음
import { createRequire } from 'module'
import fs from 'fs'
import lighthouse from 'lighthouse'
import desktop from 'lighthouse/core/config/desktop-config.js'
const require = createRequire(import.meta.url)
const { chromium } = require(process.env.PW_CORE ?? 'playwright-core')

const BASE = process.env.LH_BASE ?? (() => { throw new Error('LH_BASE(관리자 웹 주소)가 필요합니다') })()
const OUT = new URL('./audit/', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1')
if (process.env.EXTRA !== '1') fs.rmSync(OUT, { recursive: true, force: true })
fs.mkdirSync(OUT, { recursive: true })
const ctx = await chromium.launchPersistentContext(OUT + (process.env.EXTRA === '1' ? 'profile2' : 'profile'), {
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  args: ['--remote-debugging-port=' + (process.env.EXTRA === '1' ? 9223 : 9222)],
})
const p = ctx.pages()[0] ?? (await ctx.newPage())
const cdp = await ctx.newCDPSession(p)
const short = (u) => String(u ?? '').replace(BASE, '').slice(0, 90)

async function audit(name, url) {
  await cdp.send('Network.clearBrowserCache')
  const r = await lighthouse(url, { port: process.env.EXTRA === '1' ? 9223 : 9222, output: 'html', disableStorageReset: true, onlyCategories: ['performance', 'accessibility', 'best-practices', 'seo'] }, desktop)
  fs.writeFileSync(`${OUT}${name}.html`, r.report)
  const l = r.lhr
  const cats = Object.fromEntries(Object.entries(l.categories).map(([k, c]) => [k, Math.round(c.score * 100)]))
  const bad = []
  for (const [k, c] of Object.entries(l.categories)) {
    for (const ref of c.auditRefs) {
      const a = l.audits[ref.id]
      if (!a || a.scoreDisplayMode === 'notApplicable' || a.scoreDisplayMode === 'manual') continue
      const failing = a.score !== null && a.score < 0.9
      const info = a.scoreDisplayMode === 'informative' && a.details?.items?.length
      if (!failing && !(info && k === 'best-practices')) continue
      const items = (a.details?.items ?? []).slice(0, 6).map((i) => [short(i.url ?? i.source?.url ?? i.node?.snippet ?? i.description ?? i.directive ?? i.severity ?? ''), i.wastedBytes ? Math.round(i.wastedBytes / 1024) + 'KB' : i.wastedMs ? Math.round(i.wastedMs) + 'ms' : i.totalBytes ? Math.round(i.totalBytes / 1024) + 'KB' : ''].filter(Boolean).join(' '))
      bad.push({ cat: k, id: ref.id, title: a.title, score: a.score, value: a.displayValue ?? '', items })
    }
  }
  const row = { name, url: l.finalDisplayedUrl, cats, bad }
  console.log(JSON.stringify(row))
  return row
}

// EXTRA=1 → 남은 화면만 (첫 판에서 빠진 화면)
const EXTRA = process.env.EXTRA === '1'
const rows = EXTRA ? [await audit('signup', `${BASE}/signup`)] : [await audit('login', `${BASE}/login`)]
await p.goto(`${BASE}/login`)
await p.fill('input[autocomplete=username]', process.env.LH_ID)
await p.fill('input[type=password]', process.env.LH_PW)
await p.keyboard.press('Enter')
await p.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 15000 })
let companyPath = null
if (EXTRA) {
  await p.goto(`${BASE}/companies`)
  await p.waitForSelector('a[href^="/companies/"]', { timeout: 15000 }).catch(() => {})
  companyPath = await p.evaluate(() => document.querySelector('a[href^="/companies/"]')?.getAttribute('href'))
  if (!companyPath) {
    await p.locator('tbody tr').first().click().catch(() => {})
    await p.waitForTimeout(1500)
    if (/\/companies\/\w+/.test(p.url())) companyPath = new URL(p.url()).pathname
  }
}
const list = EXTRA
  ? [['unanswered', '/unanswered'], ['company-detail', companyPath], ['stats-wait', '/stats/response-wait'], ['stats-dropoff', '/stats/stage-dropoffs'], ['admins', '/admins'], ['me', '/me']].filter(([, x]) => x)
  : null
for (const [name, path] of list ?? [['home', '/'], ['calls', '/calls'], ['call-detail', '/calls/530'], ['orders', '/orders'], ['faqs', '/faqs'], ['customers', '/customers'], ['companies', '/companies'], ['stats', '/stats'], ['personas', '/personas']]) {
  const row = await audit(name, BASE + path)
  if (row.url.includes('/login')) throw new Error(`${name}: 로그인 화면으로 넘어감`)
  rows.push(row)
}
fs.writeFileSync(`${OUT}${EXTRA ? 'audit-extra' : 'audit'}.json`, JSON.stringify(rows, null, 1))
await ctx.close()
