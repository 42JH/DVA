// 공통 열 폭 — 같은 종류의 열은 모든 표에서 같은 폭 (내용 + 16). 글 열은 폭을 주지 않고 나머지를 나눠 가짐 (11/02 사용자: 열 사이 거리 통일)
// (컴포넌트 파일(Table.tsx)과 분리: Fast Refresh는 컴포넌트만 export하는 파일을 요구)
export const COL = { no: 56, time: 120, status: 112, duration: 120 } as const
