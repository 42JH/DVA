// 페르소나 코드 → 화면 문구 (컨벤션 6.3: 코드는 api/, 문구는 labels.ts)
import type { TagKind } from '@/shared/ui'
import type { Speed, VersionStatus, WaitTime } from './api/personaApi'

export const SPEED_LABEL: Record<Speed, string> = {
  SLOW: '속도 느리게',
  NORMAL: '속도 보통',
  FAST: '속도 빠르게',
}

export const WAIT_LABEL: Record<WaitTime, string> = {
  SHORT: '기다리기 짧게',
  NORMAL: '기다리기 보통',
  LONG: '기다리기 길게',
}

// 버전 태그 (와이어프레임 07 버전 히스토리): 작성 중 = 회색, 적용 중 = 파랑. 지난 버전은 태그 없음
export const VERSION_TAG: Record<VersionStatus, { label: string; kind: TagKind } | null> = {
  DRAFT: { label: '작성 중', kind: 'gray' },
  ACTIVE: { label: '적용 중', kind: 'blue' },
  PAST: null,
}
