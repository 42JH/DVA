import { useEffect, useState } from 'react'
import { useLocation } from 'react-router'
import { SCENARIO_TEST } from '../api/scenarioTestApi'

// 시나리오 시험에 다녀오거나 새로고침해도 보던 상담가 · 버전 그대로 — 기록(location.key)마다 세션 저장소에 기억
// (메모리에만 두면 새로고침 때 처음 화면으로 돌아감, 11/12 사용자). 사이드바로 새로 들어오면 새 기록이라 처음 화면
type Kept = {
  personaSeq: number | null
  historyOpen: boolean
  version: number | null
  showCall?: boolean // 반영 전 띠의 토글 (통화에 쓰는 내용을 보던 중)
}
const KEEP = 'personas:view:'
const kept = (key: string): Kept | null => {
  try {
    return JSON.parse(sessionStorage.getItem(KEEP + key) ?? 'null') as Kept | null
  } catch {
    return null // 저장소를 못 쓰는 환경 · 깨진 값이면 처음 화면
  }
}
const keep = (key: string, v: Kept) => {
  try {
    sessionStorage.setItem(KEEP + key, JSON.stringify(v))
  } catch {
    // 못 쓰면 기억하지 않을 뿐
  }
}
/** 시나리오 시험의 ‹ 가 넘겨 준 상담가 · 버전 (새로고침 뒤라 뒤로가기가 아닌 링크로 왔을 때) → 시험하던 버전을 가운데에
 *  version = 지난 버전일 때만 (현재 버전이면 없음 → 상담가 유형 화면 그대로) */
const fromTest = (state: unknown): Kept | null => {
  const s = state as { testOf?: number; version?: number } | null
  if (typeof s?.testOf !== 'number') return null
  const version = typeof s.version === 'number' ? s.version : null
  return { personaSeq: s.testOf, historyOpen: version !== null, version }
}
/** 보던 상담가 · 수정 기록 창 · 띠의 토글 — 돌아오면 그대로 (위 Kept) */
export function useKeptView() {
  const { key, state } = useLocation()
  const [back] = useState(() => (SCENARIO_TEST ? (kept(key) ?? fromTest(state)) : null))
  const [personaSeq, setPersonaSeq] = useState<number | null>(back?.personaSeq ?? null) // null = 통화에 사용 중인 상담가
  const [historyOpen, setHistoryOpen] = useState(back?.historyOpen ?? false) // 수정 기록 창 (새 안 5번)
  const [version, setVersion] = useState<number | null>(back?.version ?? null) // 창에서 고른 버전 (null = 현재 버전)
  const [showCall, setShowCall] = useState(back?.showCall ?? false) // 반영 전 띠의 토글 — true = 통화에 쓰는 내용
  useEffect(() => {
    if (SCENARIO_TEST) keep(key, { personaSeq, historyOpen, version, showCall })
  }, [key, personaSeq, historyOpen, version, showCall])
  return {
    personaSeq,
    setPersonaSeq,
    historyOpen,
    setHistoryOpen,
    version,
    setVersion,
    showCall,
    setShowCall,
  }
}
