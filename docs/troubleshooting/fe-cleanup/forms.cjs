// 값을 보내는 화면(주문 추가 · 수정 · 미완료 접수, 사원 추가 · 수정)의 동작 기록 — 구조를 바꾸기 전후로 돌려 대조
// 단계마다 창(없으면 본문)의 글 · 버튼(꺼짐 여부) · 칸 값, 그리고 GET이 아닌 요청의 주소와 본문을 남김. 가짜 서버(mock 5174)
// 실행: FIX_TIME=2026-11-14T12:00:00+09:00 node forms.cjs <남길 파일.json>   대조: node forms.cjs --diff <전.json> <후.json>
const fs = require('fs')
if (process.argv[2] === '--diff') {
  const [a, b] = process.argv.slice(3).map((f) => JSON.parse(fs.readFileSync(f, 'utf8')))
  let bad = 0
  const same = (x, y) => JSON.stringify(x) === JSON.stringify(y)
  for (let i = 0; i < Math.max(a.steps.length, b.steps.length); i++) {
    const x = a.steps[i]
    const y = b.steps[i]
    if (same(x, y)) continue
    bad++
    console.log('단계 다름:', x?.tag, '/', y?.tag)
    for (const k of ['where', 'text', 'buttons', 'fields', 'failed'])
      if (!same(x?.[k], y?.[k])) console.log('  ', k, '\n    전:', JSON.stringify(x?.[k])?.slice(0, 400), '\n    후:', JSON.stringify(y?.[k])?.slice(0, 400))
  }
  for (let i = 0; i < Math.max(a.reqs.length, b.reqs.length); i++)
    if (!same(a.reqs[i], b.reqs[i])) {
      bad++
      console.log('요청 다름:\n  전:', JSON.stringify(a.reqs[i])?.slice(0, 500), '\n  후:', JSON.stringify(b.reqs[i])?.slice(0, 500))
    }
  console.log(`단계 ${a.steps.length} / ${b.steps.length}개 · 요청 ${a.reqs.length} / ${b.reqs.length}개 · 다른 곳 ${bad}`)
  process.exit(bad ? 1 : 0)
}
const { chromium } = require(process.env.PW_CORE ?? 'C:/Users/SSAFY/AppData/Local/Temp/pw/node_modules/playwright-core')
const BASE = process.env.BASE ?? 'http://localhost:5174'
const OUT = process.argv[2]
;(async () => {
  const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' })
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage()
  if (process.env.FIX_TIME) await page.clock.setFixedTime(new Date(process.env.FIX_TIME))
  const steps = []
  const reqs = []
  const errors = []
  page.on('pageerror', (e) => !/ServiceWorker/.test(e.message) && errors.push(e.message.slice(0, 160)))
  // 보내는 요청은 화면의 fetch에서 바로 잡음 — 가짜 응답이 없는 저장 요청(주문 추가 · 수정 · 접수 등)은 여기서 성공으로 답해
  // 실제 백엔드로 넘어가지 않게 함 (가짜 서버는 응답이 없는 요청을 프록시로 넘김)
  // 본문의 임의 번호(UUID)는 돌릴 때마다 달라 'uuid'로 바꿔 남김
  const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g
  await page.exposeFunction('__sent', (r) => reqs.push({ after: steps.at(-1)?.tag ?? '', ...JSON.parse(JSON.stringify(r).replace(UUID, 'uuid')) }))
  await page.addInitScript(() => {
    const real = window.fetch
    const CANNED = [
      [/^POST \/api\/admin\/orders$/, 201, { data: { orderSeq: 99001, status: 'notPaid' } }],
      [/^PATCH \/api\/orders\/\d+$/, 200, { data: { version: 99 } }],
      [/^POST \/api\/orders\/\d+\/submit$/, 200, { data: { status: 'notPaid' } }],
      [/^POST \/api\/customers$/, 201, { data: { customerSeq: 99002 } }],
    ]
    window.fetch = async (input, init) => {
      const req = input instanceof Request ? input : null
      const url = new URL(req ? req.url : String(input), location.href)
      const method = (init?.method ?? req?.method ?? 'GET').toUpperCase()
      if (!url.pathname.startsWith('/api/') || method === 'GET' || url.pathname.endsWith('/auth/login')) return real(input, init)
      let body = init?.body ?? (req ? await req.clone().text() : undefined)
      try {
        body = JSON.parse(body)
      } catch {
        /* 본문 없음 */
      }
      const headers = new Headers(init?.headers ?? req?.headers)
      window.__sent({ m: method, p: url.pathname + url.search, body, key: headers.has('Idempotency-Key') })
      const hit = CANNED.find(([re]) => re.test(`${method} ${url.pathname}`))
      if (!hit) return real(input, init)
      return new Response(JSON.stringify(hit[2]), { status: hit[1], headers: { 'Content-Type': 'application/json' } })
    }
  })
  // 가짜 응답이 없어 실제 백엔드로 넘어간 요청(401 등)도 남김 — 가짜 서버의 빈 곳
  const bad = []
  page.on('response', (r) => {
    const u = new URL(r.url())
    if (u.pathname.startsWith('/api/') && r.status() >= 400) bad.push(`${r.status()} ${r.request().method()} ${u.pathname}`)
  })
  const wait = (ms) => page.waitForTimeout(ms)
  const state = async (tag) => {
    const s = await page.evaluate(() => {
      const dlgs = [...document.querySelectorAll('dialog[open]')]
      const root = dlgs.at(-1) ?? document.querySelector('main')
      const lab = (el) =>
        el.getAttribute('aria-label') || el.closest('label')?.firstElementChild?.textContent?.trim() || el.placeholder || el.type
      return {
        where: dlgs.length ? `창 ${dlgs.length}` : '본문',
        text: root.innerText.replace(/\s+/g, ' ').trim(),
        buttons: [...root.querySelectorAll('button')].map((b) => [
          (b.innerText || b.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim().slice(0, 24),
          b.disabled,
          b.getAttribute('aria-pressed') ?? b.getAttribute('aria-selected') ?? b.getAttribute('aria-checked'),
        ]),
        fields: [...root.querySelectorAll('input,select,textarea')].map((el) => [lab(el), el.value, el.getAttribute('aria-invalid'), el.disabled || el.readOnly]),
      }
    })
    steps.push({ tag, ...s })
    console.log(tag.padEnd(30), '|', s.where, '|', String(s.text.length).padStart(4), '자 | 켜진 버튼', s.buttons.filter((b) => !b[1]).length + '/' + s.buttons.length, '| 칸', s.fields.length)
  }
  const step = async (tag, fn) => {
    try {
      await fn()
      await wait(700)
      await state(tag)
    } catch (e) {
      steps.push({ tag, failed: String(e.message).split('\n')[0].slice(0, 140) })
      console.log(tag.padEnd(30), '| 못 함:', String(e.message).split('\n')[0].slice(0, 140))
    }
  }
  const dlg = () => page.locator('dialog[open]').last()
  const combo = (i) => dlg().locator('input[role=combobox]').nth(i)
  const pickFirst = async (i, text) => {
    await combo(i).click()
    if (text) await combo(i).fill(text)
    await wait(1300)
    await combo(i).press('ArrowDown')
    await combo(i).press('Enter')
  }
  const T = { timeout: 4000 }

  await page.goto(BASE + '/login')
  await page.waitForSelector('input')
  const ins = await page.$$('input')
  await ins[0].fill('admin')
  await ins[1].fill('test1234')
  await page.keyboard.press('Enter')
  await page.waitForURL((u) => !u.pathname.startsWith('/login'))

  // ---------- A. 주문 추가 ----------
  await page.goto(BASE + '/orders')
  await wait(1500)
  await step('A1 주문 추가 열림', () => page.getByRole('button', { name: /주문 추가/ }).first().click(T))
  await step('A2 보내는 분 번호 틀림', () => combo(1).fill('0101'))
  await step('A3 보내는 분 이름 추천', async () => {
    await combo(1).fill('')
    await combo(0).click()
    await combo(0).fill('김')
    await wait(1300)
  })
  await step('A4 보내는 분 고름', async () => {
    await combo(0).press('ArrowDown')
    await combo(0).press('Enter')
    await wait(1200)
  })
  await step('A5 받는 분 칸(주소록)', async () => {
    await combo(2).click()
    await wait(1300)
  })
  await step('A6 받는 분 고름', async () => {
    await combo(2).press('ArrowDown')
    await combo(2).press('Enter')
    if ((await combo(2).inputValue()) === '') await pickFirst(2, '이') // 주소록이 비었으면 고객 검색에서
  })
  await step('A7 박스 11개(넘침)', () => dlg().getByLabel('소박스 개수').fill('11', T))
  await step('A8 박스 2 · 서류 1', async () => {
    await dlg().getByLabel('소박스 개수').fill('2', T)
    await dlg().getByRole('button', { name: /^서류.*더하기$/ }).click(T)
  })
  await step('A9 물품 가액', () => dlg().locator('label:has-text("물품 가액") select').selectOption({ index: 2 }, T))
  await step('A10 수거 20시(범위 밖)', () => dlg().locator('input[type=datetime-local]').fill('2026-11-15T20:00', T))
  await step('A11 수거 10시', () => dlg().locator('input[type=datetime-local]').fill('2026-11-15T10:00', T))
  await step('A12 요청 사항', () => dlg().getByLabel(/요청 사항/).fill('경비실에 맡겨 주세요', T))
  await step('A13 개인카드', () => dlg().getByText('개인카드', { exact: true }).click(T))
  await step('A14 월결제(물어봄)', () => dlg().getByText('월결제', { exact: true }).first().click(T))
  await step('A15 월결제 창 답', async () => {
    const ok = page.locator('dialog[open]').last().getByRole('button', { name: /^추가$/ })
    if (await ok.count()) await ok.click(T)
  })
  await step('A16 [접수]', async () => {
    await dlg().getByRole('button', { name: /^접수$/ }).click(T)
    await wait(1800)
  })
  await page.keyboard.press('Escape')
  await wait(400)

  // ---------- B. 결제 대기 주문 수정 ----------
  await page.goto(BASE + '/orders?g=notPaid&r=all')
  await wait(1600)
  await step('B1 주문 상세', () => page.locator('main tbody tr').first().click(T))
  await step('B2 수정 열림', () => page.getByRole('button', { name: /^수정$/ }).first().click(T))
  const form = () => (page.locator('dialog[open]').count().then((n) => (n ? dlg() : page.locator('main'))))
  await step('B3 바뀐 것 없이', async () => {})
  await step('B4 요청 사항 · 박스 +1', async () => {
    const f = await form()
    await f.getByLabel(/요청 사항/).fill('문 앞에 놓아 주세요', T)
    await f.getByRole('button', { name: /^소박스.*더하기$/ }).click(T)
  })
  await step('B5 보내는 분 이름 고침', async () => {
    const f = await form()
    await f.locator('input[role=combobox]').first().fill('김하늘', T)
  })
  await step('B6 [저장]', async () => {
    const f = await form()
    await f.getByRole('button', { name: /^저장$/ }).click(T)
    await wait(1200)
  })
  await step('B7 고객정보에도 저장 답', async () => {
    const d = page.locator('dialog[open]').last()
    const yes = d.getByRole('button', { name: /고객정보에도|같이 저장|^저장$|^예$/ }).last()
    if (await yes.count()) await yes.click(T)
    await wait(1500)
  })
  await page.keyboard.press('Escape')
  await wait(400)

  // ---------- C. 미완료(접수 중단) 주문 ----------
  await page.goto(BASE + '/orders?g=COLLECTING&r=all')
  await wait(1600)
  await step('C1 미완료 상세', () => page.locator('main tbody tr').first().click(T))
  await step('C2 수정 열림', () => page.getByRole('button', { name: /^수정$|이어서/ }).first().click(T))
  await step('C3 물품 가액 · 박스', async () => {
    const f = await form()
    await f.locator('label:has-text("물품 가액") select').selectOption({ index: 1 }, T)
    await f.getByRole('button', { name: /^소박스.*더하기$/ }).click(T)
  })
  await step('C4 받는 분 · 결제 방식', async () => {
    const f = await form()
    await f.locator('input[role=combobox]').nth(2).fill('오유진', T)
    await f.locator('input[role=combobox]').nth(3).fill('01012345678', T)
    await f.getByText('개인카드', { exact: true }).click(T)
  })
  await step('C5 [접수]', async () => {
    const f = await form()
    await f.getByRole('button', { name: /^접수$/ }).last().click(T)
    await wait(1800)
  })
  await page.keyboard.press('Escape')
  await wait(400)

  // ---------- D. 사원 추가 · 수정 ----------
  await page.goto(BASE + '/companies/18')
  await wait(1800)
  const firstNo = (await page.locator('main tbody tr').first().locator('td').first().innerText().catch(() => '')).trim()
  const secondPhone = (await page.locator('main tbody tr').nth(1).locator('td').nth(4).innerText().catch(() => '')).trim()
  await step('D1 사원 등록 열림', () => page.getByRole('button', { name: /^사원 등록$/ }).first().click(T))
  await step('D2 있는 사번 · 틀린 번호', async () => {
    await dlg().getByLabel('사번').first().fill(firstNo || '1', T)
    await dlg().getByLabel('이름').fill('새사원', T)
    await dlg().getByLabel('전화번호').fill('0101234', T)
  })
  await step('D3 다른 사원이 쓰는 번호', () => dlg().getByLabel('전화번호').fill(secondPhone, T))
  await step('D4 새 사번 · 맞는 번호 · 담당자', async () => {
    await dlg().getByLabel('사번').first().fill('Z9001', T)
    await dlg().getByLabel('전화번호').fill('01077770001', T)
    await dlg().getByRole('button', { name: /^담당자$/ }).click(T)
    await dlg().getByLabel(/상세주소/).fill('1층', T)
  })
  await page.keyboard.press('Escape')
  await wait(500)
  await step('D5 담당자 수정 열림', () => page.locator('main tbody tr').first().getByRole('button', { name: /^수정$/ }).click(T))
  await step('D6 마지막 담당자를 사원으로', () => dlg().getByRole('button', { name: /^사원$/ }).click(T))
  await step('D7 다시 담당자 · 이름 · 상세주소', async () => {
    await dlg().getByRole('button', { name: /^담당자$/ }).click(T)
    await dlg().getByLabel('이름').fill('이름바꿈', T)
    await dlg().getByLabel(/상세주소/).fill('7층 701호', T)
  })
  await step('D8 [저장]', async () => {
    await dlg().getByRole('button', { name: /^저장$/ }).click(T)
    await wait(1800)
  })
  await step('D9 사원 수정 열림', () => page.locator('main tbody tr').nth(1).getByRole('button', { name: /^수정$/ }).click(T))
  await step('D10 담당자로 · 부서 바꿈', async () => {
    await dlg().getByRole('button', { name: /^담당자$/ }).click(T)
    await dlg().locator('select').selectOption({ index: 0 }, T)
  })
  await step('D11 [저장]', async () => {
    await dlg().getByRole('button', { name: /^저장$/ }).click(T)
    await wait(1800)
  })

  // ---------- E. 기업 상세 보기 조작 ----------
  const tab = (re) => page.locator('main button').filter({ hasText: re }).first()
  await step('E1 부서 고름', () => tab(/^총무팀/).click(T))
  await step('E2 담당자만', () => tab(/^담당자\s*\d/).click(T))
  await step('E3 청구 내역', () => tab(/^청구 내역\s*\d/).click(T))
  await step('E4 사원 탭 · 삭제 확인 창', async () => {
    await tab(/^사원\s*\d/).click(T)
    await tab(/^전체 사원/).click(T)
    await wait(500)
    await page.locator('main tbody tr').first().getByRole('button', { name: /^삭제$/ }).click(T)
  })
  await page.keyboard.press('Escape')
  await wait(400)

  // ---------- F. 통화 상세 ----------
  await page.goto(BASE + '/calls/9101')
  await wait(2200)
  await step('F1 통화 상세', async () => {})
  await step('F2 AI 동작 끔', () => tab(/^AI 동작/).click(T))
  await step('F3 AI 동작 켬 · 고객 말 누름', async () => {
    await tab(/^AI 동작/).click(T)
    await tab(/^고객\s*강남구 역삼로/).click(T)
  })

  // ---------- G. 주문 추가 — 월결제이 없는 개인 고객 (물어보고 추가) ----------
  for (const [k, who, answer] of [[1, '박지호', '추가'], [2, '박지호', '취소']]) {
    await page.goto(BASE + '/orders')
    await wait(1500)
    await step(`G${k}-1 주문 추가 · 보내는 분 ${who}`, async () => {
      await page.getByRole('button', { name: /주문 추가/ }).first().click(T)
      await wait(700)
      await combo(0).click()
      await combo(0).fill(who)
      await wait(1300)
      await combo(0).press('ArrowDown')
      await combo(0).press('Enter')
      await wait(1300)
    })
    await step(`G${k}-2 받는 분 · 물품 · 가액`, async () => {
      await combo(2).click()
      await wait(1300)
      await combo(2).press('ArrowDown')
      await combo(2).press('Enter')
      if ((await combo(2).inputValue()) === '') await pickFirst(2, '이')
      await dlg().getByLabel('소박스 개수').fill('1', T)
      await dlg().locator('label:has-text("물품 가액") select').selectOption({ index: 1 }, T)
    })
    await step(`G${k}-3 [접수] → 월결제 추가를 물음`, async () => {
      await dlg().getByRole('button', { name: /^접수$/ }).click(T)
      await wait(1200)
    })
    await step(`G${k}-4 [${answer}]`, async () => {
      await page.locator('dialog[open]').last().getByRole('button', { name: new RegExp(`^${answer}$`) }).click(T)
      await wait(1800)
    })
    await page.keyboard.press('Escape')
    await wait(400)
  }

  console.log('요청', reqs.length, '개')
  for (const r of reqs) console.log('  ', r.after.split(' ')[0], r.m, r.p, JSON.stringify(r.body)?.slice(0, 260))
  console.log('오류', errors.length, errors.slice(0, 3), '| 4xx · 5xx 응답', bad.length, bad.slice(0, 8))
  fs.writeFileSync(OUT, JSON.stringify({ steps, reqs, errors, bad }, null, 1))
  await browser.close()
})().catch((e) => {
  console.log('실패:', String(e.message).slice(0, 300))
  process.exit(1)
})
