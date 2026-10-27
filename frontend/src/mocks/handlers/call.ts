import { http, HttpResponse } from 'msw'
import { API_BASE_URL } from '@/shared/api/client'

// 가짜 통화 상세 — 와이어프레임 06 예시 장면 그대로. 통화 9101 = 주문 10519 (강도윤 · 10.20 13:12 · 3분 40초)
// AI가 받는 분 번호를 두 번 못 알아들어 다시 묻자 고객이 짜증(불만 감지) → 접수는 성공.
// 받는 분 상세주소 402호로 접수 → 고객이 15:02 통화(9102)에서 1402호로 바꿔 달라고 함 → AI가 바로 반영 (수정됨 · AI 상담원)
// 명세에 없는 값(outcome · persona · complaints · action · edits)은 BE 요청안 모양 — 모두 예시
const CALL_SEQ = 9101
const ORDER_SEQ = 10519
const STARTED = '2026-10-20T13:12:08+09:00'
const at = (sec: number) => new Date(Date.parse(STARTED) + sec * 1000).toISOString()

// (통화 안 초, 화자, 내용, AI 동작 종류)
const SCRIPT: [number, 'AI' | 'CUSTOMER', string, ('SAVE' | 'SEARCH' | 'SEND')?][] = [
  [0, 'AI', '안녕하세요, 디버 택배 접수입니다. 보내는 분 성함을 말씀해 주세요.'],
  [5, 'CUSTOMER', '강도윤이요.'],
  [6, 'AI', 'origin.name = 강도윤', 'SAVE'],
  [7, 'AI', '물건을 가져갈 주소를 말씀해 주세요.'],
  [11, 'CUSTOMER', '강남구 역삼로 150, 5층이에요.'],
  [13, 'AI', "주소 검색 '역삼로 150' → 결과 1건", 'SEARCH'],
  [14, 'AI', 'origin.roadAddress = 서울 강남구 역삼로 150', 'SAVE'],
  [14, 'AI', 'origin.detailAddress = 5호', 'SAVE'],
  [15, 'AI', '서울 강남구 역삼로 150, 5호 맞으실까요?'],
  [19, 'CUSTOMER', '네.'],
  [20, 'AI', '받는 분 성함과 전화번호를 말씀해 주세요.'],
  [25, 'CUSTOMER', '이영희, 공일공 이삼사오 육칠팔구요.'],
  [30, 'AI', 'destination.name = 이영희', 'SAVE'],
  [31, 'AI', '받는 분 전화번호를 다시 말씀해 주세요.'],
  [34, 'CUSTOMER', '공일공 이삼사오 육칠팔구요.'],
  [38, 'AI', '죄송합니다. 전화번호를 한 번 더 말씀해 주세요.'],
  [42, 'CUSTOMER', '아니, 몇 번을 말해야 돼요? 공일공 이삼사오 육칠팔구라고요.'],
  [48, 'AI', 'destination.phoneNumber = 01023456789', 'SAVE'],
  [49, 'AI', '받는 분 번호 010-2345-6789 맞으실까요?'],
  [53, 'CUSTOMER', '네. 받는 곳은 마포구 독막로 301이에요.'],
  [57, 'AI', "주소 검색 '독막로 301' → 결과 1건", 'SEARCH'],
  [58, 'AI', 'destination.roadAddress = 서울 마포구 독막로 301', 'SAVE'],
  [59, 'AI', '서울 마포구 독막로 301 맞으실까요? 상세주소가 있으면 말씀해 주세요.'],
  [65, 'CUSTOMER', '402호요.'],
  [66, 'AI', 'destination.detailAddress = 402호', 'SAVE'],
  [67, 'AI', '물건은 언제 가져가면 될까요?'],
  [71, 'CUSTOMER', '내일 오전 9시에 와 주세요.'],
  [73, 'AI', '10월 21일 수요일 오전 9시 맞으실까요?'],
  [77, 'CUSTOMER', '네.'],
  [78, 'AI', '보내실 물건은 서류, 소형, 중형, 대형 중 어떤 크기인가요?'],
  [84, 'CUSTOMER', '서류 하나요.'],
  [86, 'AI', '배송 요청 사항이 있으시면 말씀해 주세요.'],
  [90, 'CUSTOMER', '경비실에 맡겨 주세요.'],
  [92, 'AI', '경비실에 맡겨 달라고 적어 둘게요.'],
  [217, 'AI', '전송 → 디버 접수번호 K2M7Q9XA', 'SEND'],
]

const utterances = SCRIPT.map(([sec, speaker, text, action], i) => ({
  callUtteranceSeq: 50000 + i,
  utteranceOrder: i + 1,
  speaker,
  utteranceText: text,
  lastSentenceSeq: 1,
  receivedAt: at(sec),
  ...(action ? { action } : {}),
}))

