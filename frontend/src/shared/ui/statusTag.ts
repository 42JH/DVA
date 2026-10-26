import type { TagKind } from './Tag'

// 통화 결과 · 처리 상태 등 고정 상태값의 태그 색 — 10/20 확정 3종 + 05 처리 상태 2종
// (컴포넌트 파일과 분리: Fast Refresh는 컴포넌트만 export하는 파일을 요구)
export const STATUS_TAG: Record<string, TagKind> = {
  '접수 성공': 'blue',
  '접수 실패': 'red',
  '상담원 이관': 'gray',
  '조치 필요': 'red',
  해결: 'gray',
}
