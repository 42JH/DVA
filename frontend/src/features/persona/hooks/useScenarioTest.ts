import { useMutation, usePrefetchQuery, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { fmtMonthDay, fmtVersionTime } from '@/shared/lib/format'
import { ymd } from '@/shared/lib/dateRange'
import { personaQueries, type PersonaVersion } from '@/features/persona/api/personaApi'
import {
  SCENARIO_TEST,
  scenarioTestQueries,
  startTest,
  stopTest,
} from '@/features/persona/api/scenarioTestApi'
import { restOf, rowsOf, sideLabel, testOf, withActiveTests } from './scenarioTest'

export { SCENARIO_TEST } // 화면(components)은 api를 직접 부르지 않아 여기서 내보냄

type Me = { personaSeq: number; version: number; isHead: boolean }
/** 시험할 버전 — 시작할 때 그 버전의 합친 글과 음성을 창구에 보냄 (voiceId null = AI 기본 음성) */
export type TestTarget = Me & { promptText: string; voiceId: string | null }

/** 버전마다 AI가 받는 것(프롬프트 · 목소리)을 한 글로 — 내용이 같은 버전 찾기(withActiveTests)에 씀 */
export const talksOf = (versions: PersonaVersion[] | undefined) =>
  (versions ?? [])
    .filter((v) => !v.isDraft)
    .map((v) => ({ version: v.version, talk: JSON.stringify([v.prompt, v.voice]) }))

/** 시나리오 · 버전별 결과 · 통화에 사용 중인 버전 — 시나리오 시험 화면의 표 (띠 · 상세와 캐시 공유) */
function useTestData() {
  const scenarios = useQuery({ ...scenarioTestQueries.scenarios(), enabled: SCENARIO_TEST })
  const tests = useQuery({ ...scenarioTestQueries.tests(), enabled: SCENARIO_TEST })
  const inUse = useQuery(personaQueries.list()).data?.find((p) => p.inUse)
  const active = inUse ? { personaSeq: inUse.personaSeq, version: inUse.appliedVersion } : null
  // 통화에 쓰는 상담가의 버전들 — 통화에 쓰는 버전을 시험한 적이 없을 때 내용이 같은 앞 버전의 결과를 찾음
  const activeVersions = useQuery({
    ...personaQueries.versions(inUse?.personaSeq ?? 0),
    enabled: SCENARIO_TEST && !!inUse,
  })
  const all = withActiveTests(tests.data ?? [], talksOf(activeVersions.data), active)
  const base =
    all.find((t) => t.personaSeq === active?.personaSeq && t.version === active.version) ?? null
  return {
    ready: !!scenarios.data && !!tests.data,
    failed: scenarios.isError || tests.isError,
    active,
    read: (me: Me) => {
      const { state, shown } = testOf(all, scenarios.data ?? [], me, active)
      return { state, shown, rows: rowsOf(scenarios.data ?? [], base, shown) }
    },
  }
}

/** 시나리오 시험 화면의 위 줄 — 주소의 상담가 · 버전이 무엇인가 (이름 · 저장 시각 · 현재 버전인가) */
export function useScenarioTestPage(personaSeq: number, version: number) {
  // 표가 쓰는 시험 자료를 상담가 자료와 같이 받기 시작 — 표(useScenarioTest)는 버전을 안 뒤에 떠서 그때 부르면 한 박자 늦음
  usePrefetchQuery(scenarioTestQueries.scenarios())
  usePrefetchQuery(scenarioTestQueries.tests())
  const personas = useQuery(personaQueries.list())
  const versions = useQuery(personaQueries.versions(personaSeq))
  const persona = personas.data?.find((p) => p.personaSeq === personaSeq)
  const all = versions.data ?? []
  const v = all.find((x) => x.version === version && !x.isDraft)
  const inUse = personas.data?.find((p) => p.inUse)
  const active = inUse ? { personaSeq: inUse.personaSeq, version: inUse.appliedVersion } : null
  // '고친 내용' · '통화에 쓰는 내용' … — 다른 상담가면 이름이 곧 그 말이라 한 번만
  const label =
    persona && v ? sideLabel({ personaSeq, version, isHead: v.isHead }, active, persona.name) : ''
  return {
    sub:
      persona && v
        ? [persona.name, label !== persona.name && label, fmtVersionTime(v.savedAt)]
            .filter(Boolean)
            .join(' ')
        : '',
    label, // 표의 이 버전 칸 머리
    // ‹ — 바로 전이 AI 상담가면 뒤로가기(보던 그대로), 아니면(새로고침 · 주소로 옴) 이 상담가 · 지난 버전이면 그 버전을 넘겨 줌
    back: {
      to: '/personas',
      label: 'AI 상담가로',
      state: { testOf: personaSeq, ...(v && !v.isHead && { version }) },
    },
    me: v
      ? ({
          personaSeq,
          version,
          isHead: v.isHead,
          promptText: v.promptText,
          voiceId: v.voice.voice || null,
        } satisfies TestTarget)
      : null,
    dateOf: (n: number) => {
      const x = all.find((y) => y.version === n)
      return x ? fmtMonthDay(ymd(new Date(x.savedAt))) : ''
    },
    note:
      personas.isError || versions.isError
        ? '불러오지 못했습니다. 다시 시도해 주세요.'
        : personas.isPending || versions.isPending
          ? '불러오는 중…'
          : '시험할 내용을 찾을 수 없습니다.',
  }
}

/** 시나리오 시험 화면의 결과 표 — 주소에서 고른 버전. dateOf = 이 상담가의 버전 번호 → '10월 29일' */
export function useScenarioTest(me: TestTarget, dateOf: (version: number) => string) {
  const d = useTestData()
  const qc = useQueryClient()
  // 시험은 실제 통화라 요금이 듦 → 누르면 한 번 묻고 시작 (11/12 사용자: 실수로 눌러도 바로 걸리면 안 됨)
  const [asking, setAsking] = useState<{ title: string; scenarios?: string[] } | null>(null)
  const testsKey = scenarioTestQueries.tests().queryKey
  const start = useMutation({
    mutationFn: startTest,
    onSuccess: () => {
      setAsking(null)
      return qc.invalidateQueries({ queryKey: testsKey })
    },
    // 응답을 못 받아도(시간 초과 등) 창구는 이미 통화를 걸기 시작했을 수 있음 → 다시 보내지 않고 묶음 목록으로 확인.
    // 이 버전이 시험 중이면 시작된 것이므로 창을 닫음 (다시 누르면 통화가 두 번 걸려 요금이 두 번 나감)
    onError: async () => {
      await qc.invalidateQueries({ queryKey: testsKey })
      const running = qc
        .getQueryData(testsKey)
        ?.some(
          (t) =>
            t.personaSeq === me.personaSeq && t.version === me.version && t.status === 'running',
        )
      if (running) setAsking(null)
    },
  })
  // 멈춤 — 실패해도 목록을 다시 받음(일부 묶음만 멈췄을 수 있음)
  const stop = useMutation({
    mutationFn: stopTest,
    onSettled: () => qc.invalidateQueries({ queryKey: testsKey }),
  })
  const r = d.read(me)
  const items = r.shown?.items ?? []
  const ended = items.filter((i) => i.status === 'done' || i.status === 'error').length
  const rest = restOf(r.state, r.rows)
  const tested = r.state === 'done' || r.state === 'partial' || r.state === 'stale'
  const count = (c: string) => r.rows.filter((x) => x.now === c).length
  const ask = (what: NonNullable<typeof asking>) => {
    start.reset() // 지난번 실패 문구가 새 창에 먼저 뜨지 않게
    setAsking(what)
  }
  const shownVersion = r.shown?.version ?? me.version

  return {
    note: d.failed ? '불러오지 못했습니다. 다시 시도해 주세요.' : d.ready ? null : '불러오는 중…',
    state: r.state,
    progress:
      r.state === 'running' && r.shown
        ? // 11/13 새 안 2번(피그마 2368:3929): 진행 4 / 10 · 막대 · 통과 n · 실패 n (연결 실패는 어느 쪽에도 안 셈)
          { value: ended, max: items.length, pass: count('pass'), fail: count('fail') }
        : null,
    // 11/13 새 안: 통과 + 실패 + 연결 실패 = 전체 (새로 실패 · 새로 통과는 표의 변화 칸에서). 멈춘 묶음처럼 못 한 것이 있으면 '시험 안 함'까지 더해 전체를 맞춤
    summary: tested
      ? [
          { label: '전체', value: r.rows.length, tone: '' },
          { label: '통과', value: count('pass'), tone: 'text-ops-done' },
          { label: '실패', value: count('fail'), tone: 'text-ops-stop' },
          { label: '연결 실패', value: count('error'), tone: '' },
          ...(count('none') ? [{ label: '시험 안 함', value: count('none'), tone: '' }] : []),
        ]
      : null,
    // 표 머리 날짜 — 통화에 사용 중인 버전이 다른 상담가 것이면 날짜를 모름
    baseDate: d.active?.personaSeq === me.personaSeq ? dateOf(d.active.version) : '',
    nowDate: dateOf(shownVersion),
    // 상세의 ‹ 가 돌아올 곳 — 고치기 전 결과를 보여 줄 땐 줄의 주소(그 결과의 버전)와 이 화면의 버전이 다름
    from: { from: `/personas/${me.personaSeq}/tests/${me.version}` },
    rows: r.rows.map((x, i) => ({
      ...x,
      firstOfGroup: r.rows[i - 1]?.group !== x.group,
      // 누르면 상세 — 통화가 없어도 시나리오 내용(대본 · 정답)은 볼 수 있음
      to: `/personas/${me.personaSeq}/tests/${shownVersion}/${x.id}`,
    })),
    // 버튼 — 도는 동안은 숨김
    canRun: r.state !== 'running',
    allLabel: `전체 ${r.rows.length}개 시험`,
    retryLabel: rest.length ? `남은 ${rest.length}개 시험` : null,
    runAll: () => ask({ title: `시나리오 ${r.rows.length}개를 시험할까요?` }),
    retry: () => ask({ title: `남은 ${rest.length}개를 시험할까요?`, scenarios: rest }),
    // 시험 멈춤 — 도는 동안만 있음 ([시험 중단] 버튼 · 확인 창)
    stop:
      r.state === 'running'
        ? {
            run: () => stop.mutate({ personaSeq: me.personaSeq, version: me.version }),
            reset: stop.reset,
            busy: stop.isPending,
            error: stop.isError ? '멈추지 못했습니다. 다시 시도해 주세요.' : null,
          }
        : null,
    // 확인 창 — [시험 시작]을 눌러야 통화가 걸림
    confirm: asking && {
      title: asking.title,
      busy: start.isPending,
      error: start.isError
        ? '시작을 확인하지 못했습니다. 표에 시험 중이 없을 때만 다시 시작해 주세요.'
        : null,
      ok: () =>
        start.mutate({
          personaSeq: me.personaSeq,
          version: me.version,
          promptText: me.promptText,
          voiceId: me.voiceId,
          scenarios: asking.scenarios,
        }),
      close: () => setAsking(null),
    },
  }
}
