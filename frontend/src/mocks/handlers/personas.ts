import { http, HttpResponse } from 'msw'
import { API_BASE_URL } from '@/shared/api/client'

// 가짜 페르소나 목록 · 버전 이력 — API-60 · 64 (연동 상세명세 10/31 §8) 모양. 02 대시보드 '버전별 기록'이 씀
// 07 페르소나 관리(팀원)는 아직 자기 메모리 가짜를 쓰므로 여기와 따로 — 07이 MSW로 옮기면 그쪽 데이터로 합칠 것
// 빠른 접수형: v6 적용 중(10.02~) · v5(09.17~10.02) · v4(09.01~09.17) · v7 저장만(미적용). 통화 가짜는 전부 v6(calls.ts PERSONA_SEQ)
const PERSONA_SEQ = 1
const ver = (
  version: number,
  status: 'ACTIVE' | 'INACTIVE',
  appliedAt: string | null,
  createdAt: string,
) => ({
  aiPersonaSeq: PERSONA_SEQ,
  code: 'parcel',
  aiPersonaVersionSeq: version,
  version,
  name: '빠른 접수형',
  promptText: '빠르고 정확하게 택배 접수를 돕는 상담원입니다.',
  // 프롬프트 6칸 (백엔드 persona-response.dto — 늘 글자). 없으면 수정 · 음성 세부 조절 화면이 깨졌음 (11/11 QA)
  role: '택배 접수를 돕는 AI 상담원',
  personality: '친절하고 차분함',
  tone: '존댓말, 짧고 분명하게',
  speedInstruction: '보통 속도로 또박또박',
  backchannel: '네, 알겠습니다',
  interruption: '고객이 말하면 바로 멈추고 듣기',
  voiceId: null,
  speakingRate: null,
  turnWaitLevel: 'NORMAL',
  status,
  createdByAdminUserSeq: 1,
  createdAt,
  applicationId: null,
  requestedByAdminUserSeq: null,
  requestedAt: appliedAt,
  appliedAt,
  lastNotifiedAt: appliedAt,
  applyErrorCode: null,
})
const VERSIONS = [
  ver(7, 'INACTIVE', null, '2026-10-29T10:00:00+09:00'),
  ver(6, 'ACTIVE', '2026-10-02T09:00:00+09:00', '2026-10-01T18:00:00+09:00'),
  ver(5, 'INACTIVE', '2026-09-17T09:00:00+09:00', '2026-09-16T18:00:00+09:00'),
  ver(4, 'INACTIVE', '2026-09-01T09:00:00+09:00', '2026-08-31T18:00:00+09:00'),
]
// 친절형: 9월까지 쓰던 상담가 (지금 안 씀) — 04 상담가 토글에서 고르면 가짜 통화(전부 빠른 접수형 v6)가 다 빠짐
const KIND_SEQ = 2
const KIND_VERSIONS = [
  {
    ...ver(2, 'INACTIVE', '2026-08-20T09:00:00+09:00', '2026-08-19T18:00:00+09:00'),
    aiPersonaVersionSeq: 22,
  },
  {
    ...ver(1, 'INACTIVE', '2026-08-01T09:00:00+09:00', '2026-07-31T18:00:00+09:00'),
    aiPersonaVersionSeq: 21,
  },
].map((v) => ({ ...v, aiPersonaSeq: KIND_SEQ, code: 'kind', name: '친절형' }))
const page = <T>(items: T[]) => ({ data: items, hasNext: false, total_count: items.length })

// 목록 · 상세가 같은 페르소나 (상세 GET /personas/:id — 화면이 고른 페르소나를 다시 받음, 11/06 가짜에 추가)
const personas = () => [
  // 지금 API 모양 (PersonaDto — headVersion · activeVersion · pendingVersion · draft 객체, 11/04 맞춤)
  {
    aiPersonaSeq: PERSONA_SEQ,
    code: 'parcel',
    headVersion: VERSIONS[0], // v7 확정만(미적용)
    activeVersion: VERSIONS[1], // v6 적용 중 → 상단바 '빠른 접수형 AI 상담가'
    pendingVersion: null,
    draft: null,
  },
  {
    aiPersonaSeq: KIND_SEQ,
    code: 'kind',
    headVersion: KIND_VERSIONS[0],
    activeVersion: null,
    pendingVersion: null,
    draft: null,
  },
]

export const personaHandlers = [
  // AI가 지원하는 음성 설정 (GET /api/ai/options) — 없으면 목업에서 진짜 서버로 넘어가 401 → 로그아웃 (11/11 QA)
  http.get(`${API_BASE_URL}/ai/options`, () =>
    HttpResponse.json({
      data: {
        voices: [
          { id: 'ko-KR-female-1', label: '여성 1' },
          { id: 'ko-KR-male-1', label: '남성 1' },
        ],
        speakingRate: { min: 0.8, max: 1.2 },
        turnWaitLevels: ['SHORT', 'NORMAL', 'LONG'],
      },
    }),
  ),
  http.get(`${API_BASE_URL}/personas`, () => HttpResponse.json(page(personas()))),
  http.get(`${API_BASE_URL}/personas/:id`, ({ params }) => {
    const p = personas().find((x) => x.aiPersonaSeq === Number(params.id))
    return p
      ? HttpResponse.json({ data: p })
      : HttpResponse.json(
          { error: { code: 'NOT_FOUND', message: '페르소나가 없습니다.', details: [] } },
          { status: 404 },
        )
  }),
  http.get(`${API_BASE_URL}/personas/:id/versions`, ({ params }) =>
    Number(params.id) === PERSONA_SEQ
      ? HttpResponse.json(page(VERSIONS))
      : Number(params.id) === KIND_SEQ
        ? HttpResponse.json(page(KIND_VERSIONS))
        : HttpResponse.json(
            { error: { code: 'NOT_FOUND', message: '페르소나가 없습니다.', details: [] } },
            { status: 404 },
          ),
  ),
]
