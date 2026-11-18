// 배포 화면 Lighthouse 측정 — 데스크톱 기준, 화면마다 3번, 성능 점수 가운데 값
// 로그인은 Playwright로 한 번 하고, Lighthouse가 같은 Chrome(9222)에 붙어 쿠키를 그대로 씀 (disableStorageReset)
// 실행: 빈 폴더에서 npm i lighthouse@12 playwright-core → 이 파일을 복사 → LH_ID=<아이디> LH_PW=<비밀번호> node run.mjs
//   PW_CORE(playwright-core 경로) · CHROME(chrome.exe 경로)로 바꿀 수 있음. 결과는 옆 out/ 폴더 (화면별 보고서 HTML + summary.json)
import { createRequire } from 'module'
import fs from 'fs'
import lighthouse from 'lighthouse'
import desktop from 'lighthouse/core/config/desktop-config.js'
const require = createRequire(import.meta.url)
const { chromium } = require(process.env.PW_CORE ?? 'playwright-core')

const BASE = 'https://dva-d109.duckdns.org'
const OUT = new URL('./out/', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1')
fs.mkdirSync(OUT, { recursive: true })
const RUNS = 3

// 영구 프로필 = Lighthouse가 여는 탭도 같은 쿠키를 씀 (launch()+newContext는 따로 떨어진 컨텍스트라 로그인이 안 이어짐)
fs.rmSync(OUT + 'profile', { recursive: true, force: true })
const ctx = await chromium.launchPersistentContext(OUT + 'profile', {
  executablePath: process.env.CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  args: ['--remote-debugging-port=9222'],
})
const b = ctx
const p = ctx.pages()[0] ?? (await ctx.newPage())
const cdp = await ctx.newCDPSession(p)

async function measure(name, url) {
  const runs = []
  for (let i = 0; i < RUNS; i++) {
    // 쿠키(로그인)는 두고 HTTP 캐시만 비움 = 첫 방문 기준
    await cdp.send('Network.clearBrowserCache')
    const r = await lighthouse(url, { port: 9222, output: 'html', onlyCategories: ['performance'], disableStorageReset: true }, desktop)
    const a = r.lhr.audits
    runs.push({ score: Math.round(r.lhr.categories.performance.score * 100), fcp: a['first-contentful-paint'].numericValue, lcp: a['largest-contentful-paint'].numericValue, tbt: a['total-blocking-time'].numericValue, cls: a['cumulative-layout-shift'].numericValue, si: a['speed-index'].numericValue, finalUrl: r.lhr.finalDisplayedUrl, html: r.report })
  }
  if (name !== 'login' && runs.some((r) => r.finalUrl.includes('/login'))) throw new Error(`${name}: 로그인 화면으로 넘어감`)
  runs.sort((x, y) => x.score - y.score)
  const mid = runs[1]
  fs.writeFileSync(`${OUT}${name}.html`, mid.html)
  const row = { name, url: mid.finalUrl, scores: runs.map((r) => r.score), score: mid.score, fcp: mid.fcp, lcp: mid.lcp, tbt: mid.tbt, cls: mid.cls, si: mid.si }
  console.log(JSON.stringify(row))
  return row
}

const rows = []
// 로그인 화면은 로그인 전에
rows.push(await measure('login', `${BASE}/login`))

await p.goto(`${BASE}/login`)
await p.fill('input[autocomplete=username]', process.env.LH_ID)
await p.fill('input[type=password]', process.env.LH_PW)
await p.keyboard.press('Enter')
await p.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 15000 })

await p.goto(`${BASE}/calls`)
await p.waitForSelector('a[href^="/calls/"]', { timeout: 15000 }).catch(() => {})
const callHref = await p.evaluate(() => document.querySelector('a[href^="/calls/"]')?.getAttribute('href'))
// 통화 상세 링크가 a가 아니면 첫 줄을 눌러 주소를 얻음
let callUrl = callHref ? BASE + callHref : null
if (!callUrl) {
  await p.locator('tbody tr').first().click().catch(() => {})
  await p.waitForTimeout(1500)
  if (/\/calls\/\w+/.test(p.url())) callUrl = p.url()
}

const pages = [['home', '/'], ['calls', '/calls'], ['call-detail', callUrl], ['orders', '/orders'], ['faqs', '/faqs'], ['stats', '/stats'], ['personas', '/personas']]
for (const [name, path] of pages) {
  if (!path) { console.log(JSON.stringify({ name, skipped: 'no call id' })); continue }
  rows.push(await measure(name, path.startsWith('http') ? path : BASE + path))
}
fs.writeFileSync(`${OUT}summary.json`, JSON.stringify(rows, null, 2))
await b.close()
