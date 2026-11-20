import { http, HttpResponse } from 'msw'
import { API_BASE_URL } from '@/shared/api/client'
import { todayYmd } from '@/shared/lib/dateRange'
import { recentQuestionsOf } from './faqHeard'

// 가짜 FAQ · AI 미답변 — 연동 상세명세 10/31 API-26~33 모양 그대로. 메모리에만 있어서 새로고침하면 처음으로
// 예시 질문은 와이어프레임 09 + 디버 FAQ 참고자료([프로젝트] 고정값) 기준. 분류는 10개 ('기타' 추가). 전부 예시
type Faq = {
  faqEntrySeq: number
  category: string
  question: string
  answer: string
  updatedByAdminUserSeq: number
  createdAt: string
  updatedAt: string
}

const CATEGORIES = [
  '접수',
  '수거 일정',
  '물품·박스',
  '포장·파손',
  '배송·운송장',
  '주소',
  '변경·취소',
  '요금·결제',
  '이용 안내',
  '기타',
]

// (분류, 질문, 답변)
export const SEED: [string, string, string][] = [
  [
    '수거 일정',
    '방문 수거는 몇 시까지 오나요?',
    '평일 오전에 접수하면 당일 수거, 오후 접수는 다음 영업일 수거입니다. 기사님 방문 시간은 접수 후 문자로 안내해 드립니다.',
  ],
  [
    // 실서버 FAQ 4번처럼 답변이 마크다운 표인 경우 — 09 답변 띠가 표로 그리는지 확인용
    '접수',
    '주문 상태는 어떻게 나뉘나요?',
    '| 상태 | 뜻 |\n| --- | --- |\n| 접수완료 (notPaid) | 접수는 됐고 아직 결제하지 않은 상태 |\n| 결제완료 (paid) | 결제가 끝났고, 지점이 아직 물건을 받지 않은 상태 |\n| 수령완료 (received) | 지점이 고객의 물건을 받은 상태 |\n| 발송완료 (sent) | 택배사에 넘긴 상태. 이후는 택배사 운송장으로 추적 |\n| 취소완료 (canceled) | 관리자가 취소 요청을 확인하고 승인한 상태 |',
  ],
  [
    '물품·박스',
    '박스 크기는 어떻게 나뉘나요?',
    '서류 · 소박스 · 중박스 · 대박스 · 기타 다섯 가지입니다. 세 변의 합으로 나누며, 접수할 때 기사님이 다시 확인합니다.',
  ],
  [
    '변경·취소',
    '접수를 취소하고 싶어요',
    '수거 기사님이 방문하기 전이면 접수번호나 접수한 전화번호로 바로 취소할 수 있습니다. 기사님이 이미 출발한 뒤에는 상담원에게 연결해 취소를 도와 드립니다.',
  ],
  [
    '변경·취소',
    '받는 분 주소를 바꾸고 싶어요',
    '접수완료 · 결제완료 상태까지는 전화로 바로 바꿀 수 있습니다. 그 뒤에는 취소 후 다시 접수해 주세요.',
  ],
  [
    '변경·취소',
    '수거 날짜를 바꿀 수 있나요?',
    '기사님 방문 전이면 전화로 바꿀 수 있습니다. 접수번호나 접수한 전화번호를 말씀해 주세요.',
  ],
  [
    '배송·운송장',
    '운송장 번호는 어디서 보나요?',
    '수거가 끝나면 접수한 전화번호로 운송장 번호를 문자로 보내 드립니다.',
  ],
  [
    '포장·파손',
    '깨지기 쉬운 물건도 보낼 수 있나요?',
    '보낼 수 있습니다. 완충재로 감싸고 겉면에 파손 주의를 적어 주세요. 파손 시 보상은 물품 가액 기준 최대 50만 원입니다.',
  ],
  [
    '접수',
    '한 번에 여러 개를 보낼 수 있나요?',
    '한 번 접수에 최대 5건까지 보낼 수 있습니다. 그 이상은 나눠서 접수해 주세요.',
  ],
  [
    '수거 일정',
    '수거 희망 시간을 정할 수 있나요?',
    '오전 · 오후 중에 고를 수 있습니다. 정확한 시각 약속은 어렵고, 기사님이 방문 전에 연락드립니다.',
  ],
  [
    '요금·결제',
    '택배 요금은 얼마인가요?',
    '1건당 3,500원(VAT 포함)입니다. 제주는 약 3,000원, 도서산간은 약 5,000원이 추가됩니다.',
  ],
  [
    '접수',
    '접수는 언제 할 수 있나요?',
    '평일 오전 9시부터 오후 6시까지 접수할 수 있습니다. 그 외 시간과 주말 · 공휴일에는 접수가 어렵습니다.',
  ],
  [
    '접수',
    '회원이 아니어도 접수할 수 있나요?',
    '네, 이름과 연락처만 말씀해 주시면 바로 접수됩니다.',
  ],
  [
    '요금·결제',
    '결제는 어떻게 하나요?',
    '월 정산으로 결제됩니다. 기업 고객은 소속 기업 계정으로 합산 청구됩니다.',
  ],
  [
    '물품·박스',
    '보낼 수 없는 물건이 있나요?',
    '현금 · 귀금속 · 위험물 · 동식물 · 냉동 식품은 보낼 수 없습니다. 자세한 목록은 고객센터에서 안내해 드립니다.',
  ],
  [
    '배송·운송장',
    '배송은 며칠 걸리나요?',
    '수거 다음 날 도착이 기본이며, 제주 · 도서산간은 1~2일 더 걸릴 수 있습니다.',
  ],
  [
    '배송·운송장',
    '배송 상태는 어떻게 확인하나요?',
    '운송장 번호로 문자 링크에서 확인할 수 있고, 전화로 접수번호를 말씀하셔도 알려 드립니다.',
  ],
  [
    '주소',
    '지난번 주소로 다시 보낼 수 있나요?',
    '네, "지난번 그 주소로"라고 말씀하시면 이전 접수 주소를 확인해 드리고 그대로 접수합니다.',
  ],
  [
    '포장·파손',
    '포장은 어떻게 해야 하나요?',
    '빈 공간은 완충재로 채우고 테이프로 모든 면을 봉해 주세요. 액체는 밀봉한 뒤 비닐에 한 번 더 싸 주세요.',
  ],
  [
    '배송·운송장',
    '받는 분이 부재중이면 어떻게 되나요?',
    '기사님이 연락한 뒤 문 앞 또는 경비실에 맡기며, 어려우면 다음 날 다시 방문합니다.',
  ],
  [
    '요금·결제',
    '착불로 보낼 수 있나요?',
    '착불은 지원하지 않습니다. 요금은 보내는 분 계정으로 월 정산됩니다.',
  ],
  [
    '포장·파손',
    '물건이 파손되면 보상받을 수 있나요?',
    '접수 때 말씀하신 물품 가액을 기준으로 최대 50만 원까지 보상합니다. 수령 후 3일 안에 고객센터로 알려 주세요.',
  ],
  [
    '이용 안내',
    '고객센터 번호가 어떻게 되나요?',
    '1811-4232입니다. 평일 오전 9시부터 오후 6시까지 운영합니다.',
  ],
  [
    '주소',
    '회사 주소 외 다른 곳으로도 수거 오나요?',
    '네, 접수할 때 수거 주소를 따로 말씀하시면 그곳으로 방문합니다.',
  ],
]

