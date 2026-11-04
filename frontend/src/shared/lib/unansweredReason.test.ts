// 실행: npx tsx --tsconfig tsconfig.app.json src/shared/lib/unansweredReason.test.ts  (프레임워크 없이 assert만)
import assert from 'node:assert/strict'
import { originOf, unansweredCrumbs, unansweredTo } from './unansweredReason'

// 링크: 지금 화면 주소를 from에 (06은 call도)
assert.equal(
  unansweredTo('/calls?date=2026-11-02'),
  '/faqs/unanswered?from=%2Fcalls%3Fdate%3D2026-11-02',
)
assert.equal(unansweredTo('/calls/9101', 9101), '/faqs/unanswered?call=9101&from=%2Fcalls%2F9101')

// 경로 첫 칸 = 이동 전 화면 (그 주소로 돌아감)
assert.deepEqual(originOf('/calls?date=2026-11-02'), {
  label: '통화',
  to: '/calls?date=2026-11-02',
})
assert.equal(originOf('/calls/9101').label, '통화 상세')
assert.equal(originOf('/orders').label, '주문')
assert.equal(originOf('/faqs?category=접수').label, 'FAQ')
assert.equal(originOf('/faqs/12').label, 'FAQ 상세')
assert.equal(originOf('/faqs/12/edit').label, 'FAQ 수정')
assert.equal(originOf('/dashboard/response-wait').label, '통계')
// 없거나 모르는 화면 · 바깥 주소는 FAQ
assert.deepEqual(originOf(''), { label: 'FAQ', to: '/faqs' })
assert.deepEqual(originOf('//evil.example/x'), { label: 'FAQ', to: '/faqs' })
assert.deepEqual(originOf('https://evil.example'), { label: 'FAQ', to: '/faqs' })
assert.deepEqual(originOf('/ui-kit'), { label: 'FAQ', to: '/faqs' })

// FAQ 작성 경로: 미답변 목록에서 왔으면 그 목록의 from이 첫 칸
const back = unansweredTo('/orders') + '&reason=KB_NO_ANSWER'
assert.deepEqual(unansweredCrumbs(back), [
  { label: '주문', to: '/orders' },
  { label: 'AI 미답변', to: back },
])
assert.equal(unansweredCrumbs('/faqs/unanswered')[0].label, 'FAQ') // from 없는 목록

console.log('unansweredReason.test ok')