const call = {
  callSessionSeq: CALL_SEQ,
  providerCallId: 'pbx-20261020-131208-0042',
  callerPhoneNumber: '01066382047',
  orderSeq: ORDER_SEQ,
  startedAt: STARTED,
  endedAt: at(220),
  endReason: 'COMPLETED',
  handoff: null,
  outcome: 'SUCCESS',
  persona: { name: '빠른 접수형', version: 6 },
  // 묶음 = AI가 다시 물은 00:31(14번째) ~ 고객이 짜증 낸 00:42(17번째)
  complaints: [
    {
      kind: '되묻기 반복',
      reason: '번호를 세 번 말하게 되자 짜증 냄',
      fromUtterance: 14,
      toUtterance: 17,
    },
  ],
}

const address = (name: string, phone: string, road: string, detail: string) => ({
  name,
  phoneNumber: phone,
  roadAddress: road,
  jibunAddress: road,
  detailAddress: detail,
  dongName: '',
  postalCode: '',
  latitude: 37.5,
  longitude: 127.0,
})

const order = {
  orderSeq: ORDER_SEQ,
  customerSeq: 301,
  paymentMethodType: 'credit',
  pickupRequestedAt: '2026-10-21T09:00:00+09:00',
  status: 'ACCEPTED',
  version: 3,
  parcelNo: 'K2M7Q9XA',
  dverReceivedAt: at(218),
  createdAt: STARTED,
  updatedAt: '2026-10-20T15:02:00+09:00',
  parcels: [
    {
      orderParcelSeq: 7001,
      orderSeq: ORDER_SEQ,
      parcelPosition: 0,
      origin: address('강도윤', '01066382047', '서울 강남구 역삼로 150', '5호'), // AI가 '5층'을 '5호'로 잘못 들음 → 관리자가 06에서 고치는 예시
      destination: address('이영희', '01023456789', '서울 마포구 독막로 301', '1402호'),
      originPin: null,
      documentCount: 1,
      smallBoxCount: 0,
      mediumBoxCount: 0,
      bigBoxCount: 0,
      otherItemDescription: '',
      clientComment: '경비실에 맡겨 주세요',
      notifiedPrice: 3500,
      itemPrice: null,
      shipment: null,
    },
  ],
  edits: [
    {
      field: 'destination.detailAddress',
      before: '402호',
      after: '1402호',
      editedBy: { kind: 'AI', name: 'AI 상담원' },
      editedAt: '2026-10-20T15:02:00+09:00',
      requestCallSessionSeq: 9102,
    },
  ],
}

const notFound = () =>
  HttpResponse.json(
    { error: { code: 'NOT_FOUND', message: '대상이 없습니다.', details: [] } },
    { status: 404 },
  )

export const callHandlers = [
  // CALL-08
  http.get(`${API_BASE_URL}/calls/:id`, ({ params }) =>
    Number(params.id) === CALL_SEQ
      ? HttpResponse.json({
          data: { call, recordings: [{ recordingSeq: 8801, durationSec: 220 }] },
        })
      : notFound(),
  ),
  // CALL-09
  http.get(`${API_BASE_URL}/calls/:id/transcript`, ({ params }) =>
    Number(params.id) === CALL_SEQ
      ? HttpResponse.json({ data: utterances, hasNext: false })
      : notFound(),
  ),
  // ORD-03
  http.get(`${API_BASE_URL}/orders/:id`, ({ params }) =>
    Number(params.id) === ORDER_SEQ ? HttpResponse.json({ data: order }) : notFound(),
  ),
  // ORD-04 — 관리자 수정 (칸 하나). 수정 로그에 관리자 이름으로 한 줄 추가 (BE 요청안)
  http.patch(`${API_BASE_URL}/orders/:id`, async ({ request, params }) => {
    if (Number(params.id) !== ORDER_SEQ) return notFound()
    const body = (await request.json()) as {
      expectedVersion: number
      parcels: {
        clientComment?: string
        origin?: Record<string, string>
        destination?: Record<string, string>
      }[]
    }
    if (body.expectedVersion !== order.version)
      return HttpResponse.json(
        {
          error: {
            code: 'VERSION_CONFLICT',
            message: '다른 곳에서 먼저 바뀌었습니다. 새로고침 후 다시 시도해 주세요.',
            details: [],
          },
        },
        { status: 409 },
      )
    const change = body.parcels[0]
    const parcel = order.parcels[0]
    const now = new Date().toISOString()
    const log = (field: string, before: string, after: string) =>
      order.edits.push({
        field,
        before,
        after,
        editedBy: { kind: 'ADMIN', name: '이재훈' },
        editedAt: now,
      } as (typeof order.edits)[number])
    if (change.clientComment !== undefined) {
      log('clientComment', parcel.clientComment, change.clientComment)
      parcel.clientComment = change.clientComment
    }
    for (const side of ['origin', 'destination'] as const) {
      for (const [key, value] of Object.entries(change[side] ?? {})) {
        const addr = parcel[side] as unknown as Record<string, string>
        log(`${side}.${key}`, addr[key] ?? '', value)
        addr[key] = value
      }
    }
    order.version += 1
    order.updatedAt = now
    return HttpResponse.json({ data: { orderSeq: order.orderSeq, version: order.version } }) // 명세 ORD-04: 200 + 새 version
  }),
]
