// 실서버의 실제 프롬프트 글을 새 '보는 모양'으로 그렸을 때 글이 빠지거나 바뀌는지 대조
//  1) 실서버(읽기 전용 — 로그인 말고는 GET만): 상담가 탭마다 프롬프트 여섯 칸의 원문을 읽음
//  2) 가짜 서버(5174, 새 코드): 그 원문을 칸에 넣고 칸 밖을 눌러 보는 모양으로 → 화면에 보이는 글 · 쓰인 꾸밈 종류를 뽑음
//  3) 원문에서 마크다운 기호만 뺀 글과 화면 글이 같은지 비교. 원문은 화면에 찍지 않고 길이 · 다른 자리 앞뒤 몇 글자만 냄
// 실행: LH_ID=… LH_PW=… node prompt-view-live.cjs <그림 남길 폴더>   (로그인 정보는 환경변수로만, 어디에도 적지 않음)
const { chromium } = require(process.env.PW_CORE ?? 'C:/Users/SSAFY/AppData/Local/Temp/pw/node_modules/playwright-core')
const fs = require('fs')
const path = require('path')
const LIVE = process.env.LIVE ?? 'https://dva-d109.duckdns.org'
const MOCK = process.env.BASE ?? 'http://localhost:5174'
const OUT = process.argv[2]
fs.mkdirSync(OUT, { recursive: true })
if (!process.env.LH_ID || !process.env.LH_PW) throw new Error('LH_ID · LH_PW가 필요합니다')
const VIEW = 'article section div[tabindex="0"]'

const login = async (page, base, id, pw) => {
  await page.goto(base + '/login')
  await page.waitForSelector('input')
  const ins = await page.$$('input')
  await ins[0].fill(id)
  await ins[1].fill(pw)
  await page.keyboard.press('Enter')
  await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 15000 })
}

