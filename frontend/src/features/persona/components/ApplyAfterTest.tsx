import { useApplyAfterTest } from '@/features/persona/hooks/useApplyAfterTest'

// '모두 통과하면 반영' 약속을 지켜보는 부품 — 그리는 것 없음
// 앱 틀(AppLayout)이 약속이 있을 때만 불러옴 → 시험 창구 코드가 첫 화면 묶음에 들어가지 않음
export function ApplyAfterTest() {
  useApplyAfterTest()
  return null
}
