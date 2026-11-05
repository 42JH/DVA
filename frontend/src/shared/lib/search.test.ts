// 실행: npx tsx src/shared/lib/search.test.ts  (프레임워크 없이 assert만)
import assert from 'node:assert/strict'
import { findKo, matchKo, parseOrderNo, phoneDigits, suggest } from './search'

// 띄어쓰기 · 대소문자 무시
assert.ok(matchKo('수거 시간이 언제예요?', '수거시간'))
assert.ok(matchKo('수거시간', '수거 시간'))
assert.ok(matchKo('FAQ 목록', 'faq'))
assert.ok(matchKo('아무거나', '')) // 빈 검색어
assert.ok(!matchKo('수거 시간', '배송'))

// 초성 · 섞어 쓰기
assert.ok(matchKo('강도윤', 'ㄱㄷㅇ'))
assert.ok(matchKo('수거 시간', 'ㅅㄱ'))
assert.ok(matchKo('수거 시간', '수ㄱ'))
assert.ok(matchKo('(주)한빛상사', 'ㅎㅂ'))
assert.ok(!matchKo('강도윤', 'ㄱㅇ')) // 붙어 있어야 함

// 치는 중인 마지막 글자 (받침 전)
assert.ok(matchKo('강도윤', '강도유'))
assert.ok(matchKo('착불', '차'))
assert.ok(!matchKo('강도윤', '강도유ㄴ')) // 마지막이 초성이면 다음 글자와 비교
assert.ok(!matchKo('강도윤 고객', '도유고')) // 가운데 글자는 받침까지 같아야 함
// 다음 글자 첫소리가 받침으로 잠깐 붙은 모양 (IME 조합 중)
assert.ok(matchKo('강도윤', '강동'))
assert.ok(matchKo('수거 시간', '숙'))
assert.ok(matchKo('수거 시간', '수것'))
assert.ok(matchKo('수거 시간', '수거식'))
assert.ok(!matchKo('바나나', '박')) // 다음 글자 첫소리(ㄴ)가 받침(ㄱ)과 다르면 안 맞음
assert.ok(!matchKo('수', '숙')) // 다음 글자가 없으면 안 맞음
assert.ok(matchKo('수거', '수ㄱ'))

// 전화번호는 숫자만 친 경우에만
assert.equal(phoneDigits('010-6638'), '0106638')
assert.equal(phoneDigits(' 2047 '), '2047')
assert.equal(phoneDigits('3시'), '')
assert.equal(phoneDigits('제주 2일'), '')

// 추천: 맞는 것만 · 중복 없이 · 똑같은 건 빼고 · 최대 n
assert.deepEqual(suggest(['강도윤', '강도윤', '강하늘', '박지호'], 'ㄱ'), ['강도윤', '강하늘'])
assert.deepEqual(suggest(['강도윤', '강하늘'], '강도윤'), [])
assert.deepEqual(suggest(['a1', 'a2', 'a3'], 'a', 2), ['a1', 'a2'])
assert.deepEqual(suggest(['강도윤'], '  '), [])

console.log('search.test.ts OK')

// 하이라이트 자리 — 원래 글(띄어쓰기 포함) 기준 [시작, 끝), 띄어쓰기 · 초성 규칙은 matchKo와 같음 (09 FAQ 검색, 11/04)
assert.deepEqual(findKo('박스 크기는 어떻게', '박스크기'), [[0, 5]])
assert.deepEqual(findKo('수거 박스, 박스', '박스'), [
  [3, 5],
  [7, 9],
])
assert.deepEqual(findKo('방문 수거', 'ㅂㅁ'), [[0, 2]])
assert.deepEqual(findKo('FAQ 목록', 'faq'), [[0, 3]])
assert.deepEqual(findKo('아무거나', ''), [])

// 상단바 검색 — 주문번호 (11/05 통계 → 공용 검색으로 옮김)
assert.equal(parseOrderNo('DV-10519'), 10519)
assert.equal(parseOrderNo(' dv 00012 '), 12)
assert.equal(parseOrderNo('10519'), 10519)
assert.equal(parseOrderNo('01012345678'), null) // 0으로 시작 = 전화번호
assert.equal(parseOrderNo('DV-'), null)
assert.equal(parseOrderNo('김민'), null)