let seq = 0
const faqs: Faq[] = SEED.map(([category, question, answer], i) => {
  const at = new Date(Date.UTC(2026, 9, 1 + i, 0)).toISOString()
  return {
    faqEntrySeq: ++seq,
    category,
    question,
    answer,
    updatedByAdminUserSeq: 1,
    createdAt: at,
    updatedAt: at,
  }
})

const error = (
  status: number,
  code: string,
  message: string,
  details: { field: string; reason: string }[] = [],
) => HttpResponse.json({ error: { code, message, details } }, { status })

const isBlank = (v: unknown) => typeof v !== 'string' || v.trim() === ''
/** 분류 · 질문 · 답변 셋 다 필수 (API-27 · 30 항목 · 33 공통). prefix = 칸 경로 앞부분 ('items.0.') */
const invalidFields = (body: Record<string, unknown>, prefix = '') => {
  const out: { field: string; reason: string }[] = []
  if (!CATEGORIES.includes(String(body.category)))
    out.push({ field: `${prefix}category`, reason: '분류를 골라 주세요.' })
  for (const f of ['question', 'answer'] as const)
    if (isBlank(body[f])) out.push({ field: `${prefix}${f}`, reason: '공백만 입력할 수 없습니다.' })
  return out
}
// 같은 질문 판단 = NFC · 앞뒤 공백 · 연속 공백 · 대소문자 정규화 (§6.2)
const norm = (q: string) => q.normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase()
const takenBy = (question: string, exceptId?: number) =>
  faqs.find((f) => f.faqEntrySeq !== exceptId && norm(f.question) === norm(question))
