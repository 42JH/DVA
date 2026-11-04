import { useEffect, useState, type KeyboardEvent, type ReactNode } from 'react'
import { useRecentSearches } from '@/shared/lib/recentSearches'
import { Overlay } from './Modal'

// 상단바 검색 (11/05 사용자: 모든 화면 상단바에 검색칸 → 누르면 창, 화면마다 창 안이 다름) — 09 FAQ 검색 창과 같은 틀
// 상단바엔 검색칸 모양 버튼(폭 317 · 높이 32). 검색칸 색(field)으로 선 · 돋보기 · 안내 글 통일, 안내 글 '어떤 정보를 찾고 계신가요?'
// 창: 칸(주문은 보내는 분 · 받는 분 두 칸) · 칸이 하나고 recentKey가 있으면 최근 검색어, 아니면 찾는 법 한 줄 · Enter = 목록에 적용 · ✕ · Esc · 바깥 = 닫기
// preview(주문 · 통화 · AI 미답변, 11/05): 치다 멈추면(0.25초) 맞는 것 몇 줄 → 누르면 바로 그 상세. Enter는 그대로 목록에 적용
export const SEARCH_PLACEHOLDER = '어떤 정보를 찾고 계신가요?'

export const SearchIcon = ({ className }: { className: string }) => (
  <svg
    viewBox="0 0 20 20"
    className={`shrink-0 stroke-field ${className}`}
    fill="none"
    strokeWidth={1.6}
    strokeLinecap="round"
    aria-hidden
  >
    <circle cx="8.5" cy="8.5" r="6" />
    <path d="M13 13l4.5 4.5" />
  </svg>
)

export const XIcon = ({ className }: { className: string }) => (
  <svg viewBox="0 0 20 20" className={`stroke-current ${className}`} strokeWidth={1.8} aria-hidden>
    <path d="M5 5l10 10M15 5L5 15" strokeLinecap="round" />
  </svg>
)

/** 상단바 검색칸 자리 버튼 — 검색 중이면 검색어와 ✕(검색 지우기) */
export function TopSearchButton({
  text,
  onOpen,
  onClear,
}: {
  text: string
  onOpen: () => void
  onClear: () => void
}) {
  return (
    <div className="relative">
      <button
        type="button"
        aria-haspopup="dialog"
        onClick={onOpen}
        className="flex h-8 w-full items-center gap-6 rounded-lg bg-surface pr-9 pl-5 text-left text-body ring-1 ring-field ring-inset hover:bg-bg"
      >
        <SearchIcon className="size-4" />
        <span className={`truncate ${text ? 'text-ink' : 'text-field'}`}>
          {text || SEARCH_PLACEHOLDER}
        </span>
      </button>
      {text && (
        <button
          type="button"
          aria-label="검색 지우기"
          onClick={onClear}
          className="absolute top-1/2 right-2 grid size-6 -translate-y-1/2 place-items-center rounded text-sub hover:bg-bg hover:text-ink"
        >
          <XIcon className="size-4" />
        </button>
      )}
    </div>
  )
}

export interface SearchField {
  label?: string // 칸이 여럿일 때 칸 앞 이름 ('보내는 분')
  value: string // 지금 적용된 검색어
  placeholder?: string
}

