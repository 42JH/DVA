// 한 화면에 들어오는지 — 화면마다 다섯 크기에서 쪽 전체가 세로 · 가로로 밀리는지(스크롤이 생기는지) 잼. 긴 내용은 안쪽 상자가 스크롤해야 함
// 가짜 서버(mock 5174). 실행: node fit.cjs
const { chromium } = require(process.env.PW_CORE ?? 'playwright-core')
const BASE = process.env.BASE ?? 'http://localhost:5174'
const SIZES = [[1440, 900], [1440, 780], [1920, 950], [1280, 650], [1024, 600]]
const ROUTES = (process.env.ROUTES ?? '/,/orders,/orders?g=COLLECTING&r=all,/calls,/calls/9101,/unanswered,/faqs,/customers,/companies,/companies/18,/personas,/personas/1/tests/7,/stats,/stats/graph,/admins,/me').split(',')
;(async () => {
  const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', ignoreDefaultArgs: ['--hide-scrollbars'] })
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage()
  await page.goto(BASE + '/login')
  await page.waitForSelector('input')
  const ins = await page.$$('input')
  await ins[0].fill('admin')
  await ins[1].fill('test1234')
  await page.keyboard.press('Enter')
  await page.waitForURL((u) => !u.pathname.startsWith('/login'))
  let bad = 0
  for (const r of ROUTES) {
    const out = []
    for (const [w, h] of SIZES) {
      await page.setViewportSize({ width: w, height: h })
      await page.goto(BASE + r)
      await page.waitForTimeout(1500)
      const m = await page.evaluate(() => {
        const d = document.scrollingElement
        const main = document.querySelector('main')
        return { y: d.scrollHeight - window.innerHeight, x: d.scrollWidth - window.innerWidth, main: main ? main.scrollHeight - main.clientHeight : 0, path: location.pathname }
      })
      const over = m.y > 0 || m.x > 0 || m.main > 0
      if (over) bad++
      out.push(`${w}×${h} ${over ? `밀림(세로 ${m.y} 가로 ${m.x} 본문 ${m.main})` : 'ok'}`)
    }
    console.log(r.padEnd(28), out.join(' | '))
  }
  console.log('밀린 곳', bad)
  await browser.close()
})().catch((e) => {
  console.log('실패:', String(e.message).slice(0, 300))
  process.exit(1)
})
