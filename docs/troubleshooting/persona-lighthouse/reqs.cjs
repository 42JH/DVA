// 화면을 처음 열 때 부르는 API를 순서대로 — 같은 주소를 두 번 부르는지, 몇 박자(앞 응답을 기다렸다 부르는 묶음)인지
// 실행: node reqs.cjs <주소,주소> [화면,화면]
const { chromium } = require(process.env.PW_CORE ?? 'playwright-core')
;(async () => {
  const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' })
  const out = {}
  for (const base of process.argv[2].split(',')) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
    const page = await ctx.newPage()
    await page.goto(base + '/login')
    await page.evaluate(() => localStorage.setItem('dva.sessionExpiresAt', new Date(Date.now() + 9 * 3600e3).toISOString()))
    for (const p of (process.argv[3] ?? '/personas,/personas/1/tests/6,/personas/1/tests/6/A4').split(',')) {
      const reqs = []
      let t0 = 0
      const on = (r) => {
        const u = new URL(r.url())
        if (u.pathname.startsWith('/api/')) reqs.push({ at: Date.now() - t0, what: `${r.method()} ${u.pathname.replace('/api', '')}` })
      }
      const done = []
      const onDone = (r) => new URL(r.url()).pathname.startsWith('/api/') && !r.url().endsWith('/stream') && done.push(Date.now() - t0)
      page.on('request', on)
      page.on('requestfinished', onDone)
      t0 = Date.now()
      await page.goto(base + p)
      await page.waitForTimeout(2500)
      page.off('request', on)
      page.off('requestfinished', onDone)
      const names = reqs.map((r) => r.what)
      const dup = [...new Set(names.filter((n, i) => names.indexOf(n) !== i))]
      // 박자: 앞 요청과 40ms 넘게 떨어져 시작하면 새 묶음
      let waves = 0
      reqs.forEach((r, i) => (i === 0 || r.at - reqs[i - 1].at > 40) && waves++)
      out[`${base} ${p}`] = { count: reqs.length, dup, waves, lastDoneMs: Math.max(...done) }
      console.log(`\n${base}${p} — 요청 ${reqs.length}개 · 두 번 부른 것 ${dup.length}개 · ${waves}박자 · 마지막 응답 ${Math.max(...done)}ms`)
      console.log(reqs.map((r) => `${String(r.at).padStart(5)}ms ${r.what}`).join('\n'))
    }
    await ctx.close()
  }
  await browser.close()
})()