const duplicateError = () =>
  error(409, 'DUPLICATE_RESOURCE', '같은 질문의 FAQ가 이미 있습니다.', [
    { field: 'question', reason: '같은 질문의 FAQ가 이미 있습니다.' },
  ])
const addFaq = (b: Record<string, unknown>) => {
  const at = new Date().toISOString()
  faqs.push({
    faqEntrySeq: ++seq,
    category: String(b.category),
    question: String(b.question),
    answer: String(b.answer),
    updatedByAdminUserSeq: 1,
    createdAt: at,
    updatedAt: at,
  })
  return seq
}
const pageOf = <T>(items: T[], url: URL) => {
  const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit') ?? 20)))
  const offset = Math.max(0, Number(url.searchParams.get('offset') ?? 0))
  return {
    data: items.slice(offset, offset + limit),
    hasNext: offset + limit < items.length,
    total_count: items.length,
  }
}

// ---------- AI 미답변 가짜 (API-26 · 27 · 28) — features/faq/api/unansweredApi.ts에 있던 메모리 가짜를 옮김 ----------
// 와이어프레임 09_AI미답변 8줄 + 같은 말투 14줄 + 오늘 4줄(01 홈 '처리할 AI 미답변'은 오늘 것만). 통화마다 번호가 따로 있음
// 06 가짜 장면이 있는 건 오늘 두 통화뿐: 9101 강도윤(13:12 시작 — 04 · 06 · 주문 팝업과 같은 시각) · 9104 (주)한빛상사 — 나머지는 06에서 '찾을 수 없습니다'
type Unanswered = {
  unansweredQuestionSeq: number
  callSessionSeq: number
  callStartedAt: string | null
  occurredAt: string
  offsetSeconds: number | null
  customerSeq: number | null
  customerName: string | null
  callerPhoneNumber: string | null
  questionText: string
  reason: 'KB_NO_ANSWER' | 'KB_UNAVAILABLE' | null
  status: 'OPEN' | 'REGISTERED'
  aiPersonaVersionSeq: number | null
  faqEntrySeq: number | null
}
const today = todayYmd()
// (통화 시작, 이름, 발신번호, 질문, 통화 번호?, 통화 안 위치(초)?)
const UA_SEED: [string, string, string, string, number?, number?][] = [
  ['2025-12-29T13:40:00', '오민재', '01066271180', '어… 대형 두 개… 음, 같이 보내면 할인 돼요?'], // 작년 = 날짜 · 시각 두 줄
  ['2026-10-19T15:22:00', '한소율', '01066041975', '착불로 보내면 받는 사람이 얼마 내요?'],
  ['2026-10-19T16:40:00', '정하은', '01033496021', '박스를 따로 살 수 있나요?'],
  ['2026-10-20T11:52:00', '오시우', '01014582209', '문자를 다른 번호로 다시 보내 줄 수 있어요?'],
  ['2026-10-20T12:48:00', '배서윤', '01030875512', '제주도로 보내면 추가 요금이 얼마나 붙어요?'],
  ['2026-10-20T12:48:00', '배서윤', '01030875512', '제주까지는 며칠 걸려요?'],
  ['2026-10-20T13:05:00', '김민준', '01044712058', '주말에도 수거 와요?'],
  [`${today}T14:33:00`, '(주)한빛상사', '01055219032', '기사님 오늘 몇 시쯤 도착하세요?', 9104], // 06 문의 장면
  ['2026-10-20T15:04:00', '이도현', '01027719384', '반품 접수도 이 번호로 하면 돼요?'],
  ['2026-10-20T15:18:00', '최서진', '01090223317', '음… 그 냉장고 같은 큰 거는 안 되죠?'],
  ['2026-10-20T15:31:00', '강예린', '01055870264', '영수증 같은 거 문자로 받을 수 있나요?'],
  [
    '2026-10-20T15:47:00',
    '(주)도담물류',
    '01073326150',
    '매주 같은 시간에 수거 오게 예약할 수 있어요?',
  ],
  ['2026-10-20T16:02:00', '윤지호', '01038825571', '보낸 거 지금 어디쯤 있는지 알 수 있어요?'],
  ['2026-10-20T16:15:00', '송하린', '01061147729', '포장 박스에 주소를 직접 써야 돼요?'],
  ['2026-10-20T16:29:00', '임건우', '01029964410', '해외로도 보낼 수 있어요?'],
  ['2026-10-20T16:40:00', '노유나', '01084430168', '카드 말고 계좌이체로 해도 돼요?'],
  [
    '2026-10-20T16:52:00',
    '문재원',
    '01046619283',
    '어… 아까 접수한 거, 그거 시간 좀 바꿀 수 있나?',
  ],
  ['2026-10-20T17:06:00', '장서아', '01057712946', '경비실에 맡겨 두면 가져가 주시나요?'],
  [`${today}T13:12:00`, '강도윤', '01066382047', '착불로 보내면 받는 사람이 얼마 내요?', 9101, 94], // 06 기본 장면 01:34의 질문
  ['2026-10-20T17:33:00', '권도윤', '01069935512', '깨지기 쉬운 거라고 표시해 주실 수 있어요?'],
  ['2026-10-20T17:41:00', '신하준', '01033380075', '수거 기사님 전화번호 알 수 있을까요?'],
  ['2026-10-20T17:55:00', '홍예준', '01092258841', '그… 동생 이름으로 보내도 되나요?'],
  [`${today}T09:12:00`, '서지안', '01024417730', '오늘 접수하면 내일 도착해요?'],
  [`${today}T10:05:00`, '유하람', '01058823164', '음… 박스 없이 그냥 봉투로 보내도 돼요?'],
  [`${today}T10:47:00`, '(주)새봄식품', '01031167745', '아이스박스는 몇 개까지 한 번에 돼요?'],
  [`${today}T11:30:00`, '진우석', '01067702218', '받는 분이 집에 없으면 어떻게 돼요?'],
]
// 사유 (미답변 사유 연동): 10/19까지 = 사유 연동 전에 쌓인 질문(미분류 null) · 10/20 15시대와 9104 통화 = 검색 서버가 멈춘 때(검색 장애) · 나머지 = 근거 부족
const reasonOf = (at: string, call?: number): Unanswered['reason'] =>
  at < '2026-10-20'
    ? null
    : at.startsWith('2026-10-20T15') || call === 9104
      ? 'KB_UNAVAILABLE'
      : 'KB_NO_ANSWER'
