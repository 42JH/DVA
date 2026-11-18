// 가짜 서버(mock 5174)가 화면에 주는 API 응답을 받아 적음 → serve.mjs가 빌드본에 그대로 돌려줌
// 실행: node record.cjs <받아 적을 파일> [주소들]
const { chromium } = require(process.env.PW_CORE ?? 'playwright-core')
const fs = require('fs')
const BASE = process.env.BASE ?? 'http://localhost:5174'
const OUT = process.argv[2]
const PATHS = (process.argv[3] ?? '/personas,/personas/1/tests/6,/personas/1/tests/6/A4').split(',')
;(async () => {
  const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' })
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage()
  const api = {}
  const pending = []
  page.on('response', (r) => {
    const u = new URL(r.url())
    if (!u.pathname.startsWith('/api/') || u.pathname.endsWith('/stream')) return // 스트림(진행 통화 수)은 끝나지 않음 — serve.mjs가 직접 흘림
    const key = `${r.request().method()} ${u.pathname}${u.search}`
    pending.push(
      r.body().then(
        (b) => {
          // 가짜는 녹음 주소를 기록에 blob으로 넣어 줌 → 실제 창구처럼 빼서 화면이 …/audio를 부르게 (serve.mjs가 무음을 줌)
          if (u.pathname.endsWith('/record')) b = Buffer.from(JSON.stringify({ ...JSON.parse(b.toString()), audioUrl: undefined }))
          api[key] = { status: r.status(), type: r.headers()['content-type'] ?? '', body: b.toString('base64') }
        },
        (e) => console.log('본문 못 받음', key, e.message),
      ),
    )
  })
  await page.goto(BASE + '/login')
  await page.waitForSelector('input')
  const ins = await page.$$('input')
  await ins[0].fill('admin')
  await ins[1].fill('test1234')
  await page.keyboard.press('Enter')
  await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 15000 })
  for (const p of PATHS) {
    await Promise.all(pending) // 다음 주소로 넘어가면 앞 응답 본문을 못 읽음
    await page.goto(BASE + p)
    await page.waitForTimeout(4000) // 개발 서버는 주기 요청 때문에 networkidle이 오지 않음
    console.log(p, '→', new URL(page.url()).pathname, '|', (await page.locator('h1, h2').allInnerTexts()).join(' / ').slice(0, 120))
  }
  await Promise.all(pending)
  fs.writeFileSync(OUT, JSON.stringify(api, null, 1))
  for (const [k, v] of Object.entries(api)) console.log(v.status, k, Math.round(v.body.length * 0.75), 'B')
  await browser.close()
})()
