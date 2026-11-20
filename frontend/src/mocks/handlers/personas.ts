import { http, HttpResponse } from 'msw'
import { API_BASE_URL } from '@/shared/api/client'

// 가짜 페르소나 목록 · 버전 이력 — API-60 · 64 (연동 상세명세 10/31 §8) 모양. 07 AI 상담가 · 02 대시보드 '버전별 기록'이 씀
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
  // 프롬프트 6칸 (백엔드 persona-response.dto — 늘 글자). 없으면 수정 화면이 깨졌음 (QA)
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
  createdByAdminUserName: '김관리', // 수정 기록 · 반영 전 띠의 저장한 사람
  createdAt,
  applicationId: null,
  requestedByAdminUserSeq: null,
  requestedAt: appliedAt,
  appliedAt,
  lastNotifiedAt: appliedAt,
  applyErrorCode: null,
})
type Ver = ReturnType<typeof ver>

// 친절형: 9월까지 쓰던 상담가 (지금 안 씀) — 04 상담가 토글에서 고르면 가짜 통화(전부 빠른 접수형 v6)가 다 빠짐
const KIND_SEQ = 2
const kind = (v: Ver, seq: number): Ver => ({
  ...v,
  aiPersonaSeq: KIND_SEQ,
  aiPersonaVersionSeq: seq,
  code: 'kind',
  name: '친절형',
})

/** 상담가 한 명 — 현재 · 통화에 쓰는 · 적용 대기 버전은 번호로 (버전 내용은 versions에) */
interface Row {
  aiPersonaSeq: number
  code: string
  head: number
  active: number | null
  pending: number | null
}
interface State {
  personas: Row[]
  versions: Record<number, Ver[]> // 상담가 번호 → 버전들 (높은 번호가 위)
}
const initial = (): State => ({
  personas: [
    { aiPersonaSeq: PERSONA_SEQ, code: 'parcel', head: 7, active: 6, pending: null }, // v7 저장만(반영 전), v6 통화 중 → 상단바 '빠른 접수형 AI 상담가'
    { aiPersonaSeq: KIND_SEQ, code: 'kind', head: 2, active: null, pending: null },
  ],
  versions: {
    [PERSONA_SEQ]: [
      // 고친 내용(반영 전)은 통화에 쓰는 v6과 글이 다름 — 같으면 토글 · 수정 기록 비교에 볼 것이 없고 '시험 없이 반영'으로 넘어감
      {
        ...ver(7, 'INACTIVE', null, '2026-10-29T10:00:00+09:00'),
        role: '택배 접수와 수거 일정 확인을 돕는 AI 상담원',
      },
      ver(6, 'ACTIVE', '2026-10-02T09:00:00+09:00', '2026-10-01T18:00:00+09:00'),
      ver(5, 'INACTIVE', '2026-09-17T09:00:00+09:00', '2026-09-16T18:00:00+09:00'),
      ver(4, 'INACTIVE', '2026-09-01T09:00:00+09:00', '2026-08-31T18:00:00+09:00'),
    ],
    [KIND_SEQ]: [
      // v2 = v1을 시험한 뒤 성격을 고친 버전 → v2를 보면 '고치기 전 글의 결과'(v1)
      {
        ...kind(ver(2, 'INACTIVE', '2026-08-20T09:00:00+09:00', '2026-08-19T18:00:00+09:00'), 22),
        personality: '친절하고 공감을 잘함',
      },
      kind(ver(1, 'INACTIVE', '2026-08-01T09:00:00+09:00', '2026-07-31T18:00:00+09:00'), 21),
    ],
  },
})

// 저장 · 반영 · 등록 · 삭제한 상태는 세션 저장소에 — 새로고침해도 남고, 탭을 닫으면 처음으로 (시험 결과 scenarioTests.ts와 같게).
// 상담가만 처음으로 돌아가면 번호가 같은 다른 내용에 전 시험 결과가 붙음
const STORE = 'mock:personas'
const load = (): State | null => {
  try {
    return JSON.parse(sessionStorage.getItem(STORE) ?? 'null') as State | null
  } catch {
    return null
  }
}
const state = load() ?? initial()
const save = () => {
  try {
    sessionStorage.setItem(STORE, JSON.stringify(state))
  } catch {
    // 못 쓰면 새로고침 때 처음 상태로 돌아갈 뿐
  }
}
const nowIso = () => new Date().toISOString()
const row = (seq: number) => state.personas.find((p) => p.aiPersonaSeq === seq)
const versionOf = (p: Row, n: number | null) =>
  n === null ? null : (state.versions[p.aiPersonaSeq].find((v) => v.version === n) ?? null)
