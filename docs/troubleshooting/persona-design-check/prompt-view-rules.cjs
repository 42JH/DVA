// 꾸민 글에서 원문과 달라 보일 수 있는 마크다운 규칙을 실제로 그려 봄 (가짜 서버 5174) — 링크 정의 꼴 · 들여쓴 줄 · 3부터인 번호 · 인용 · 제목 · 구분선 · 빈 줄 · 꺾쇠와 변수
// 실행: node prompt-view-rules.cjs
const { chromium } = require(process.env.PW_CORE ?? 'playwright-core')
const BASE = process.env.BASE ?? 'http://localhost:5174'
const VIEW = 'article section div[tabindex="0"]'
const CASES = {
  '링크 정의 꼴': '첫 줄입니다.\n\n[주의]: 금지\n\n끝 줄입니다.',
  '링크 정의 아님(뒤에 말이 이어짐)': '[주의]: 고객 정보는 말하지 않습니다.',
  '네 칸 들여쓴 줄': '규칙\n\n    들여쓴 줄입니다.',
  '번호가 3부터': '3. 셋째\n4. 넷째',
  '인용': '> 인용한 줄입니다.',
  '제목': '# 큰 제목\n본문',
  '밑줄 구분선': '위 줄\n-----\n아래 줄',
  '빈 줄 여러 개': '가\n\n\n\n나',
  '꺾쇠 · 변수': '<주소>를 {{customer_name}}에게 1~3일 안에 * 표시',
}
;(async () => {
  const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' })
  const p = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage()
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
  for (const [name, raw] of Object.entries(CASES)) {
    await p.locator(VIEW).first().click()
    await p.locator('article textarea').first().fill(raw)
    await p.locator('article h3').first().click()
    await p.waitForTimeout(150)
    const v = p.locator(VIEW).first()
    const shown = (await v.innerText()).replace(/\n+/g, ' / ')
    const tags = await v.evaluate((el) => [...new Set([...el.querySelectorAll('*')].map((e) => e.tagName.toLowerCase()))].filter((t) => !['div', 'p', 'br', 'span'].includes(t)).join(' '))
    const ol = await v.evaluate((el) => el.querySelector('ol')?.getAttribute('start') ?? '')
    console.log(`${name}: 화면 '${shown}' [${tags}]${ol ? ' start=' + ol : ''}`)
  }
  await browser.close()
})().catch((e) => {
  console.log('실패:', String(e.message).slice(0, 300))
  process.exit(1)
})
