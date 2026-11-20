// 화면 틀(AppLayout)이 한 번 받아 둔 상단 · 사이드바 상태 — 화면 위 줄(PageHead) · 홈이 같이 씀
// 틀만 받음: 부를 때마다 진행 통화 SSE가 하나씩 더 열리던 것
import { createContext, useContext } from 'react'

export interface Shell {
  name: string // 로그인한 관리자
  isSystemAdmin: boolean
  logout: () => void
  persona: string | null // 지금 통화에 쓰는 AI 상담가
  liveCalls: number | null // 진행 중 통화 수 (아직 못 받으면 null)
  live: boolean // 진행 통화 수 연결이 살아 있나
  unanswered: number | null // 미답변 문의 수
}

export const ShellContext = createContext<Shell | null>(null)

export function useShell(): Shell {
  const s = useContext(ShellContext)
  if (!s) throw new Error('useShell은 AppLayout 안에서만 씁니다.')
  return s
}
