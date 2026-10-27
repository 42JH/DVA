import { http, HttpResponse } from 'msw'
import { API_BASE_URL } from '@/shared/api/client'

// 가짜 FAQ — 명세서 FAQ-01 · 02 · 03 그대로 (+ 명세에 없는 DELETE · category). 메모리에만 있어서 새로고침하면 처음으로
// 예시 질문은 와이어프레임 09 + 디버 FAQ 참고자료([프로젝트] 고정값) 기준. 분류는 10/27 확정 9개. 전부 예시
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
]

// (분류, 질문, 답변)
const SEED: [string, string, string][] = [
  [
    '수거 일정',
    '방문 수거는 몇 시까지 오나요?',
    '평일 오전에 접수하면 당일 수거, 오후 접수는 다음 영업일 수거입니다. 기사님 방문 시간은 접수 후 문자로 안내해 드립니다.',
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
/** 명세서 공통 규칙: question/answer 공백 불가 · category는 9개 중 하나. required = 등록(전부 필수) / 아니면 변경(보낸 칸만 검사) */
const invalidFields = (body: Record<string, unknown>, required: boolean) => {
  const out: { field: string; reason: string }[] = []
  for (const f of ['question', 'answer'] as const)
    if (required ? isBlank(body[f]) : body[f] !== undefined && isBlank(body[f]))
      out.push({ field: f, reason: '공백은 허용하지 않습니다.' })
  const c = body.category
  if (
    required ? !CATEGORIES.includes(String(c)) : c !== undefined && !CATEGORIES.includes(String(c))
  )
    out.push({ field: 'category', reason: '분류를 골라 주세요.' })
  return out
}

export const faqHandlers = [
  // FAQ-01
  http.get(`${API_BASE_URL}/faqs`, ({ request }) => {
    const url = new URL(request.url)
    const q = (url.searchParams.get('q') ?? '').trim().toLowerCase()
    const category = url.searchParams.get('category')
    const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit') ?? 20)))
    const offset = Math.max(0, Number(url.searchParams.get('offset') ?? 0))
    const hit = faqs.filter(
      (f) =>
        (!q || f.question.toLowerCase().includes(q) || f.answer.toLowerCase().includes(q)) &&
        (!category || f.category === category),
    )
    return HttpResponse.json({
      data: hit.slice(offset, offset + limit),
      hasNext: offset + limit < hit.length,
    })
  }),
  // FAQ-02
  http.post(`${API_BASE_URL}/faqs`, async ({ request }) => {
    if (!request.headers.get('Idempotency-Key'))
      return error(400, 'INVALID_REQUEST', '멱등키가 없습니다.')
    const body = (await request.json()) as Record<string, unknown>
    const details = invalidFields(body, true)
    if (details.length) return error(400, 'INVALID_REQUEST', '입력값을 확인해 주세요.', details)
    const at = new Date().toISOString()
    faqs.push({
      faqEntrySeq: ++seq,
      category: body.category as string,
      question: (body.question as string).trim(),
      answer: (body.answer as string).trim(),
      updatedByAdminUserSeq: 1,
      createdAt: at,
      updatedAt: at,
    })
    return new HttpResponse(null, { status: 204 })
  }),
  // FAQ-03
  http.patch(`${API_BASE_URL}/faqs/:id`, async ({ request, params }) => {
    const faq = faqs.find((f) => f.faqEntrySeq === Number(params.id))
    if (!faq) return error(404, 'NOT_FOUND', 'FAQ가 없습니다.')
    const body = (await request.json()) as Record<string, unknown>
    const details = invalidFields(body, false)
    if (details.length) return error(400, 'INVALID_REQUEST', '입력값을 확인해 주세요.', details)
    if (typeof body.category === 'string') faq.category = body.category
    if (typeof body.question === 'string') faq.question = body.question.trim()
    if (typeof body.answer === 'string') faq.answer = body.answer.trim()
    faq.updatedAt = new Date().toISOString()
    return new HttpResponse(null, { status: 204 })
  }),
  // 명세서에 없음 — 대조표 요청 사항 (SYSTEM_ADMIN만). BE 확정 전 가짜
  http.delete(`${API_BASE_URL}/faqs/:id`, ({ params }) => {
    const i = faqs.findIndex((f) => f.faqEntrySeq === Number(params.id))
    if (i < 0) return error(404, 'NOT_FOUND', 'FAQ가 없습니다.')
    faqs.splice(i, 1)
    return new HttpResponse(null, { status: 204 })
  }),
]
