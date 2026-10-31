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

// 버전 태그 (와이어프레임 07 버전 히스토리): 저장됨(미적용) = 회색 선, 적용 중 = 파랑. 지난 버전은 태그 없음
// '작성 중'은 수정 화면의 저장 전 상태라 여기 없음 (DRAFT_TAG)
export const VERSION_TAG: Record<VersionStatus, { label: string; kind: TagKind } | null> = {
  SAVED: { label: '저장됨', kind: 'outline' },
  ACTIVE: { label: '적용 중', kind: 'blue' },
  PAST: null,
}

export const DRAFT_TAG = '작성 중' // 수정 화면에서 저장하기 전 ('v8 · 작성 중')

// 음성 세부 조절 칩 (와이어프레임 07_음성세부조절 순서 그대로)
export const SPEED_CHOICE: Record<Speed, string> = {
  SLOW: '느리게',
  NORMAL: '보통',
  FAST: '빠르게',
}
export const WAIT_CHOICE: Record<WaitTime, string> = { SHORT: '짧게', NORMAL: '보통', LONG: '길게' }
