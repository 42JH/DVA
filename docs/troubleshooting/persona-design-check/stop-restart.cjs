// 시나리오 시험 화면에서 시험 → [시험 중단] → 다시 시험 — 가짜 서버(mock 5174)
// 볼 것: 중단 뒤 버튼(남은 N개 · 전체), 다시 시작했을 때 '시험을 중단할까요?' 창이 누르지도 않았는데 뜨는지
// 실행: node stop-restart.cjs [바로 = 시작하자마자 중단]
const { chromium } = require(process.env.PW_CORE ?? 'playwright-core')
const BASE = process.env.BASE ?? 'http://localhost:5174'
const AT_ONCE = process.argv[2] === '바로'
;(async () => {
  const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' })
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message.slice(0, 120)))
  await page.goto(BASE + '/login')
  await page.waitForSelector('input')
  const ins = await page.$$('input')
  await ins[0].fill('admin')
  await ins[1].fill('test1234')
  await page.keyboard.press('Enter')
  await page.waitForURL((u) => !u.pathname.startsWith('/login'))
  await page.goto(BASE + '/personas/1/tests/7')
  await page.waitForTimeout(1500)
  const buttons = async () => (await page.locator('main button').allInnerTexts()).map((t) => t.trim()).filter(Boolean).join(' / ')
  const dialogs = async () => (await page.locator('dialog[open] h2').allInnerTexts()).join(' | ') || '없음'
  const stats = async () => (await page.locator('main').innerText()).replace(/\s+/g, ' ').slice(0, 90)
  console.log('처음 버튼:', await buttons())
  await page.getByRole('button', { name: /전체 \d+개 시험/ }).click()
  await page.locator('dialog button', { hasText: '시험 시작' }).click()
  await page.waitForTimeout(AT_ONCE ? 300 : 4500)
  console.log('도는 중 버튼:', await buttons(), '|', await stats())
  await page.getByRole('button', { name: '시험 중단' }).click()
  await page.locator('dialog button', { hasText: /^중단$/ }).click()
  await page.waitForTimeout(1500)
  console.log('중단 뒤 버튼:', await buttons(), '| 창:', await dialogs(), '|', await stats())
  // 다시 시험 — 남은 것 버튼이 있으면 그것, 없으면 전체
  const again = page.getByRole('button', { name: /남은 \d+개 시험/ })
  await ((await again.count()) ? again : page.getByRole('button', { name: /전체 \d+개 시험/ })).click()
  console.log('다시 시험 확인 창:', await dialogs())
  await page.locator('dialog button', { hasText: '시험 시작' }).click()
  await page.waitForTimeout(1500)
  console.log('다시 시작한 뒤 창(아무것도 안 눌렀음):', await dialogs(), '| 버튼:', await buttons())
  await page.keyboard.press('Escape')
  await page.waitForTimeout(300)
  // 중단 요청이 한 번 실패하면 창에 문구가 뜨고, 닫았다 다시 열면 그 문구가 남아 있지 않아야 함
  if (await page.getByRole('button', { name: '시험 중단' }).count()) {
    await page.evaluate(() => {
      const real = window.fetch
      let left = 1
      window.fetch = (u, o) => (left && String(u?.url ?? u).endsWith('/stop') ? (left--, Promise.reject(new TypeError('끊김'))) : real(u, o))
    })
    const body = async () => (await page.locator('dialog[open]').innerText().catch(() => '')).replace(/\s+/g, ' ')
    await page.getByRole('button', { name: '시험 중단' }).click()
    await page.locator('dialog button', { hasText: /^중단$/ }).click()
    await page.waitForTimeout(1200)
    console.log('중단 요청 실패 뒤 창:', (await body()).slice(0, 110))
    await page.locator('dialog button', { hasText: '취소' }).click()
    await page.waitForTimeout(300)
    await page.getByRole('button', { name: '시험 중단' }).click()
    await page.waitForTimeout(300)
    console.log('닫았다 다시 연 창에 실패 문구:', /멈추지 못했습니다/.test(await body()) ? '남아 있음' : '없음')
    await page.locator('dialog button', { hasText: /^중단$/ }).click()
    await page.waitForTimeout(1500)
    console.log('뒤처리로 중단한 뒤 버튼:', await buttons(), '| 창:', await dialogs())
  }
  console.log('오류', errors.length, errors.slice(0, 3))
  await browser.close()
})().catch((e) => {
  console.log('실패:', String(e.message).slice(0, 300))
  process.exit(1)
})
