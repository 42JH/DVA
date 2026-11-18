// 실행: npx tsx src/features/call/actionText.test.ts  (프레임워크 없이 assert만)
import assert from 'node:assert/strict'
import { faqResultText, groupActions, refineAction } from './actionText'
import type { AiAction } from './callDto'

// 실서버에서 본 요약 (11/05 사용자 화면)
assert.equal(refineAction('실패·재질문: ADDRESS_NOT_FOUND'), '주소를 찾지 못해 다시 물음')
assert.equal(refineAction('실패·재질문: DEST_NONE'), '받는 곳 후보가 없어 다시 물음')
assert.equal(refineAction('실패·재질문: KB_UNAVAILABLE'), 'FAQ 검색 장애')
assert.equal(refineAction('실패·재질문: MISSING_RECEIVER_NAME'), '빠진 정보를 다시 물음') // 표에 없는 MISSING_*
assert.equal(refineAction('실패·재질문: SOMETHING_NEW'), '다시 물음') // 모르는 코드
assert.equal(refineAction('실패·재질문: unavailable'), '일시 장애') // 코드 없이 상태만
assert.equal(refineAction('기록: 2개 항목'), '항목 2개 기록')
assert.equal(refineAction('통화 결과 전송: COLLECTING'), '주문 전송: 미완료 주문')
assert.equal(refineAction('통화 결과 전송: notPaid'), '주문 전송: 결제 대기')
assert.equal(refineAction('통화 결과 전송: 응답 없음'), '주문 전송: 응답 없음')
assert.equal(refineAction('등록 고객'), '고객 조회: 등록 고객')
assert.equal(refineAction('FAQ 근거 있음'), 'FAQ 검색 후보 있음') // 지난 기록 — 답을 찾았다는 뜻 아님
assert.equal(refineAction('FAQ 검색 후보 3건'), 'FAQ 검색 후보 3건') // 새 요약은 그대로
assert.equal(faqResultText('FAQ_ANSWERED', null), '근거 있음')
assert.equal(faqResultText('QUESTION_UNANSWERED', 'KB_NO_ANSWER'), '근거 부족')
assert.equal(faqResultText('QUESTION_UNANSWERED', 'KB_UNAVAILABLE'), '서버 에러')
assert.equal(faqResultText('QUESTION_UNANSWERED', null), '서버 에러')
assert.equal(refineAction('보내는 분 이름 = 강도윤'), '보내는 분 이름 = 강도윤') // 이미 사람 말이면 그대로

// 연달아 나온 '기록'만 한 줄로 (합계), 사이에 다른 동작이 끼면 끊김. 실패한 기록(실패·재질문)은 안 합침
const a = (order: number, kind: AiAction['kind'], text: string): AiAction => ({
  order,
  atSec: order,
  kind,
  text,
})
const g = groupActions([
  a(1, 'FIELD_SAVED', '실패·재질문: ADDRESS_NOT_FOUND'),
  a(2, 'FIELD_SAVED', '기록: 1개 항목'),
  a(3, 'FIELD_SAVED', '기록: 2개 항목'),
  a(4, 'FIELD_SAVED', '기록: 1개 항목'),
  a(5, 'ADDRESS_SEARCH', '실패·재질문: DEST_NONE'),
  a(6, 'FIELD_SAVED', '기록: 1개 항목'),
  a(7, 'ORDER_SUBMITTED', '통화 결과 전송: COLLECTING'),
])
assert.deepEqual(
  g.map((x) => [x.head.order, x.all.map((y) => y.order), x.text]),
  [
    [1, [1], '주소를 찾지 못해 다시 물음'],
    [2, [2, 3, 4], '항목 4개 기록'],
    [5, [5], '받는 곳 후보가 없어 다시 물음'],
    [6, [6], '항목 1개 기록'],
    [7, [7], '주문 전송: 미완료 주문'],
  ],
)
