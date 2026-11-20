// 프롬프트 보는 모양 ↔ 입력 칸 — 자동 점검(flow.cjs)에 없는 경우를 한 번씩 밟아 봄 (가짜 서버 5174)
//  a) 고치던 칸에서 다른 칸을 바로 누름   b) Shift+Tab   c) 긴 칸을 눌렀을 때 화면이 튀는지   d) 꾸민 글 안의 링크
// 실행: node prompt-view-probe.cjs
const { chromium } = require(process.env.PW_CORE ?? 'playwright-core')
const BASE = process.env.BASE ?? 'http://localhost:5174'
const VIEW = 'article section div[tabindex="0"]'
const out = (k, v) => console.log(k.padEnd(34), typeof v === 'string' ? v : JSON.stringify(v))

;(async () => {
  const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', ignoreDefaultArgs: ['--hide-scrollbars'] })
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const p = await ctx.newPage()
  const errors = []
  p.on('pageerror', (e) => errors.push('PAGEERROR ' + e.message))
  p.on('console', (m) => m.type() === 'error' && !/favicon|Failed to load resource/.test(m.text()) && errors.push('CONSOLE ' + m.text().slice(0, 200)))
  await p.goto(BASE + '/login')
  await p.waitForSelector('input')
  const ins = await p.$$('input')
  await ins[0].fill('admin')
  await ins[1].fill('test1234')
  await p.keyboard.press('Enter')
  await p.waitForURL((u) => !u.pathname.startsWith('/login'))
  await p.goto(BASE + '/personas')
  await p.waitForSelector(VIEW)
  await p.waitForTimeout(800)

  const state = () =>
    p.evaluate(() => {
      const tas = [...document.querySelectorAll('article textarea')]
      const a = document.activeElement
      return {
        textareas: tas.map((t) => t.closest('label').querySelector('span').textContent.trim()),
        views: document.querySelectorAll('article section div[tabindex="0"]').length,
        focus: a?.tagName === 'TEXTAREA' ? a.closest('label').querySelector('span').textContent.trim() : (a?.tagName ?? ''),
        caretAtEnd: a?.tagName === 'TEXTAREA' ? a.selectionStart === a.value.length && a.selectionEnd === a.value.length : null,
      }
    })

  // a) 역할 칸을 고치다가 발화 톤 칸(셋째)을 바로 누름
  await p.locator(VIEW).first().click()
  await p.keyboard.type(' 가')
  out('a0 역할 누른 뒤', await state())
  // 역할이 입력 칸이라 보는 칸은 5개 — 그중 둘째가 발화 톤
  await p.locator(VIEW).nth(1).click()
  await p.waitForTimeout(200)
  out('a1 발화 톤을 바로 누른 뒤', await state())
  await p.keyboard.type(' 나')
  out('a2 친 글이 들어간 칸', await p.evaluate(() => [...document.querySelectorAll('article textarea')].map((t) => t.value.slice(-4))))
  out('a3 역할 칸(보는 모양) 끝', await p.locator(VIEW).first().evaluate((el) => el.innerText.trim().slice(-4)))

  // b) Shift+Tab — 앞 칸(성격)으로
  await p.keyboard.press('Shift+Tab')
  await p.waitForTimeout(200)
  out('b  Shift+Tab 뒤', await state())

  // 원래대로 (취소)
  await p.locator('article header button', { hasText: '취소' }).click()
  await p.waitForTimeout(300)
  if (await p.locator('[role=dialog]').count()) await p.locator('[role=dialog] button').last().click()
  await p.waitForTimeout(300)
  out('   취소 뒤', await state())

  // c) 긴 칸 — 역할 칸에 80줄을 넣고, 칸 밖을 눌러 보는 모양으로 → 맨 위에서 첫 줄을 누름
  const long = Array.from({ length: 80 }, (_, i) => `- ${i + 1}번째 줄입니다. 고객이 말을 끊으면 **즉시** 멈춥니다.`).join('\n')
  await p.locator(VIEW).first().click()
  await p.locator('article textarea').first().fill(long)
  await p.locator('article h3').first().click()
  await p.waitForTimeout(300)
  const sc = () =>
    p.evaluate(() => {
      let el = document.querySelector('article section div[tabindex="0"], article textarea').parentElement
      while (el && !/auto|scroll/.test(getComputedStyle(el).overflowY)) el = el.parentElement
      const first = document.querySelector('article section div[tabindex="0"], article textarea')
      const r = first.getBoundingClientRect()
      const s = el.getBoundingClientRect()
      return { scrollTop: Math.round(el.scrollTop), boxH: Math.round(s.height), blockTop: Math.round(r.top - s.top), blockH: Math.round(r.height), tag: first.tagName }
    })
  const setTop = (y) =>
    p.evaluate((y) => {
      let el = document.querySelector('article section div[tabindex="0"], article textarea').parentElement
      while (el && !/auto|scroll/.test(getComputedStyle(el).overflowY)) el = el.parentElement
      el.scrollTop = y
    }, y)
  await setTop(0)
  out('c0 긴 칸(보는 모양), 맨 위', await sc())
  const box = await p.locator(VIEW).first().boundingBox()
  await p.mouse.click(box.x + 60, box.y + 14) // 첫 줄
  await p.waitForTimeout(300)
  out('c1 첫 줄을 누른 뒤', { ...(await sc()), ...(await state()) })
  await p.keyboard.type('X')
  await p.waitForTimeout(300)
  out('c2 한 글자 친 뒤', await sc())
  // 가운데쯤 보고 있다가 누름
  await p.locator('article h3').first().click()
  await p.waitForTimeout(300)
  await setTop(900)
  const before = await sc()
  out('c3 보는 모양, 900만큼 내려 봄', before)
  const sbox = await p.evaluate(() => {
    let el = document.querySelector('article section div[tabindex="0"]').parentElement
    while (el && !/auto|scroll/.test(getComputedStyle(el).overflowY)) el = el.parentElement
    const s = el.getBoundingClientRect()
    return { x: s.x, y: s.y, w: s.width, h: s.height }
  })
  await p.mouse.click(sbox.x + 120, sbox.y + sbox.h / 2)
  await p.waitForTimeout(300)
  out('c4 가운데를 누른 뒤', { ...(await sc()), ...(await state()) })

  // d) 꾸민 글 안의 링크 — 눌러도 다른 곳으로 안 감
  await p.locator('article textarea').first().fill('참고 https://example.com/guide 를 봅니다.\n[안내](https://example.com/a)')
  await p.locator('article h3').first().click()
  await p.waitForTimeout(300)
  const links = await p.locator(`${VIEW} a`).evaluateAll((as) => as.map((a) => `${a.textContent}|${a.getAttribute('href')}|${a.target}`))
  out('d0 꾸민 글의 링크', links)
  const pages0 = ctx.pages().length
  const url0 = p.url()
  if (links.length) await p.locator(`${VIEW} a`).first().click()
  await p.waitForTimeout(600)
  out('d1 링크를 누른 뒤', { url같음: p.url() === url0, 새창: ctx.pages().length - pages0, ...(await state()) })

  out('오류', errors.length ? errors : '없음')
  await browser.close()
})().catch((e) => {
  console.log('실패:', String(e.message).slice(0, 400))
  process.exit(1)
})
