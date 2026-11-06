import { createContext } from 'react'

/** 상단바(TopBar)가 쓰는 앱 전체 정보 — 여러 기능의 데이터(페르소나 · 진행 통화)라 AppLayout(app 층)이 채워 줌
 *  화면은 검색칸만 TopBar에 넘김 (기능끼리 import 금지 규칙 — 4.2) */
export interface TopBarInfoValue {
  persona: string | null // 지금 통화에 쓰는 페르소나 이름. null이면 상태를 안 그림
  calls: number | null // 진행 통화 수. null = 아직 못 받음
  live: boolean // 진행 통화 수 실시간 연결 중 (false면 점이 회색으로 멈춤)
}

export const TopBarInfo = createContext<TopBarInfoValue>({
  persona: null,
  calls: null,
  live: false,
})
