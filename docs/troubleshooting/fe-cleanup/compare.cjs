// snap.cjs로 남긴 두 폴더 대조 — 글이 같은지, 그림에서 다른 픽셀 수
// 실행: node compare.cjs <전 폴더> <후 폴더>
const { chromium } = require(process.env.PW_CORE ?? 'playwright-core')
const fs = require('fs')
const path = require('path')
const [A, B] = process.argv.slice(2)
;(async () => {
  const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' })
  const page = await browser.newPage()
  let bad = 0
  const names = fs.readdirSync(A).filter((f) => f.endsWith('.txt')).map((f) => f.slice(0, -4))
  for (const n of names) {
    if (!fs.existsSync(path.join(B, n + '.txt'))) { console.log(n, '— 후 폴더에 없음'); bad++; continue }
    const ta = fs.readFileSync(path.join(A, n + '.txt'), 'utf8'), tb = fs.readFileSync(path.join(B, n + '.txt'), 'utf8')
    const pa = fs.readFileSync(path.join(A, n + '.png')), pb = fs.readFileSync(path.join(B, n + '.png'))
    let px = 0
    if (!pa.equals(pb))
      px = await page.evaluate(async ([a, b]) => {
        const load = async (s) => { const i = new Image(); i.src = 'data:image/png;base64,' + s; await i.decode(); const c = new OffscreenCanvas(i.width, i.height); const x = c.getContext('2d'); x.drawImage(i, 0, 0); return x.getImageData(0, 0, i.width, i.height) }
        const [x, y] = [await load(a), await load(b)]
        if (x.width !== y.width || x.height !== y.height) return -1
        let n = 0
        for (let i = 0; i < x.data.length; i += 4) if (x.data[i] !== y.data[i] || x.data[i + 1] !== y.data[i + 1] || x.data[i + 2] !== y.data[i + 2]) n++
        return n
      }, [pa.toString('base64'), pb.toString('base64')])
    const same = ta === tb
    if (!same || px) bad++
    if (!same || px) {
      const la = ta.split('\n'), lb = tb.split('\n')
      const i = la.findIndex((l, k) => l !== lb[k])
      console.log(n, '— 글', same ? '같음' : `다름 (${i + 1}번째 줄: "${(la[i] ?? '').slice(0, 50)}" → "${(lb[i] ?? '').slice(0, 50)}")`, '· 다른 픽셀', px)
    }
  }
  console.log(`화면 ${names.length}개 중 다른 것 ${bad}개`)
  await browser.close()
})()
