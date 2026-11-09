import { useContext } from 'react'
import { NewLook } from './newLook'

// 필터 줄 부품 — 높이 48 · 모서리 8. 적용된(applied) 상태 = 옅은 남색 바탕 + 남색 1.5 선 (와이어프레임 04 '불만 있음')
// 상태는 훅(hooks/)이 들고, 여기는 그리기만
// 선은 전부 안쪽 ring — 1 → 1.5로 굵어져도 칸 폭 · 글자 자리가 안 움직이게
const LINE = 'ring-1 ring-line ring-inset'
const LINE_ON = 'ring-[1.5px] ring-action ring-inset'

export interface Option<V extends string = string> {
  value: V
  label: string
  disabledHint?: string // ChipGroup만: 있으면 그 칩을 끄고 칩 안에 작게 이유 ('AI 미지원')
}

/** 버튼 모양 한 개 고르기 — '상태 [전체] [접수 중] …' (03 주문 내역). 고른 칸 = 옅은 남색 바탕 + 남색 1.5 선 */
export function ChipGroup<V extends string>({
  name,
  options,
  value,
  onChange,
  compact,
}: {
  name: string
  options: Option<V>[]
  value: V | null // null = 아직 안 고름 → 켜진 칩 없음 (03 결제 방식 '미정')
  onChange: (v: V) => void
  compact?: boolean // 폼 창 안 (03 주문 추가 결제 방식): 칸 44 · 라벨 왼쪽 120 — TextField inline과 줄이 맞게
}) {
  // 새 디자인 창(Dialog) 안이면 04 통화 필터 칩처럼: 둥근 알약 · 고르면 파랑 채움 · 라벨 16 · 라벨 칸 폭 = --field-label (newLook.ts)
  const fresh = useContext(NewLook)
  return (
    <div
      className={`flex items-center ${compact ? (fresh ? 'gap-2' : 'gap-1.5') : 'gap-2'}`}
      role="radiogroup"
      aria-label={name}
    >
      <span
        className={
          compact
            ? fresh
              ? 'mr-2 w-[var(--field-label,120px)] shrink-0 text-body text-sub'
              : 'mr-4 w-[120px] shrink-0 text-label text-sub'
            : 'mr-2 text-body text-sub'
        }
      >
        {name}
      </span>
      {options.map((o) => {
        const on = o.value === value
        const off = o.disabledHint !== undefined
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={on}
            disabled={off}
            onClick={() => onChange(o.value)}
            className={
              fresh
                ? `h-9 rounded-full px-4 text-body font-semibold ${
                    on
                      ? 'bg-brand text-white'
                      : off
                        ? 'cursor-not-allowed bg-bg text-muted'
                        : 'bg-surface text-sub ring-1 ring-field ring-inset hover:bg-bg'
                  }`
                : `${compact ? 'h-9 px-3.5' : 'h-10 px-5'} rounded-lg text-body ${
                    on
                      ? `${LINE_ON} bg-action-soft font-semibold text-action`
                      : off
                        ? `${LINE} cursor-not-allowed bg-bg text-muted`
                        : `${LINE} bg-surface text-ink`
                  }`
            }
          >
            {o.label}
            {off && <span className="ml-1.5 text-caption">{o.disabledHint}</span>}
          </button>
        )
      })}
    </div>
  )
}
