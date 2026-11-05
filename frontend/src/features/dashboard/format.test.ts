// 실행: npx tsx src/features/dashboard/format.test.ts  (프레임워크 없이 assert만)
import assert from 'node:assert/strict'
import {
  axisTicks,
  hoursMinutes,
  maxIndex,
  num,
  one,
  two,
  parseOrderNo,
  pctText,
  versionGap,
} from './format'

// 서버가 반올림하지 않은 비율 · 평균 (디자인 예시 수치)
assert.equal(one((51 / 400) * 100), '12.8')
assert.equal(one(214), '214.0')
assert.equal(one(0), '0.0') // 측정된 0은 그대로
assert.equal(one(null), '—') // 미측정 · 분모 0
assert.equal(pctText(21.428), '21.4%')
assert.equal(two(21.428), '21.43') // 응답 대기 카드 표의 평균 대기만
assert.equal(two(null), '—')
assert.equal(pctText(null), '—')
assert.equal(num(1800), '1,800')

assert.equal(hoursMinutes(18000), '5시간 0분')
assert.equal(hoursMinutes(84000), '23시간 20분')
assert.equal(hoursMinutes(2700), '45분')

assert.equal(maxIndex([12, 15, 6, 7, 4, 5, 1, 1]), 1)
assert.equal(maxIndex([0, 0]), -1)
assert.equal(maxIndex([]), -1)

assert.deepEqual(axisTicks(230), [0, 50, 100, 150, 200, 250])
assert.deepEqual(axisTicks(250), [0, 50, 100, 150, 200, 250, 300]) // 맨 위 눈금에 딱 닿으면 한 칸 더 (값 글자 자리)
assert.deepEqual(axisTicks(182.9), [0, 50, 100, 150, 200])
assert.deepEqual(axisTicks(9), [0, 2, 4, 6, 8, 10])
assert.deepEqual(axisTicks(0), [0, 1])

assert.equal(versionGap(230 - 182.9), '현재 버전이 직전 버전보다 접수 1건당 47.1초 짧았어요.')
assert.equal(versionGap(-30), '현재 버전이 직전 버전보다 접수 1건당 30.0초 길었어요.')
assert.equal(versionGap(0.04), '현재 버전과 직전 버전의 접수 1건당 시간이 같았어요.')
assert.equal(versionGap(null), null)

assert.equal(parseOrderNo('DV-10519'), 10519)
assert.equal(parseOrderNo(' dv 00012 '), 12)
assert.equal(parseOrderNo('10519'), 10519)
assert.equal(parseOrderNo('01012345678'), null) // 0으로 시작 = 전화번호
assert.equal(parseOrderNo('DV-'), null)
assert.equal(parseOrderNo('김민'), null)

console.log('format.test.ts OK')
