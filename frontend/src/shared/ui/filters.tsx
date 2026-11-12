// 고르기 칸의 항목 한 개 (주문 폼 결제 방식 · 음성 고르기). 그리는 부품은 Field.tsx (11/12 옛 ChipGroup 지움)
export interface Option<V extends string = string> {
  value: V
  label: string
  disabledHint?: string // 있으면 그 칸을 끄고 칸 안에 작게 이유 ('AI 미지원')
}
