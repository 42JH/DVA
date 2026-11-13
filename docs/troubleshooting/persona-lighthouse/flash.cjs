// 화면을 처음 열 때 띠 글과 프롬프트 칸 잠김이 어떻게 바뀌는지 — 프레임마다 보고 달라질 때만 적음
// 실행: node flash.cjs <주소,주소> [횟수]
const { chromium } = require(process.env.PW_CORE ?? 'playwright-core')
;(async () => {
  const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' })
  for (const base of process.argv[2].split(',')) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
    await ctx.addInitScript(() => {
      const seen = (window.__seen = [])
      let last = ''
      const tick = () => {
        const band = document.querySelector('main [class*="fff9ef"], main [class*="f1faf5"]')
        const box = document.querySelector('main textarea')
        const now = JSON.stringify([
          band ? band.innerText.replace(/\s+/g, ' ').slice(0, 44) : '띠 없음',
          box ? (box.readOnly || box.disabled ? '칸 잠김' : '칸 열림') : '칸 없음',
        ])
        if (now !== last) seen.push([Math.round(performance.now()), (last = now)])
        requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    })
    const page = await ctx.newPage()
    await page.goto(base + '/login')
    await page.evaluate(() => localStorage.setItem('dva.sessionExpiresAt', new Date(Date.now() + 9 * 3600e3).toISOString()))
    for (let i = 0; i < Number(process.argv[3] ?? 3); i++) {
      await page.goto(base + '/personas')
      await page.waitForTimeout(1800)
      const seen = await page.evaluate(() => window.__seen)
      console.log(base, `${i + 1}회:`, seen.map(([t, s]) => `${t}ms ${JSON.parse(s).join(' · ')}`).join('  →  '))
    }
    await ctx.close()
  }
  await browser.close()
})()