// 지금 API 모양 (PersonaDto — headVersion · activeVersion · pendingVersion · draft 객체, 11/04 맞춤)
const dto = (p: Row) => ({
  aiPersonaSeq: p.aiPersonaSeq,
  code: p.code,
  headVersion: versionOf(p, p.head)!,
  activeVersion: versionOf(p, p.active),
  pendingVersion: versionOf(p, p.pending),
  draft: null,
})
/** AI 확인 끝 — 적용 대기 버전이 통화에 쓰는 버전이 되고 다른 상담가는 내려감 */
const finish = (p: Row) => {
  const next = versionOf(p, p.pending)
  if (!next) return
  for (const o of state.personas) {
    o.active = null
    for (const v of state.versions[o.aiPersonaSeq])
      if (v.status !== 'PENDING') v.status = 'INACTIVE'
  }
  next.status = 'ACTIVE'
  next.appliedAt = nowIso()
  p.active = next.version
  p.pending = null
  save()
}
// 새로고침으로 기다리던 타이머가 사라진 적용 대기는 끝난 것으로
for (const p of state.personas) finish(p)

const page = <T>(items: T[]) => ({ data: items, hasNext: false, total_count: items.length })
const drafts = new Map<number, Record<string, unknown>>() // 고친 칸 (PATCH) → 확정(POST versions)하면 새 버전
const APPLY_MS = 4000 // 적용 대기 → AI 확인 끝 (반영 중 띠가 보이게)
const missing = () =>
  HttpResponse.json(
    { error: { code: 'NOT_FOUND', message: '페르소나가 없습니다.', details: [] } },
    { status: 404 },
  )

export const personaHandlers = [
  // 등록 — v1 저장만(통화엔 안 씀). 없으면 목업에서 진짜 서버로 넘어가 401 → 로그아웃 (7번 확인)
  http.post(`${API_BASE_URL}/personas`, async ({ request }) => {
    const body = (await request.json()) as Partial<Ver>
    const seq = Math.max(0, ...state.personas.map((x) => x.aiPersonaSeq)) + 1
    const v: Ver = {
      ...ver(1, 'INACTIVE', null, nowIso()),
      ...body,
      aiPersonaSeq: seq,
      aiPersonaVersionSeq: Date.now(),
    }
    state.versions[seq] = [v]
    state.personas.push({ aiPersonaSeq: seq, code: v.code, head: 1, active: null, pending: null })
    save()
    return HttpResponse.json({ data: { aiPersonaSeq: seq } }, { status: 201 })
  }),
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
    const p = row(Number(params.id))
    if (!p) return HttpResponse.json({}, { status: 404 })
    const v: Ver = {
      ...versionOf(p, p.head)!,
      ...(drafts.get(p.aiPersonaSeq) as Partial<Ver>),
      version: p.head + 1,
      aiPersonaVersionSeq: Date.now(),
      status: 'INACTIVE',
      createdAt: nowIso(),
      appliedAt: null,
      requestedAt: null,
    }
    drafts.delete(p.aiPersonaSeq)
    state.versions[p.aiPersonaSeq].unshift(v)
    p.head = v.version
    save()
    return HttpResponse.json({ data: v }, { status: 201 })
  }),
  // 통화에 사용하기 — 적용 대기(PENDING) → APPLY_MS 뒤 AI 확인 끝(ACTIVE, 다른 상담가는 내려감)
  http.post(`${API_BASE_URL}/personas/:id/activate`, ({ params }) => {
    const p = row(Number(params.id))
    if (!p) return HttpResponse.json({}, { status: 404 })
    const head = versionOf(p, p.head)!
    head.status = 'PENDING'
    head.requestedAt = nowIso()
    p.pending = p.head
    save()
    setTimeout(() => finish(p), APPLY_MS)
    return HttpResponse.json({ data: null }, { status: 202 })
  }),
  // 삭제 — 목록에서 뺌. 서버처럼 통화에 사용 중 · 적용 대기면 409, 없으면 404 (없으면 목업에서 진짜 서버로 넘어가 401 → 로그아웃)
  http.delete(`${API_BASE_URL}/personas`, async ({ request }) => {
    const { aiPersonaSeqs } = (await request.json()) as { aiPersonaSeqs: number[] }
    const found = aiPersonaSeqs.map(row)
    if (found.some((p) => !p)) return HttpResponse.json({}, { status: 404 })
    if (found.some((p) => p!.active !== null || p!.pending !== null))
      return HttpResponse.json({}, { status: 409 })
    state.personas = state.personas.filter((p) => !aiPersonaSeqs.includes(p.aiPersonaSeq))
    for (const seq of aiPersonaSeqs) delete state.versions[seq]
    save()
    return new HttpResponse(null, { status: 204 })
  }),
  // AI가 지원하는 음성 설정 (GET /api/ai/options) — 없으면 목업에서 진짜 서버로 넘어가 401 → 로그아웃 (QA)
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
  http.get(`${API_BASE_URL}/personas`, () => HttpResponse.json(page(state.personas.map(dto)))),
  // 상세 — 화면이 고른 페르소나를 다시 받음 (가짜에 추가)
  http.get(`${API_BASE_URL}/personas/:id`, ({ params }) => {
    const p = row(Number(params.id))
    return p ? HttpResponse.json({ data: dto(p) }) : missing()
  }),
  http.get(`${API_BASE_URL}/personas/:id/versions`, ({ params }) => {
    const list = state.versions[Number(params.id)]
    return list ? HttpResponse.json(page(list)) : missing()
  }),
]