/** 상단바 검색 — 버튼 + 창. onApply는 칸 순서대로 다듬은 값 (빈 칸 = 그 검색 지움) */
export function TopSearch({
  name,
  fields,
  hint,
  recentKey,
  onApply,
  preview,
}: {
  name: string // 창 이름 '주문 검색'
  fields: SearchField[]
  hint: string // 칸이 비었을 때 찾는 법
  recentKey?: string // 이름 · 전화번호를 찾는 화면은 안 줌 (개인정보 — shared/lib/recentSearches)
  onApply: (values: string[]) => void
  preview?: Preview
}) {
  const [open, setOpen] = useState(false)
  const text = fields
    .filter((f) => f.value)
    .map((f) => (f.label ? `${f.label} ${f.value}` : f.value))
    .join(' · ')
  return (
    <>
      <TopSearchButton
        text={text}
        onOpen={() => setOpen(true)}
        onClear={() => onApply(fields.map(() => ''))}
      />
      {open && (
        <SearchModal
          name={name}
          fields={fields}
          hint={hint}
          recentKey={fields.length === 1 ? recentKey : undefined}
          onApply={onApply}
          preview={preview}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  )
}

function SearchModal({
  name,
  fields,
  hint,
  recentKey,
  onApply,
  onClose,
  preview,
}: {
  name: string
  fields: SearchField[]
  hint: string
  recentKey?: string
  onApply: (values: string[]) => void
  onClose: () => void
  preview?: Preview
}) {
  const [vals, setVals] = useState(() => fields.map((f) => f.value))
  const recent = useRecentSearches(recentKey)
  const typed = vals.some((v) => v.trim())
  // 미리 보기는 치다 멈췄을 때만 (글자마다 서버에 묻지 않게)
  const [settled, setSettled] = useState(vals)
  useEffect(() => {
    const t = setTimeout(() => setSettled(vals.map((v) => v.trim())), 250)
    return () => clearTimeout(t)
  }, [vals])

  const type = (i: number, v: string) => setVals(vals.map((x, j) => (j === i ? v : x)))
  const apply = () => {
    const out = vals.map((v) => v.trim())
    recent.add(out[0])
    onApply(out)
    onClose()
  }
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return // 한글 조합을 끝내는 Enter
    if (e.key === 'Enter') {
      e.preventDefault()
      apply()
    }
  }

  return (
    <Overlay
      label={name}
      onClose={onClose}
      top
      dim={false}
      movable
      boxClass="w-[min(560px,calc(100vw-160px))] overflow-hidden ring-1 ring-line"
    >
      {fields.map((f, i) => (
        // 칸 줄을 잡고 끌어 옮김 (입력칸 · ✕ 말고) — 09 FAQ 검색 창과 같음
        <label
          key={f.label ?? i}
          data-drag
          className="flex h-14 shrink-0 cursor-move items-center gap-4 border-b border-line pr-4 pl-6"
        >
          {i === 0 ? <SearchIcon className="size-5" /> : <span className="size-5 shrink-0" />}
          {f.label && <span className="w-16 shrink-0 text-body text-sub">{f.label}</span>}
          <input
            value={vals[i]}
            onChange={(e) => type(i, e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={f.placeholder ?? SEARCH_PLACEHOLDER}
            aria-label={f.label ? `${f.label} 검색` : name}
            className="min-w-0 flex-1 bg-transparent text-strong outline-none placeholder:text-field"
          />
          {i === 0 ? (
            <button
              type="button"
              aria-label="닫기"
              onClick={onClose}
              className="grid size-8 shrink-0 place-items-center rounded-lg text-sub hover:bg-bg hover:text-ink"
            >
              <XIcon className="size-5" />
            </button>
          ) : (
            <span className="size-8 shrink-0" />
          )}
        </label>
      ))}

      {!vals[0].trim() && recent.items.length ? (
        <div className="min-h-0 [scrollbar-width:thin] overflow-y-auto py-2">
          <p className="flex items-center justify-between px-6 pt-2 pb-1 text-caption text-muted">
            최근 검색어
            <button type="button" onClick={recent.clear} className="hover:text-ink">
              전체 삭제
            </button>
          </p>
          <ul>
            {recent.items.map((t) => (
              <li key={t} className="flex items-center justify-between gap-2 px-6 py-0.5">
                <button
                  type="button"
                  onClick={() => type(0, t)}
                  className="min-w-0 truncate py-1.5 text-left text-body hover:text-brand"
                >
                  {t}
                </button>
                <button
                  type="button"
                  aria-label={`최근 검색어 ${t} 지우기`}
                  onClick={() => recent.remove(t)}
                  className="grid size-7 shrink-0 place-items-center rounded text-muted hover:bg-bg hover:text-ink"
                >
                  <XIcon className="size-4" />
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        !typed && <p className="px-6 py-6 text-body break-keep text-sub">{hint}</p>
      )}

      {typed && preview && settled.some(Boolean) && preview(settled, onClose)}

      {typed && (
        <button
          type="button"
          onClick={apply}
          className="flex h-12 shrink-0 items-center justify-between px-6 text-label text-sub hover:bg-bg"
        >
          <span>검색 결과 보기</span>
          <kbd className="font-sans text-caption text-muted">Enter</kbd>
        </button>
      )}
    </Overlay>
  )
}

/** 미리 보기 — 다듬은 칸 값(멈춘 뒤)과 창 닫기를 받아 <PreviewList>를 돌려줌 */
export type Preview = (values: string[], close: () => void) => ReactNode

export interface PreviewItem {
  key: string | number
  main: ReactNode // 왼쪽 굵은 글 (이름 · 질문 — 맞은 자리 하이라이트)
  sub?: ReactNode // 오른쪽 흐린 글 (시각 · 번호)
  onPick: () => void
}

/** 미리 보기 줄들 — 누르면 창을 닫고 그 상세로. 줄은 버튼이라 Tab으로 옮겨 다님
 *  ponytail: ↑↓ 줄 고르기는 없음 (FAQ 창에만) — 쓰는 사람이 찾으면 FaqSearch처럼 active 줄을 둠 */
export function PreviewList({
  title,
  items,
  loading,
  empty,
  close,
}: {
  title: string // '최근 주문'
  items: PreviewItem[]
  loading: boolean
  empty: string // '맞는 주문이 없습니다.'
  close: () => void
}) {
  if (loading && !items.length)
    return <p className="border-b border-line px-6 py-5 text-body text-sub">찾는 중…</p>
  if (!items.length)
    return <p className="border-b border-line px-6 py-5 text-body text-sub">{empty}</p>
  return (
    <div className="min-h-0 [scrollbar-width:thin] overflow-y-auto border-b border-line py-2">
      <p className="px-6 pt-2 pb-1 text-caption text-muted">{title}</p>
      <ul>
        {items.map((it) => (
          <li key={it.key}>
            <button
              type="button"
              onClick={() => {
                close()
                it.onPick()
              }}
              className="flex w-full items-baseline gap-4 px-6 py-3 text-left hover:bg-bg focus-visible:bg-bg focus-visible:outline-none"
            >
              <span className="min-w-0 flex-1 truncate text-body">{it.main}</span>
              {it.sub && <span className="shrink-0 text-label text-sub">{it.sub}</span>}
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}
