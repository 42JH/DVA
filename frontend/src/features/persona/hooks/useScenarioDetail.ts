import { useQuery } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import { useSearchParams } from 'react-router'
import { fmtClock, fmtDuration, fmtMonthDay, fmtVersionTime } from '@/shared/lib/format'
import { ymd } from '@/shared/lib/dateRange'
import { STATUS_LOOK } from '@/shared/order/look'
import type { PlayerView } from '@/shared/call/CallPlayer'
import { useRecordingPlayer } from '@/shared/call/useRecordingPlayer'
import { personaQueries } from '../api/personaApi'
import { scenarioTestQueries, type Check, type VersionTest } from '../api/scenarioTestApi'
import { cellOf, failLine, shownCheck, sideLabel, withActiveTests, type Cell } from './scenarioTest'
import { talksOf } from './useScenarioTest'

const EMPTY: Record<Cell, string> = {
  pass: '',
  fail: '',
  error: '통화가 연결되지 않아 기록이 없습니다.',
  running: '시험 중입니다.',
  queued: '시험을 기다리는 중입니다.',
  none: '시험 결과가 없습니다.',
}

/** 화면 가운데 한 줄 — 못 받음 · 받는 중 · 없는 시나리오 (그릴 것이 있으면 null) */
const loadNote = (failed: boolean, loading: boolean, missing: boolean) => {
  if (failed) return '불러오지 못했습니다. 다시 시도해 주세요.'
  if (loading) return '불러오는 중…'
  return missing ? '없는 시나리오입니다.' : null
}

/** 시나리오 한 개의 상세 — 탭 [고친 내용] · [통화에 쓰는 내용] (sideLabel). 어느 통화를 볼지만 정하고, 그 통화의 내용은 useScenarioCall */
export function useScenarioDetail(personaSeq: number, version: number, scenarioId: string) {
  const scenarios = useQuery(scenarioTestQueries.scenarios())
  const tests = useQuery(scenarioTestQueries.tests())
  const personas = useQuery(personaQueries.list())
  const versions = useQuery(personaQueries.versions(personaSeq))
  const [params, setParams] = useSearchParams()

  const inUse = personas.data?.find((p) => p.inUse)
  const mine = { personaSeq, version }
  const active = inUse ? { personaSeq: inUse.personaSeq, version: inUse.appliedVersion } : null
  // 통화에 쓰는 버전을 시험한 적이 없으면 내용이 같은 앞 버전의 결과 (시나리오 시험 표와 같은 기준 — withActiveTests)
  const activeVersions = useQuery({
    ...personaQueries.versions(inUse?.personaSeq ?? 0),
    enabled: !!inUse,
  })
  const all = withActiveTests(tests.data ?? [], talksOf(activeVersions.data), active)
  const date = (k: typeof mine) => {
    const v = k.personaSeq === personaSeq && versions.data?.find((x) => x.version === k.version)
    return v ? fmtMonthDay(ymd(new Date(v.savedAt))) : ''
  }
  const side = (label: string, k: typeof mine) => {
    const t: VersionTest | undefined = all.find(
      (x) => x.personaSeq === k.personaSeq && x.version === k.version,
    )
    const item = t?.items.find((i) => i.scenario === scenarioId)
    const cell = cellOf(item, t?.status === 'running')
    const has = !!item && (cell === 'pass' || cell === 'fail')
    return {
      label,
      date: date(k),
      cell,
      runId: has ? item.runId : null, // 끝난 통화가 있을 때만
      empty: EMPTY[cell],
      when:
        has && t
          ? `${fmtVersionTime(t.startedAt)} 시험, 통화 ${fmtDuration(Math.round(item.liveSeconds ?? 0))}`
          : '',
    }
  }
  // 보고 있는 버전이 통화에 사용 중인 버전이면 탭은 하나
  const same = active?.personaSeq === personaSeq && active.version === version
  const persona = personas.data?.find((p) => p.personaSeq === personaSeq)
  const isHead = !!versions.data?.find((x) => x.version === version)?.isHead
  const sides = [
    side(sideLabel({ ...mine, isHead }, active, persona?.name ?? ''), mine),
    ...(active && !same ? [side('통화에 쓰는 내용', active)] : []),
  ]
  // 처음엔 이 버전, 이 버전에 통화가 없으면 통화가 있는 쪽, 통화가 하나도 없으면 [시나리오]
  const first = sides.findIndex((s) => s.runId)
  // 고른 탭은 주소에 (?tab=mine · base · script) — 새로고침해도 그대로. 없거나 모르는 값이면 위 규칙
  const names = [...sides.map((_, i) => (i === 0 ? 'mine' : 'base')), 'script']
  const picked = names.indexOf(params.get('tab') ?? '')
  const at = picked >= 0 ? picked : first < 0 ? sides.length : first
  const pick = (i: number) => setParams({ tab: names[i] }, { replace: true })
  const scenario = scenarios.data?.find((s) => s.id === scenarioId)
  const failed = scenarios.isError || tests.isError || personas.isError

  return {
    title: scenario?.name ?? '시나리오 시험',
    sub: persona ? `${persona.name} 시나리오 시험` : '',
    note: loadNote(failed, !scenarios.data || !tests.data || !personas.data, !scenario),
    tabs: sides.map((s, i) => ({ ...s, on: i === at, pick: () => pick(i) })),
    // 맨 끝 탭 [시나리오] — 이 시나리오가 무엇을 시험하는지 (고객 대본 · 정답 · 행동 확인)
    script: { pick: () => pick(sides.length) },
    current: sides[at] ?? null, // null = [시나리오] 탭
  }
}

