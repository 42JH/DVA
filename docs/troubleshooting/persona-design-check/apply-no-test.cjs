// 반영 전 시험을 꺼 둔 동안(TEST_BEFORE_APPLY, 11/15 임시) — [통화에 반영] · [통화에 사용하기]가 시험 없이 바로 확인 창인지 (가짜 서버 5174)
// 시험 시작 요청(POST /persona-check/...)이 하나도 안 나가는지 세고, 시나리오 시험 화면은 그대로 열리는지 봄
// 실행: node apply-no-test.cjs   (시험을 다시 켠 뒤의 흐름은 VITE_TEST_BEFORE_APPLY=true로 띄운 서버에 flow.cjs)
const { chromium } = require(process.env.PW_CORE ?? 'playwright-core')
const BASE = process.env.QA_BASE || 'http://localhost:5174'
const results = []
const check = (ok, what, extra = '') => {
  results.push(!!ok)
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${what}${extra ? ' — ' + extra : ''}`)
}

;(async () => {
  const b = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' })
  const p = await (await b.newContext({ viewport: { width: 1440, height: 900 } })).newPage()
  const errors = []
  p.on('pageerror', (e) => !/ServiceWorker/.test(e.message) && errors.push(e.message.slice(0, 160)))
  const sent = []
  p.on('request', (r) => r.method() !== 'GET' && r.url().includes('/api/') && sent.push(`${r.method()} ${new URL(r.url()).pathname.replace('/api', '')}`))
  const band = () =>
    p.$eval('article', (a) => a.querySelector('header')?.nextElementSibling?.innerText.replace(/\s*\n\s*/g, ' | ') ?? '').catch(() => '')
  const dlg = () => p.locator('[role=dialog]').innerText().catch(() => '')

  await p.goto(BASE + '/login')
  await p.waitForSelector('input')
  const ins = await p.$$('input')
  await ins[0].fill('admin')
  await ins[1].fill('test1234')
  await p.keyboard.press('Enter')
  await p.waitForURL((u) => !u.pathname.startsWith('/login'))
  await p.goto(BASE + '/personas')
  await p.waitForSelector('article header')
  await p.waitForTimeout(1200)

  // 1) 사용 중 상담가의 반영 전 띠 → [통화에 반영]
  console.log('  band:', await band())
  check(/반영 전/.test(await band()) && !/시험/.test(await band()), '반영 전 띠에 시험 말 없음')
  await p.locator('article button', { hasText: '통화에 반영' }).first().click()
  await p.waitForTimeout(400)
  console.log('  dialog:', (await dlg()).replace(/\n/g, ' | '))
  check(/통화에 반영할까요/.test(await dlg()) && !/시나리오/.test(await dlg()), '[통화에 반영] = 시험 없이 바로 반영 확인 창')
  await p.locator('[role=dialog] button', { hasText: /^반영$/ }).click()
  await p.waitForTimeout(1500)
  console.log('  band(after apply):', await band())
  check(sent.some((s) => /\/personas\/\d+\/activate$/.test(s)), '[반영] = 반영 요청', sent.join(', '))

  // 2) 고쳐서 저장 → 다시 [통화에 반영]도 바로 확인 창
  await p.locator('article section div[tabindex="0"]').first().click()
  await p.locator('article textarea').first().press('Control+End')
  await p.locator('article textarea').first().type(' 고침')
  await p.locator('article header button', { hasText: '저장' }).click()
  await p.waitForTimeout(1500)
  await p.locator('article button', { hasText: '통화에 반영' }).first().click()
  await p.waitForTimeout(400)
  check(/통화에 반영할까요/.test(await dlg()), '고쳐 저장한 뒤 [통화에 반영]도 바로 확인 창')
  await p.locator('[role=dialog] button', { hasText: '취소' }).click()
  await p.waitForTimeout(300)

  // 3) 안 쓰는 상담가 → [통화에 사용하기]
  await p.getByRole('tab', { name: /친절형/ }).click()
  await p.waitForTimeout(1200)
  await p.locator('article header button', { hasText: '통화에 사용하기' }).click()
  await p.waitForTimeout(400)
  console.log('  dialog:', (await dlg()).replace(/\n/g, ' | '))
  check(/통화에 사용할까요/.test(await dlg()), '[통화에 사용하기] = 시험 없이 바로 사용 확인 창')
  await p.locator('[role=dialog] button', { hasText: '취소' }).click()
  await p.waitForTimeout(300)

  check(!sent.some((s) => s.includes('persona-check')), '시험 시작 요청 0개', sent.join(', '))

  // 4) 시나리오 시험 화면은 그대로
  await p.locator('article header button', { hasText: '시나리오 시험' }).click()
  await p.waitForTimeout(1200)
  check(/\/tests\//.test(p.url()), '[시나리오 시험]으로 시험 화면은 그대로 열림', new URL(p.url()).pathname)

  check(errors.length === 0, '화면 오류 없음', errors.join(' / '))
  console.log(`점검 ${results.length}개 중 실패 ${results.filter((x) => !x).length}개`)
  await b.close()
})().catch((e) => {
  console.log('실패:', String(e.message).slice(0, 300))
  process.exit(1)
})
