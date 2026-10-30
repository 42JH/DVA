import { http, HttpResponse } from 'msw'
import { API_BASE_URL } from '@/shared/api/client'

// 가짜 01 홈 — 와이어프레임 01 예시 값. 경로 · 모양은 features/home/api/homeApi.ts의 가정과 같음 (명세 확인 전)
// 시각은 오늘 날짜로 만들어서 언제 켜도 '오늘'로 보이게. 하나는 어제 것(미처리 전체라 묵은 질문도 옴)
const at = (daysAgo: number, hhmm: string) => {
  const d = new Date()
  d.setDate(d.getDate() - daysAgo)
  const [h, m] = hhmm.split(':').map(Number)
  d.setHours(h, m, 0, 0)
  return d.toISOString()
}

// (며칠 전, 시각, 이름, 번호, 질문)
const SEED: [number, string, string, string, string][] = [
  [1, '17:05', '김도현', '01022418830', '반품도 전화로 접수돼요?'],
  [0, '11:52', '오시우', '01014582209', '문자를 다른 번호로 다시 보내 줄 수 있어요?'],
  [0, '12:48', '배서윤', '01030875512', '제주까지는 며칠 걸려요?'],
  [0, '13:40', '한소율', '01066041975', '착불로 보내면 받는 사람이 얼마 내요?'],
  [0, '13:41', '정하은', '01033496021', '박스를 따로 살 수 있나요?'],
  [0, '15:22', '오민재', '01066271180', '월요일에 수거 와요?'],
  [0, '16:40', '오민재', '01066271180', '대형 두 개 보내면 할인돼요?'],
  [0, '17:12', '이서준', '01077120934', '냉동식품도 보낼 수 있어요?'],
]

const unanswered = SEED.map(([daysAgo, hhmm, customerName, callerPhone, question], i) => ({
  callSeq: 9200 + i,
  startedAt: at(daysAgo, hhmm),
  customerName,
  callerPhone,
  question,
})).sort((a, b) => a.startedAt.localeCompare(b.startedAt)) // 오래된 순

export const homeHandlers = [
  http.get(`${API_BASE_URL}/stats/today`, () =>
    HttpResponse.json({
      data: {
        successCount: 12345,
        failedCount: 214,
        handoffCount: 87,
        complaintCount: 8,
        avgCallSeconds: 1.4,
        avgReaskCount: 1.3,
      },
    }),
  ),
  http.get(`${API_BASE_URL}/inquiries/unanswered`, ({ request }) => {
    const url = new URL(request.url)
    const limit = Number(url.searchParams.get('limit') ?? 20)
    const offset = Number(url.searchParams.get('offset') ?? 0)
    return HttpResponse.json({
      data: unanswered.slice(offset, offset + limit),
      hasNext: offset + limit < unanswered.length,
      totalCount: unanswered.length,
    })
  }),
]