/** 시나리오 내용 — 보기만 */
export function useScenarioScript(scenarioId: string) {
  const q = useQuery(scenarioTestQueries.script(scenarioId))
  return {
    note: q.isError ? '불러오지 못했습니다. 다시 시도해 주세요.' : !q.data ? '불러오는 중…' : null,
    caller: q.data?.caller ?? '',
    lines: (q.data?.lines ?? []).map((l, i) => ({ ...l, no: i + 1 })),
    // 정답 값은 판정 결과표와 같은 모양(숫자 · 주문 상태 묶음)으로 와서 같은 방식으로 글로 바꿈
    expected: (q.data?.expected ?? []).map((e) => ({ name: e.name, value: text(e.value) })),
    checks: q.data?.checks ?? [],
  }
}

// 값 → 글. 주문 상태 묶음({ 이지은: 'CANCELLED' })은 '이지은 주문 취소, …'
const LOOK = STATUS_LOOK as Record<string, { label: string } | undefined>
const text = (v: unknown): string =>
  v === null || v === undefined
    ? '없음'
    : typeof v === 'object'
      ? Object.entries(v)
          .map(([k, x]) => `${k} ${LOOK[String(x)]?.label ?? String(x)}`)
          .join(', ')
      : String(v)

const checkRow = (c: Check, key: number, script: string[]) => {
  const s = shownCheck(c, script)
  return {
    key,
    name: s.name,
    // 행동 확인(정답이 '지킴')은 이름이 문장이라 한 줄을 다 쓰고, 어겼으면 AI가 한 말(actual)을 아래에
    behaviour: c.expected === '지킴',
    expected: text(s.expected),
    actual: text(s.actual),
    status: c.status,
    note: c.note ?? '',
  }
}

/** 통화 한 건 — 대화(누르면 그 말부터 듣기) · 결과표 · 녹음 재생
 *  실패한 판정이 난 말은 통화 상세의 불만처럼: 대화에 빨갛게 + 항목 이름, 재생 막대 눈금, 결과표의 시각(누르면 그 말로). 열면 첫 실패로 스크롤 */
