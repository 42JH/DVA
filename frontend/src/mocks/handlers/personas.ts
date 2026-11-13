import { http, HttpResponse } from 'msw'
import { API_BASE_URL } from '@/shared/api/client'

// 가짜 페르소나 목록 · 버전 이력 — API-60 · 64 (연동 상세명세 10/31 §8) 모양. 02 대시보드 '버전별 기록'이 씀
// 07 페르소나 관리(팀원)는 아직 자기 메모리 가짜를 쓰므로 여기와 따로 — 07이 MSW로 옮기면 그쪽 데이터로 합칠 것
// 빠른 접수형: v6 적용 중(10.02~) · v5(09.17~10.02) · v4(09.01~09.17) · v7 저장만(미적용). 통화 가짜는 전부 v6(calls.ts PERSONA_SEQ)
const PERSONA_SEQ = 1
const ver = (
  version: number,
  status: 'ACTIVE' | 'INACTIVE' | 'PENDING',
  appliedAt: string | null,
  createdAt: string,
) => ({
  aiPersonaSeq: PERSONA_SEQ,
  code: 'parcel',
  aiPersonaVersionSeq: version,
  version,
  name: '빠른 접수형',
  promptText: '빠르고 정확하게 택배 접수를 돕는 상담원입니다.',
  // 프롬프트 6칸 (백엔드 persona-response.dto — 늘 글자). 없으면 수정 화면이 깨졌음 (11/11 QA)
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

type Ver = ReturnType<typeof ver>
// 목록 · 상세가 같은 페르소나 (상세 GET /personas/:id — 화면이 고른 페르소나를 다시 받음, 11/06 가짜에 추가)
// 저장 · 통화에 사용하기도 받음 (11/13 — AI 상담가 흐름 확인용, 새로고침하면 처음으로)
const PERSONAS: {
  aiPersonaSeq: number
  code: string
  headVersion: Ver
  activeVersion: Ver | null
  pendingVersion: Ver | null
  draft: null
}[] = [
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
const personas = () => PERSONAS
const versionsOf = (seq: number): Ver[] | null =>
  seq === PERSONA_SEQ ? VERSIONS : seq === KIND_SEQ ? KIND_VERSIONS : null
const nowIso = () => new Date().toISOString()
const drafts = new Map<number, Record<string, unknown>>() // 고친 칸 (PATCH) → 확정(POST versions)하면 새 버전
const APPLY_MS = 4000 // 적용 대기 → AI 확인 끝 (반영 중 띠가 보이게)

export const personaHandlers = [
  // 초안 저장 — 고친 칸만 옴 (expected* 는 보지 않음)
  http.patch(`${API_BASE_URL}/personas/:id`, async ({ params, request }) => {
    const changed = (await request.json()) as Record<string, unknown>
    delete changed.expectedVersion
    delete changed.expectedDraftRevision
    drafts.set(Number(params.id), changed)
    return HttpResponse.json({ data: { draftRevision: `mock-${Date.now()}` } })
  }),
  // 확정 = 새 현재 버전 (통화엔 안 씀)
  http.post(`${API_BASE_URL}/personas/:id/versions`, ({ params }) => {
    const seq = Number(params.id)
    const p = PERSONAS.find((x) => x.aiPersonaSeq === seq)
    const list = versionsOf(seq)
    if (!p || !list) return HttpResponse.json({}, { status: 404 })
    const v: Ver = {
      ...p.headVersion,
      ...(drafts.get(seq) as Partial<Ver>),
      version: p.headVersion.version + 1,
      aiPersonaVersionSeq: Date.now(),
      status: 'INACTIVE',
      createdAt: nowIso(),
      appliedAt: null,
      requestedAt: null,
    }
    drafts.delete(seq)
    list.unshift(v)
    p.headVersion = v
    return HttpResponse.json({ data: v }, { status: 201 })
  }),
  // 통화에 사용하기 — 적용 대기(PENDING) → APPLY_MS 뒤 AI 확인 끝(ACTIVE, 다른 상담가는 내려감)
  http.post(`${API_BASE_URL}/personas/:id/activate`, ({ params }) => {
    const p = PERSONAS.find((x) => x.aiPersonaSeq === Number(params.id))
    if (!p) return HttpResponse.json({}, { status: 404 })
    const head = p.headVersion
    head.status = 'PENDING'
    head.requestedAt = nowIso()
    p.pendingVersion = head
    setTimeout(() => {
      for (const o of PERSONAS) {
        o.activeVersion = null
        for (const v of versionsOf(o.aiPersonaSeq) ?? [])
          if (v.status !== 'PENDING') v.status = 'INACTIVE'
      }
      head.status = 'ACTIVE'
      head.appliedAt = nowIso()
      p.activeVersion = head
      p.pendingVersion = null
    }, APPLY_MS)
    return HttpResponse.json({ data: null }, { status: 202 })
  }),
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
  http.get(`${API_BASE_URL}/personas/:id/versions`, ({ params }) => {
    const list = versionsOf(Number(params.id))
    return list
      ? HttpResponse.json(page(list))
      : HttpResponse.json(
          { error: { code: 'NOT_FOUND', message: '페르소나가 없습니다.', details: [] } },
          { status: 404 },
        )
  }),
]
