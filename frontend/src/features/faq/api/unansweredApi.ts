// 09 AI 미답변 Model — AI가 통화 중 답하지 못한 고객 질문. React를 모르는 데이터 층
// 명세에 아직 없음 (BE가 명세를 짜서 주기로 함, 10/30) → 지금은 네트워크 없이 메모리 가짜 데이터
// BE 명세가 오면 이 파일의 함수 몸통만 api.get · api.delete로 바꾸면 됨 (훅 · 화면은 그대로)
import { queryOptions } from '@tanstack/react-query'
import { todayYmd } from '@/shared/lib/dateRange'

export interface UnansweredQuestion {
  unansweredQuestionSeq: number
  callSessionSeq: number // 줄을 누르면 그 통화의 06 통화 상세
  startedAt: string // 통화 시작 시각 (ISO 8601)
  customerName: string
  callerNumber: string // 발신번호, 숫자만
  question: string // 고객이 한 말 그대로 (어… 음… 포함) — 다듬는 건 관리자가 [FAQ 추가] 창 질문 칸에서
}

export const unansweredQueries = {
  all: () => ['unanswered'] as const,
  list: () =>
    queryOptions({
      queryKey: [...unansweredQueries.all(), 'list'],
      queryFn: fetchUnanswered,
    }),
}

// 가짜 예시 = 와이어프레임 09_AI미답변 8줄 + 같은 말투 14줄 + 오늘 4줄(01 홈 '처리할 AI 미답변'은 오늘 것만 보여서). 분류 없음 (관리자가 FAQ 추가 창에서 고름)
// 통화마다 번호가 따로 있음 (06 가짜 장면이 있는 건 오늘 두 통화뿐: 9101 강도윤 착불 질문 · 9104 (주)한빛상사) — 나머지 줄은 06에서 '찾을 수 없습니다'
// 06 '처리 내용 › AI 미답변 보기'는 ?call=통화번호 로 와서 그 통화의 질문만 보여 줌 (10/30)
const today = todayYmd()
const SEED: [string, string, string, string, number?][] = [
  ['2025-12-29T13:40', '오민재', '01066271180', '어… 대형 두 개… 음, 같이 보내면 할인 돼요?'], // 작년 = 날짜 · 시각 두 줄
  ['2026-10-19T15:22', '한소율', '01066041975', '착불로 보내면 받는 사람이 얼마 내요?'],
  ['2026-10-19T16:40', '정하은', '01033496021', '박스를 따로 살 수 있나요?'],
  ['2026-10-20T11:52', '오시우', '01014582209', '문자를 다른 번호로 다시 보내 줄 수 있어요?'],
  ['2026-10-20T12:48', '배서윤', '01030875512', '제주도로 보내면 추가 요금이 얼마나 붙어요?'],
  ['2026-10-20T12:48', '배서윤', '01030875512', '제주까지는 며칠 걸려요?'],
  ['2026-10-20T13:05', '김민준', '01044712058', '주말에도 수거 와요?'],
  [`${today}T14:33`, '(주)한빛상사', '01055219032', '기사님 오늘 몇 시쯤 도착하세요?', 9104], // 06 문의 장면
  ['2026-10-20T15:04', '이도현', '01027719384', '반품 접수도 이 번호로 하면 돼요?'],
  ['2026-10-20T15:18', '최서진', '01090223317', '음… 그 냉장고 같은 큰 거는 안 되죠?'],
  ['2026-10-20T15:31', '강예린', '01055870264', '영수증 같은 거 문자로 받을 수 있나요?'],
  [
    '2026-10-20T15:47',
    '(주)도담물류',
    '01073326150',
    '매주 같은 시간에 수거 오게 예약할 수 있어요?',
  ],
  ['2026-10-20T16:02', '윤지호', '01038825571', '보낸 거 지금 어디쯤 있는지 알 수 있어요?'],
  ['2026-10-20T16:15', '송하린', '01061147729', '포장 박스에 주소를 직접 써야 돼요?'],
  ['2026-10-20T16:29', '임건우', '01029964410', '해외로도 보낼 수 있어요?'],
  ['2026-10-20T16:40', '노유나', '01084430168', '카드 말고 계좌이체로 해도 돼요?'],
  ['2026-10-20T16:52', '문재원', '01046619283', '어… 아까 접수한 거, 그거 시간 좀 바꿀 수 있나?'],
  ['2026-10-20T17:06', '장서아', '01057712946', '경비실에 맡겨 두면 가져가 주시나요?'],
  [`${today}T13:13`, '강도윤', '01066382047', '착불로 보내면 받는 사람이 얼마 내요?', 9101], // 06 기본 장면 01:34의 질문
  ['2026-10-20T17:33', '권도윤', '01069935512', '깨지기 쉬운 거라고 표시해 주실 수 있어요?'],
  ['2026-10-20T17:41', '신하준', '01033380075', '수거 기사님 전화번호 알 수 있을까요?'],
  ['2026-10-20T17:55', '홍예준', '01092258841', '그… 동생 이름으로 보내도 되나요?'],
  [`${today}T09:12`, '서지안', '01024417730', '오늘 접수하면 내일 도착해요?'],
  [`${today}T10:05`, '유하람', '01058823164', '음… 박스 없이 그냥 봉투로 보내도 돼요?'],
  [`${today}T10:47`, '(주)새봄식품', '01031167745', '아이스박스는 몇 개까지 한 번에 돼요?'],
  [`${today}T11:30`, '진우석', '01067702218', '받는 분이 집에 없으면 어떻게 돼요?'],
]

let store: UnansweredQuestion[] = SEED.map(([at, name, phone, question, call], i) => ({
  unansweredQuestionSeq: 7001 + i,
  callSessionSeq: call ?? 9300 + i,
  startedAt: `${at}:00+09:00`,
  customerName: name,
  callerNumber: phone,
  question,
}))

const wait = () => new Promise((r) => setTimeout(r, 200)) // 가짜 응답 지연 ('불러오는 중' 확인용)

/** 처리 안 된 미답변 질문 전부. 정렬 · 검색 · 쪽 나누기는 훅이 함
 * ponytail: 전부 받아 앞에서 나눔 — 콜드 스타트라 쌓이면 서버 q/offset + totalCount로 바꿀 것 */
export async function fetchUnanswered(): Promise<UnansweredQuestion[]> {
  await wait()
  return store.map((q) => ({ ...q }))
}

/** 삭제 — FAQ로 풀 필요 없는 질문(조회 · 요청 · 잡음 · 중복). 10/30 모든 관리자 */
export async function deleteUnanswered(id: number): Promise<void> {
  await wait()
  store = store.filter((q) => q.unansweredQuestionSeq !== id)
}

/** [FAQ 추가]로 처리됨 → 목록에서 빠짐. 지금은 삭제와 결과가 같지만, BE에선 '처리됨'으로 남겨 통계에 쓸 수 있게 따로 둠 */
export async function resolveUnanswered(id: number): Promise<void> {
  await wait()
  store = store.filter((q) => q.unansweredQuestionSeq !== id)
}