const unanswered: Unanswered[] = UA_SEED.map(([at, name, phone, question, call, offset], i) => {
  const startedAt = new Date(`${at}+09:00`).toISOString()
  return {
    unansweredQuestionSeq: 7001 + i,
    callSessionSeq: call ?? 9300 + i,
    callStartedAt: startedAt,
    occurredAt: new Date(Date.parse(startedAt) + (offset ?? 0) * 1000).toISOString(),
    offsetSeconds: offset ?? null,
    customerSeq: null,
    customerName: name,
    callerPhoneNumber: phone,
    questionText: question,
    reason: reasonOf(at, call),
    status: 'OPEN',
    aiPersonaVersionSeq: null,
    faqEntrySeq: null,
  }
})
/** 이 통화에서 AI가 답하지 못한 질문 — 가짜 통화 대화가 그 질문을 실제로 담게 (calls.ts) */
export const unansweredOfCall = (call: number) =>
  unanswered
    .filter((u) => u.callSessionSeq === call)
    .map((u) => ({ seq: u.unansweredQuestionSeq, question: u.questionText, reason: u.reason }))

const deleted = new Set<number>() // 지운 질문 번호 (서버는 DELETED 상태로 남기고 목록에서 뺌)
const edited = new Set<number>() // 내용이 바뀐 FAQ — 서버는 고객 질문 사례를 비움
const sameContent = (f: Faq, b: Record<string, unknown>) =>
  f.category === b.category && f.question === b.question && f.answer === b.answer

