// 전 화면 모습 기록 — 가짜 서버(mock 5174)에서 화면마다 글(innerText)과 그림을 남김. 정리 전후를 compare.cjs로 대조
// 실행: node snap.cjs <남길 폴더>
const { chromium } = require(process.env.PW_CORE ?? 'playwright-core')
const fs = require('fs')
const path = require('path')
const BASE = process.env.BASE ?? 'http://localhost:5174'
const OUT = process.argv[2]
fs.mkdirSync(OUT, { recursive: true })
;(async () => {
  const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', ignoreDefaultArgs: ['--hide-scrollbars'] })
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await ctx.newPage()
  // 가짜 서버 자료는 '오늘' 기준 → 다른 날 찍은 기록과 대조할 땐 FIX_TIME으로 그날에 맞춤 (타이머는 그대로 돎)
  if (process.env.FIX_TIME) await page.clock.setFixedTime(new Date(process.env.FIX_TIME))
  const errors = []
  page.on('pageerror', (e) => errors.push('PAGEERROR ' + e.message.slice(0, 160)))
  page.on('console', (m) => m.type() === 'error' && !/favicon|Failed to load resource|ServiceWorker/.test(m.text()) && errors.push('CONSOLE ' + m.text().slice(0, 160)))
  const save = async (name) => {
    // 진행 통화 수는 가짜 서버가 8초마다 바꿈 → 글에서는 지우고 그림에서는 가림
    await page.evaluate(() => {
      for (const el of document.querySelectorAll('header *, aside *, nav *'))
        if (!el.children.length && /통화 중|접수 중/.test(el.textContent ?? '')) (el.parentElement ?? el).style.visibility = 'hidden'
    })
    const text = (await page.evaluate(() => document.body.innerText)).replace(/통화 중\s*\d+건|\d+건 접수 중/g, '').replace(/(\d{4}-\d{2}-\d{2}) \d{2}:\d{2}/g, '$1 --:--').replace(/[ \t]+\n/g, '\n')
    fs.writeFileSync(path.join(OUT, name + '.txt'), text)
    await page.screenshot({ path: path.join(OUT, name + '.png'), animations: 'disabled' })
    console.log(name, text.length, '자')
  }
  const open = async (name, url, wait = 1800) => {
    await page.goto(BASE + url)
    await page.waitForTimeout(wait)
    await save(name)
  }
  await open('login', '/login', 800)
  await open('signup', '/signup', 800)
  await page.goto(BASE + '/login')
  await page.waitForSelector('input')
  const ins = await page.$$('input')
  await ins[0].fill('admin')
  await ins[1].fill('test1234')
  await page.keyboard.press('Enter')
  await page.waitForURL((u) => !u.pathname.startsWith('/login'))
  for (const [name, url] of [['home', '/'], ['calls', '/calls'], ['orders', '/orders'], ['unanswered', '/unanswered'], ['faqs', '/faqs'], ['customers', '/customers'], ['companies', '/companies'], ['personas', '/personas'], ['persona-tests', '/personas/1/tests/6'], ['persona-test-detail', '/personas/1/tests/6/A4'], ['stats', '/stats'], ['stats-wait', '/stats/response-wait'], ['stats-dropoff', '/stats/stage-dropoffs'], ['admins', '/admins'], ['me', '/me'], ['call-detail', '/calls/9110']]) {
    await open(name, url)
    // 목록이면 첫 줄을 눌러 옆 칸 · 상세 화면도 남김
    if (['orders', 'customers', 'companies'].includes(name)) {
      const row = page.locator('main tbody tr').first()
      if (await row.count()) {
        await row.click().catch(() => {})
        await page.waitForTimeout(1800)
        await save(name + '-first')
      }
    }
  }
  // 누르면 나오는 창: 주문 추가 · 기업 등록 · FAQ 추가 · 상담가 등록 (열기만)
  for (const [name, url, button] of [['orders-add', '/orders', /주문 추가/], ['companies-add', '/companies', /CSV로 기업 등록/], ['faqs-add', '/faqs', /FAQ 등록/], ['faqs-edit', '/faqs', /^수정$/], ['unanswered-faq', '/unanswered', /FAQ 등록/], ['personas-add', '/personas', /상담가 등록/]]) {
    await page.goto(BASE + url)
    await page.waitForTimeout(1500)
    const b = page.getByRole('button', { name: button }).first()
    if (await b.count()) {
      await b.click().catch(() => {})
      await page.waitForTimeout(1200)
      await save(name)
    } else console.log(name, '버튼 못 찾음')
  }
  // FAQ 첫 질문 펼치기 (답변은 마크다운)
  await page.goto(BASE + '/faqs')
  await page.waitForTimeout(1500)
  await page.locator('main button').filter({ hasNotText: /^#|FAQ 등록|^수정$|^삭제$/ }).first().click()
  await page.waitForTimeout(1200)
  await save('faqs-open')
  // 고객 수정 칸 → 탈퇴 확인 창
  await page.goto(BASE + '/customers')
  await page.waitForTimeout(1500)
  await page.locator('main tbody tr').first().click()
  await page.waitForTimeout(1200)
  await page.getByRole('button', { name: /수정/ }).first().click()
  await page.waitForTimeout(800)
  await save('customers-edit')
  await page.getByRole('button', { name: /고객 탈퇴/ }).first().click()
  await page.waitForTimeout(800)
  await save('customers-withdraw')
  console.log('오류', errors.length, errors.slice(0, 5))
  await browser.close()
})()
