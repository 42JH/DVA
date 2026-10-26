// 탭 두 가지 (와이어프레임 10/23)
// Tabs: 밑줄 탭 — 03 · 04 고객 유형(전체 · 기업 · 개인), 05 보기(전체 · AI 미답변 n). 줄 높이 48, 아래 구분선, 오른쪽에 버튼 자리
// CountTabs: 칸 탭 — 10 상태(전체 11 · 승인 대기 3 · 관리자 8). 기간 칸과 같은 모양(모서리 8, 고른 칸 옅은 남색 + 남색 선)

export interface TabItem<K extends string = string> {
  key: K
  label: string
  count?: number
  countKind?: 'badge' | 'red' // badge = 빨간 바탕 흰 숫자(05 AI 미답변), red = 빨간 숫자(10 승인 대기)
}

export function Tabs<K extends string>({
  items,
  value,
  onChange,
  right,
}: {
  items: TabItem<K>[]
  value: K
  onChange: (key: K) => void
  right?: React.ReactNode // [CSV 내보내기] [삭제] 등
}) {
  return (
    <div role="tablist" className="flex h-12 items-center gap-10 border-b border-line">
      {items.map((t) => {
        const on = t.key === value
        return (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={on}
            onClick={() => onChange(t.key)}
            className={`relative flex h-full items-center gap-2 text-body ${on ? 'font-bold text-action' : 'text-sub'}`}
          >
            {t.label}
            {t.count !== undefined &&
              (t.countKind === 'badge' ? (
                <span className="inline-flex h-6 min-w-6 items-center justify-center rounded-full bg-danger px-2 text-caption font-bold text-white">
                  {t.count}
                </span>
              ) : (
                <span className={t.countKind === 'red' ? 'font-semibold text-danger' : 'text-sub'}>
                  {t.count}
                </span>
              ))}
            {on && <span className="absolute inset-x-0 bottom-0 h-[3px] rounded-full bg-action" />}
          </button>
        )
      })}
      {right && <div className="ml-auto flex items-center gap-3">{right}</div>}
    </div>
  )
}

export function CountTabs<K extends string>({
  items,
  value,
  onChange,
}: {
  items: TabItem<K>[]
  value: K
  onChange: (key: K) => void
}) {
  return (
    <div role="tablist" className="flex gap-2">
      {items.map((t) => {
        const on = t.key === value
        return (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={on}
            onClick={() => onChange(t.key)}
            className={`flex h-12 items-center gap-2 rounded-lg border px-5 text-body ${
              on
                ? 'border-[1.5px] border-action bg-action-soft font-semibold text-action'
                : 'border-line bg-surface text-ink'
            }`}
          >
            {t.label}
            {t.count !== undefined && (
              <span
                className={
                  on ? '' : t.countKind === 'red' ? 'font-semibold text-danger' : 'text-sub'
                }
              >
                {t.count}
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
}
