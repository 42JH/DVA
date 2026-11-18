// 시안 원본(after.html)을 같은 브라우저로 그려 화면 그림 + 수치를 뽑음 → design/*.png, design.json
const { chromium } = require(process.env.PW_CORE ?? 'playwright-core')
const path = require('path')
const fs = require('fs')
const { STATES, MEASURE } = require('./specs.cjs')
const HTML = path.join(__dirname, 'after.html').replace(/\\/g, '/') // node gen.cjs after.html 로 만듦
const OUT = path.join(__dirname, 'design')
fs.mkdirSync(OUT, { recursive: true })
;(async () => {
  const b = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', ignoreDefaultArgs: ['--hide-scrollbars'] })
  const p = await b.newPage({ viewport: { width: 1500, height: 1000 } })
  await p.goto('file:///' + HTML)
  await p.waitForTimeout(800)
  const names = await p.$$eval('.screen', (xs) => xs.map((x) => x.dataset.name))
  console.log('screens:', names.join(' '))
  for (const n of names) await p.locator(`.screen[data-name="${n}"]`).screenshot({ path: path.join(OUT, n + '.png') })
  const all = {}
  for (const [state, s] of Object.entries(STATES)) {
    all[state] = await p.evaluate(`(${MEASURE.toString()})(${JSON.stringify(`.screen[data-name="${s.design}"]`)}, ${JSON.stringify(s.probes)}, ${JSON.stringify(s.counts || [])}, 'design')`)
    const miss = Object.entries(all[state].probes || {}).filter(([, v]) => !v).map(([k]) => k)
    if (miss.length || all[state].error) console.log(state, 'missing:', all[state].error || miss.join(', '))
  }
  fs.writeFileSync(path.join(__dirname, 'design.json'), JSON.stringify(all, null, 1))
  await b.close()
})()
