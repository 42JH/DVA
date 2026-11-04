import { createContext } from 'react'

// 새 디자인 창(Dialog, 11/04~) 안의 입력칸은 새 모양 — 파랑(brand) 포커스 · 검색칸 선 색(field) · 라벨 16 · 파랑 칩
// Dialog가 켜고 TextField · Stepper · ChipGroup · AddressField가 읽음. 옛 화면 창(FormModal) 안은 그대로
// → 화면을 새 디자인으로 바꿀 때 창만 Dialog로 바꾸면 칸도 따라옴. 라벨 칸 폭은 CSS 변수 --field-label(기본 120)
// (컴포넌트 파일과 분리: Fast Refresh는 컴포넌트만 export하는 파일을 요구)
export const NewLook = createContext(false)
