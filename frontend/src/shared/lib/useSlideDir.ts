import { useState } from 'react'

/** 탭 번호가 바뀐 방향 — 탭 아래 내용을 그 방향에서 미끄러져 들어오게 (11/01 사용자: Gmail처럼). 1 = 오른쪽에서, -1 = 왼쪽에서. 처음은 1
 *  쓰는 법: const dir = useSlideDir(index); <div key={tab} className={slideClass(dir)}>…</div>
 *  (렌더 중에 상태를 고치는 React 문서 방식 — 번호가 바뀐 렌더는 버려지고 새 방향으로 다시 그려짐) */
export function useSlideDir(index: number): -1 | 1 {
  const [seen, setSeen] = useState<{ index: number; dir: -1 | 1 }>({ index, dir: 1 })
  if (seen.index !== index) setSeen({ index, dir: index > seen.index ? 1 : -1 })
  return seen.dir
}

/** 방향에 맞는 애니메이션 클래스 (global.css --animate-slide-in-r · -l). 움직임 줄이기 설정이면 안 움직임 */
export const slideClass = (dir: -1 | 1) =>
  dir > 0 ? 'motion-safe:animate-slide-in-r' : 'motion-safe:animate-slide-in-l'
