import { Badge, Btn } from '@/shared/ui'

// 시험 통과 띠 — 통화에 안 쓰는 상담가가 시나리오를 모두 통과. 저절로 바꾸지 않고 담당자가 [통화에 사용하기]
// [시험 통과] 시나리오 n개 모두 통과 · 시험 시각 | [결과 보기] [통화에 사용하기]. 크기 · 사이는 ApplyBand 띠와 같고 바탕만 초록
export function PassBand({
  total,
  time,
  onOpen,
  onUse,
}: {
  total: number
  time: string // '11월 13일 오후 4:30'
  onOpen?: () => void // 시나리오 시험 결과 화면으로
  onUse?: () => void // 관리 권한이 없으면 없음
}) {
  return (
    <div className="flex flex-wrap items-center gap-3 border-b border-[#cde9da] bg-[#f1faf5] px-7 py-3">
      <Badge tone="done">시험 통과</Badge>
      <span className="text-[16px] font-bold">시나리오 {total}개 모두 통과</span>
      <span className="text-[14px] text-ops-faint">{time} 시험</span>
      <span className="ml-auto flex gap-3">
        {onOpen && <Btn onClick={onOpen}>결과 보기</Btn>}
        {onUse && (
          <Btn kind="line" onClick={onUse}>
            통화에 사용하기
          </Btn>
        )}
      </span>
    </div>
  )
}
