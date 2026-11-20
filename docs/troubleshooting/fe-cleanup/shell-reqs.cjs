// 화면을 새로 열 때 나가는 API 요청 수 — 화면 틀이 부르던 미완료 건수(parcel-drafts?limit=1) 요청이 화면마다 있는지
// 가짜 서버(mock 5174). 실행: node shell-reqs.cjs
const { chromium } = require(process.env.PW_CORE ?? 'playwright-core')
const BASE = process.env.BASE ?? 'http://localhost:5174'
const PATHS = ['/', '/orders', '/calls', '/customers', '/companies', '/faqs', '/unanswered', '/personas', '/stats', '/admins']
;(async () => {
  const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' })
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await ctx.newPage()
  await page.goto(BASE + '/login')
  await page.waitForSelector('input')
  const ins = await page.$$('input')
  await ins[0].fill('admin')
  await ins[1].fill('test1234')
  await page.keyboard.press('Enter')
  await page.waitForURL((u) => !u.pathname.startsWith('/login'))
  await page.waitForTimeout(1500)
  let all = 0
  let drafts = 0
  for (const p of PATHS) {
    const seen = []
    const on = (r) => {
      const u = new URL(r.url())
      if (u.pathname.startsWith('/api/')) seen.push(u.pathname + u.search)
    }
    page.on('request', on)
    await page.goto(BASE + p)
    await page.waitForTimeout(2500)
    page.off('request', on)
    const d = seen.filter((u) => u.includes('/parcel-drafts'))
    all += seen.length
    drafts += d.length
    console.log(p.padEnd(12), 'API 요청', String(seen.length).padStart(2), '| 미완료 건수 요청', d.length, d.join(' '))
  }
  console.log('합계: API 요청', all, '| 미완료 건수 요청', drafts)
  await browser.close()
})().catch((e) => {
  console.log('실패:', String(e.message).slice(0, 300))
  process.exit(1)
})