// 원문에서 마크다운 기호만 뺌 — 화면 글(innerText)과 견줄 모양으로
const strip = (raw) =>
  raw
    .split('\n')
    .map((l) =>
      l
        .replace(/^\s*>+\s?/, '') // 인용
        .replace(/^\s*#{1,6}\s+/, '') // 제목
        .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '') // 목록
        .replace(/\*\*|__|~~|`/g, ''),
    )
    .join(' ')
const flat = (s) => s.replace(/\s+/g, ' ').trim()

;(async () => {
  const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', ignoreDefaultArgs: ['--hide-scrollbars'] })

  // 1) 실서버 — 읽기만
  const live = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const blocked = []
  await live.route('**/api/**', (route) => {
    const r = route.request()
    const p = new URL(r.url()).pathname
    if (['GET', 'HEAD', 'OPTIONS'].includes(r.method()) || (r.method() === 'POST' && p.endsWith('/auth/login'))) return route.continue()
    blocked.push(`${r.method()} ${p}`)
    return route.abort()
  })
  const lp = await live.newPage()
  await login(lp, LIVE, process.env.LH_ID, process.env.LH_PW)
  await lp.goto(LIVE + '/personas')
  await lp.waitForSelector('article textarea, ' + VIEW, { timeout: 15000 })
  await lp.waitForTimeout(1200)
  const tablist = lp.locator('[role=tablist]').first() // 상담가 탭 줄
  const tabs = await tablist.getByRole('tab').count()
  const personas = []
  for (let i = 0; i < tabs; i++) {
    await tablist.getByRole('tab').nth(i).click()
    await lp.waitForTimeout(1200)
    // 배포본이 예전 모양(늘 입력 칸)이든 새 모양(보는 칸)이든 원문을 얻음 — 새 모양이면 칸을 눌러 입력 칸에서 읽음
    const n = await lp.locator('article textarea, ' + VIEW).count()
    const sections = []
    for (let k = 0; k < n; k++) {
      const el = lp.locator('article textarea, ' + VIEW).nth(k)
      if ((await el.evaluate((e) => e.tagName)) !== 'TEXTAREA') await el.click()
      const ta = lp.locator('article textarea').first()
      const only = (await lp.locator('article textarea').count()) === 1
      const t = only ? ta : lp.locator('article textarea').nth(k)
      sections.push({ title: await t.evaluate((e) => e.closest('label').querySelector('span').textContent.trim()), raw: await t.inputValue() })
    }
    personas.push({ tab: i + 1, sections })
  }
  await live.close()
  console.log(`실서버: 상담가 ${personas.length}명, 칸 ${personas.reduce((n, p) => n + p.sections.length, 0)}개 · 막은 요청 ${blocked.length ? blocked.join(', ') : '없음'}`)

  // 2) 가짜 서버(새 코드)에서 그려 봄
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const p = await ctx.newPage()
  const errors = []
  p.on('pageerror', (e) => errors.push('PAGEERROR ' + e.message.slice(0, 160)))
  p.on('console', (m) => m.type() === 'error' && !/favicon|Failed to load resource/.test(m.text()) && errors.push('CONSOLE ' + m.text().slice(0, 160)))
  await login(p, MOCK, 'admin', 'test1234')
  await p.goto(MOCK + '/personas')
  await p.waitForSelector(VIEW)
  await p.waitForTimeout(800)
  let bad = 0
  const kinds = {}
  for (const per of personas) {
    for (const [k, s] of per.sections.entries()) {
      await p.locator(VIEW).first().click()
      await p.locator('article textarea').first().fill(s.raw)
      await p.locator('article h3').first().click()
      await p.waitForTimeout(150)
      const view = p.locator(VIEW).first()
      const shown = await view.innerText()
      const tags = await view.evaluate((el) => [...new Set([...el.querySelectorAll('*')].map((e) => e.tagName.toLowerCase()))].filter((t) => !['div', 'p', 'br', 'span'].includes(t)).sort())
      for (const t of tags) kinds[t] = (kinds[t] ?? 0) + 1
      const a = flat(strip(s.raw))
      const b = flat(shown)
      const same = a === b
      if (!same) {
        bad++
        let i = 0
        while (i < a.length && i < b.length && a[i] === b[i]) i++
        console.log(`  다름 상담가${per.tab} ${s.title}: 원문 ${a.length}자 · 화면 ${b.length}자, ${i}번째부터 — 원문 '${a.slice(Math.max(0, i - 12), i + 24)}' / 화면 '${b.slice(Math.max(0, i - 12), i + 24)}'`)
      }
      console.log(`  상담가${per.tab} ${s.title.padEnd(6)} 원문 ${String(s.raw.length).padStart(4)}자 ${String(s.raw.split('\n').length).padStart(3)}줄 → ${same ? '같음' : '다름'} [${tags.join(' ')}]`)
      if (k === 0 || !same) await p.screenshot({ path: path.join(OUT, `p${per.tab}-${k + 1}${same ? '' : '-diff'}.png`) })
    }
    // 여섯 칸을 한꺼번에 넣은 모습도 한 장 (실제로 보일 화면)
    for (const [k, s] of per.sections.entries()) {
      await p.locator(VIEW + ', article textarea').nth(k).click()
      await p.locator('article textarea').first().fill(s.raw)
    }
    await p.locator('article h3').first().click()
    await p.waitForTimeout(200)
    await p.screenshot({ path: path.join(OUT, `p${per.tab}-all.png`) })
  }
  console.log(`대조: 칸 ${personas.reduce((n, x) => n + x.sections.length, 0)}개 중 글이 다른 칸 ${bad}개 · 쓰인 꾸밈 ${JSON.stringify(kinds)} · 화면 오류 ${errors.length ? errors.join(' / ') : '없음'}`)
  await browser.close()
})().catch((e) => {
  console.log('실패:', String(e.message).slice(0, 400))
  process.exit(1)
})