export function useScenarioCall(runId: string, scenarioId: string) {
  const verdict = useQuery(scenarioTestQueries.verdict(runId, scenarioId))
  const record = useQuery(scenarioTestQueries.record(runId, scenarioId))
  const script = useQuery(scenarioTestQueries.script(scenarioId)) // 대본이 어디서 멈췄는지 찾을 때
  const [cursor, setCursor] = useState<number | null>(null) // 누른 말의 시각 (녹음이 안 돌 때 표시용)
  const [jumped, setJumped] = useState<{ key: number; n: number } | null>(null) // 눈금 · 시각을 눌러 간 줄
  const rec = record.data
  const player = useRecordingPlayer(
    rec ? { recordingSeq: 1, url: rec.audioUrl, expiresAt: null, error: null } : null,
    () => {},
  )
  const lines = rec?.customer.lines ?? []
  const now = player.now > 0 ? player.now : cursor
  const here = now === null ? -1 : lines.findLastIndex(([sec]) => sec <= now)
  const go = (i: number) => {
    const l = lines[i]
    if (!l) return
    setCursor(l[0])
    player.seek(l[0])
  }
  const checks = verdict.data?.checks ?? []
  const count = (s: Check['status']) => checks.filter((c) => c.status === s).length
  // 실패한 판정마다 그 일이 난 줄 (모르면 null) → 줄마다 실패한 항목 이름
  const scriptLines = (script.data?.lines ?? []).map((l) => l.text)
  const spots = checks.map((c) => failLine(c, lines, scriptLines))
  const flags = new Map<number, string>()
  spots.forEach((at, i) => {
    // 대화 줄 · 재생 막대 표시는 실패만 (확인 필요는 결과표의 시각으로만 감)
    if (at !== null && checks[i].status === 'fail')
      flags.set(
        at,
        [flags.get(at), shownCheck(checks[i], scriptLines).flag].filter(Boolean).join(', '),
      )
  })
  const first = flags.size ? Math.min(...flags.keys()) : null
  const opened = useMemo(() => (first === null ? null : { key: first, n: 0 }), [first])
  const goSpot = (i: number) => {
    setJumped((j) => ({ key: i, n: (j?.n ?? 0) + 1 }))
    go(i)
  }
  const clock = (i: number) => fmtClock(Math.floor(lines[i][0]))
  const length = player.length || rec?.liveSeconds || 0

  return {
    note:
      verdict.isError || record.isError
        ? '불러오지 못했습니다. 다시 시도해 주세요.'
        : !verdict.data || !rec
          ? '불러오는 중…'
          : null,
    lines: lines.map(([sec, who, said], i) => ({
      key: i,
      ai: who === 'AI',
      text: said,
      time: fmtClock(Math.floor(sec)),
      on: i === here,
      flag: flags.get(i), // 이 말에서 실패한 항목
      listen: () => go(i),
    })),
    focusKey: here >= 0 ? here : null,
    jump: jumped ?? opened,
    // 0인 것은 빼고 (시안 '통과 4, 실패 1')
    counts: (
      [
        ['통과', count('pass')],
        ['실패', count('fail')],
        ['확인 필요', count('warn')],
        ['채점 안 함', count('skip')],
      ] as const
    )
      .filter(([, n]) => n > 0)
      .map(([k, n]) => `${k} ${n}`)
      .join(', '),
    checks: checks.map((c, i) => {
      const at = spots[i]
      return {
        ...checkRow(c, i, scriptLines),
        spot: at === null ? null : { time: clock(at), go: () => goSpot(at) },
      }
    }),
    player: {
      state: player.state,
      playing: player.playing,
      now: fmtClock(Math.floor(player.now)),
      length: fmtClock(Math.floor(length)),
      progress: player.progress,
      toggle: player.toggle,
      scrub: player.scrub,
      prev: () => go(Math.max(here - 1, 0)),
      next: () => go(here + 1),
      volume: player.volume,
      muted: player.muted,
      setVolume: player.setVolume,
      toggleMute: player.toggleMute,
      src: player.src,
      handlers: player.handlers,
      text: !rec ? '' : player.state === 'ok' ? null : '녹음을 들을 수 없습니다',
      marks: length
        ? [...flags].map(([i, name]) => ({
            key: i,
            at: Math.min(1, lines[i][0] / length),
            tone: 'stop' as const,
            title: `${name} ${clock(i)}`,
            onClick: () => goSpot(i),
          }))
        : [],
    } satisfies PlayerView,
    audioRef: player.audioRef,
  }
}