export const faqHandlers = [
  // API-29 — 질문 · 답변 부분 검색(대소문자 무시) · 분류, FAQ 번호 오름차순
  http.get(`${API_BASE_URL}/faqs`, ({ request }) => {
    const url = new URL(request.url)
    const q = (url.searchParams.get('q') ?? '').trim().toLowerCase()
    const category = url.searchParams.get('category')
    const hit = faqs
      .filter(
        (f) =>
          (!q || f.question.toLowerCase().includes(q) || f.answer.toLowerCase().includes(q)) &&
          (!category || f.category === category),
      )
      .sort((a, b) => a.faqEntrySeq - b.faqEntrySeq)
    return HttpResponse.json(pageOf(hit, url))
  }),
  // FAQ 상세 + 고객 질문 사례 (연동) — recentQuestions 최대 10 · 최신순, 없으면 [] (null 아님)
  http.get(`${API_BASE_URL}/faqs/:id`, ({ params }) => {
    const faq = faqs.find((f) => f.faqEntrySeq === Number(params.id))
    if (!faq) return error(404, 'NOT_FOUND', 'FAQ가 없습니다.')
    const recentQuestions = edited.has(faq.faqEntrySeq) ? [] : recentQuestionsOf(faq)
    return HttpResponse.json({ data: { ...faq, recentQuestions }, meta: { requestId: 'mock' } })
  }),
  // API-30 — 한 건도 items 배열. 전부 저장하거나 전부 거절
  http.post(`${API_BASE_URL}/faqs`, async ({ request }) => {
    const body = (await request.json()) as { items?: Record<string, unknown>[] }
    const items = body.items
    if (!Array.isArray(items) || items.length < 1 || items.length > 100)
      return error(400, 'INVALID_REQUEST', '입력값을 확인해 주세요.', [
        { field: 'items', reason: '1~100건을 보내 주세요.' },
      ])
    const details = items.flatMap((it, i) => invalidFields(it, `items.${i}.`))
    if (details.length) return error(400, 'INVALID_REQUEST', '입력값을 확인해 주세요.', details)
    const qs = items.map((it) => norm(String(it.question)))
    if (new Set(qs).size !== qs.length || items.some((it) => takenBy(String(it.question))))
      return duplicateError()
    items.forEach(addFaq)
    return new HttpResponse(null, { status: 204 })
  }),
  // API-33 — 세 칸 모두 필수 (부분 수정 없음)
  http.patch(`${API_BASE_URL}/faqs/:id`, async ({ request, params }) => {
    const faq = faqs.find((f) => f.faqEntrySeq === Number(params.id))
    if (!faq) return error(404, 'NOT_FOUND', 'FAQ가 없습니다.')
    const body = (await request.json()) as Record<string, unknown>
    const details = invalidFields(body)
    if (details.length) return error(400, 'INVALID_REQUEST', '입력값을 확인해 주세요.', details)
    if (takenBy(String(body.question), faq.faqEntrySeq)) return duplicateError()
    if (!sameContent(faq, body)) edited.add(faq.faqEntrySeq) // 저장값이 바뀌면 사례를 비움 (같으면 그대로)
    faq.category = String(body.category)
    faq.question = String(body.question)
    faq.answer = String(body.answer)
    faq.updatedAt = new Date().toISOString()
    return new HttpResponse(null, { status: 204 })
  }),
  // API-31 — 번호 배열 본문, 하나라도 없으면 전체 404
  http.delete(`${API_BASE_URL}/faqs`, async ({ request }) => {
    const body = (await request.json()) as { faqEntrySeqs?: number[] }
    const ids = body.faqEntrySeqs
    if (
      !Array.isArray(ids) ||
      ids.length < 1 ||
      ids.length > 100 ||
      new Set(ids).size !== ids.length
    )
      return error(400, 'INVALID_REQUEST', '입력값을 확인해 주세요.')
    if (ids.some((id) => !faqs.some((f) => f.faqEntrySeq === id)))
      return error(404, 'NOT_FOUND', '삭제할 FAQ가 없습니다.')
    for (const id of ids)
      faqs.splice(
        faqs.findIndex((f) => f.faqEntrySeq === id),
        1,
      )
    return new HttpResponse(null, { status: 204 })
  }),

  // API-26 — 기본 OPEN, 질문 · 고객 이름 · 발신번호 부분 검색, 통화 번호, 기간(from 포함 · to 미포함), 오래된 통화부터 (시각 모름은 뒤)
  http.get(`${API_BASE_URL}/unanswered-questions`, ({ request }) => {
    const url = new URL(request.url)
    const status = url.searchParams.get('status') ?? 'OPEN'
    const q = (url.searchParams.get('q') ?? '').trim().toLowerCase()
    const call = url.searchParams.get('callSessionSeq')
    const from = url.searchParams.get('from')
    const to = url.searchParams.get('to')
    const at = (u: Unanswered) => (u.callStartedAt ? Date.parse(u.callStartedAt) : Infinity)
    const hit = unanswered
      .filter(
        (u) =>
          !deleted.has(u.unansweredQuestionSeq) &&
          u.status === status &&
          (!call || u.callSessionSeq === Number(call)) &&
          (!q ||
            u.questionText.toLowerCase().includes(q) ||
            (u.customerName ?? '').toLowerCase().includes(q) ||
            (u.callerPhoneNumber ?? '').includes(q)) &&
          (!from || !to || (at(u) >= Date.parse(from) && at(u) < Date.parse(to))),
      )
      .sort((a, b) => (at(a) === at(b) ? 0 : at(a) < at(b) ? -1 : 1))
    return HttpResponse.json(pageOf(hit, url))
  }),
  // API-27 — FAQ 만들기 + REGISTERED를 한 번에. 같은 내용 재시도는 204, 다른 내용은 409
  http.post(`${API_BASE_URL}/unanswered-questions/:id/faqs`, async ({ request, params }) => {
    const id = Number(params.id)
    const u = unanswered.find((x) => x.unansweredQuestionSeq === id && !deleted.has(id))
    if (!u) return error(404, 'NOT_FOUND', '미답변 질문이 없습니다.')
    const body = (await request.json()) as Record<string, unknown>
    const details = invalidFields(body)
    if (details.length) return error(400, 'INVALID_REQUEST', '입력값을 확인해 주세요.', details)
    if (u.status === 'REGISTERED') {
      const made = faqs.find((f) => f.faqEntrySeq === u.faqEntrySeq)
      return made && sameContent(made, body)
        ? new HttpResponse(null, { status: 204 })
        : error(409, 'INVALID_STATE', '이미 FAQ로 바꾼 질문입니다.')
    }
    if (takenBy(String(body.question))) return duplicateError()
    u.faqEntrySeq = addFaq(body)
    u.status = 'REGISTERED'
    return new HttpResponse(null, { status: 204 })
  }),
  // API-28 — OPEN만 삭제, 이미 지웠으면 204, FAQ로 바꾼 질문은 409
  // 배열 하나 = 한 트랜잭션: 하나라도 없거나 REGISTERED면 아무것도 안 지움
  http.delete(`${API_BASE_URL}/unanswered-questions`, async ({ request }) => {
    const ids = ((await request.json()) as { unansweredQuestionSeqs: number[] })
      .unansweredQuestionSeqs
    const targets = ids.map((id) => unanswered.find((x) => x.unansweredQuestionSeq === id))
    if (targets.some((u) => !u)) return error(404, 'NOT_FOUND', '미답변 질문이 없습니다.')
    // 이미 지운 질문은 REGISTERED 검사 없이 통과(204) — 백엔드 규칙
    if (targets.some((u) => u!.status === 'REGISTERED' && !deleted.has(u!.unansweredQuestionSeq)))
      return error(409, 'INVALID_STATE', 'FAQ로 바꾼 질문은 삭제할 수 없습니다.')
    for (const u of targets) deleted.add(u!.unansweredQuestionSeq)
    return new HttpResponse(null, { status: 204 })
  }),
]
