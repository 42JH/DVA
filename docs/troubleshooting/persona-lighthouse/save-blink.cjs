// 띠가 없는 평소 상태에서 프롬프트를 고쳐 저장할 때 카드가 '불러오는 중'으로 가려지는지 — 가짜 서버(mock 5174)에서
// 실행: node save-blink.cjs
const { chromium } = require(process.env.PW_CORE ?? 'playwright-core')
const BASE = process.env.BASE ?? 'http://localhost:5174'
;(async () => {
  const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' })
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage()
  const runs = []
  page.on('request', (r) => r.url().endsWith('/persona-check/runs') && r.method() === 'GET' && runs.push(Date.now()))
  await page.goto(BASE + '/login')
  await page.waitForSelector('input')
  const ins = await page.$$('input')
  await ins[0].fill('admin')
  await ins[1].fill('test1234')
  await page.keyboard.press('Enter')
  await page.waitForURL((u) => !u.pathname.startsWith('/login'))
  await page.goto(BASE + '/personas')
  await page.waitForSelector('article textarea')
  // 평소 상태로: 고친 내용을 통화에 반영해 둠 (가짜 서버는 몇 초 뒤 반영을 끝냄)
  await page.evaluate(async () => {
    await fetch('/api/personas/1/activate', { method: 'POST' })
    for (;;) {
      const p = (await (await fetch('/api/personas?limit=100&offset=0')).json()).data[0]
      if (!p.pendingVersion && p.activeVersion?.version === p.headVersion.version) return
      await new Promise((r) => setTimeout(r, 500))
    }
  })
  runs.length = 0
  await page.reload()
  await page.waitForSelector('article textarea')
  await page.waitForTimeout(1500)
  console.log('평소 상태로 연 화면 — 띠:', (await page.locator('article [class*="fff9ef"]').count()) ? '있음' : '없음', '· 시험 결과 요청', runs.length, '번')
  await page.evaluate(() => {
    const seen = (window.__seen = [])
    let last = ''
    const tick = () => {
      const a = document.querySelector('article')
      const band = a?.querySelector('[class*="fff9ef"]')
      const now = [
        /불러오는 중/.test(a?.innerText ?? '') ? '불러오는 중' : a?.querySelector('textarea') ? '카드' : '칸 없음',
        band ? band.innerText.replace(/\s+/g, ' ').slice(0, 20) : '띠 없음',
      ].join(' · ')
      if (now !== last) seen.push(`${Math.round(performance.now())}ms ${(last = now)}`)
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })
  const box = page.locator('article textarea').first()
  await box.fill((await box.inputValue()) + ' 고침')
  await page.locator('article header button', { hasText: '저장' }).click()
  await page.waitForTimeout(2500)
  console.log('저장 뒤:', (await page.evaluate(() => window.__seen)).join('  →  '))
  console.log('저장 뒤 시험 결과 요청', runs.length, '번')
  await browser.close()
})()
