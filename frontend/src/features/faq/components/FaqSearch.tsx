import { useId, useState, type KeyboardEvent } from 'react'
import { useNavigate } from 'react-router'
import { useRecentSearches } from '@/shared/lib/recentSearches'
import { Highlight, Overlay } from '@/shared/ui'
import { SEARCH_PLACEHOLDER, SearchIcon, TopSearchButton, XIcon } from '@/shared/ui/TopSearch'
import { faqTo, useFaqSearch } from '@/features/faq/hooks/useFaqList'

// 09 FAQ 검색 (11/04 의견: 검색칸을 누르면 모달로) — 상단바엔 검색칸 모양 버튼(폭 317 · 높이 32), 누르면 위쪽에 검색 창
// 창: 검색칸(지금 검색어로 시작) · 맞는 FAQ(모든 분류 · 최근 순 · 8개, 분류 + 질문, 맞은 자리 하이라이트) · 칸이 비면 최근 검색어(하나씩 ✕ · 전체 삭제)
// ↑↓ 줄 고르기 · Enter = 고른 FAQ 상세('“박스” 검색 상세'), 안 골랐으면 목록에 검색 적용('“박스” 검색') · ✕ · Esc · 바깥 클릭 = 닫기
// 폭 560 · 뒤 화면은 안 어둡게 · 윗줄(입력칸 · ✕ 말고)을 잡고 끌어 옮김 (11/04 사용자)
// 11/05: 버튼 · 아이콘은 다른 화면 상단바 검색(shared/ui/TopSearch)과 같은 것 — 안내 글 '어떤 정보를 찾고 계신가요?' · 검색칸 색
const SHOW = 8

/** 상단바 검색칸 자리 — 검색 중이면 검색어와 ✕(검색 지우기) */
export function FaqSearch({ q, onApply }: { q: string; onApply: (q: string) => void }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <TopSearchButton text={q} onOpen={() => setOpen(true)} onClear={() => onApply('')} />
      {open && <SearchModal initial={q} onApply={onApply} onClose={() => setOpen(false)} />}
    </>
  )
}

function SearchModal({
  initial,
  onApply,
  onClose,
}: {
  initial: string
  onApply: (q: string) => void
  onClose: () => void
}) {
  const [q, setQ] = useState(initial)
  const [active, setActive] = useState(-1)
  const hits = useFaqSearch(q)
  const recent = useRecentSearches('faq')
  const navigate = useNavigate()
  const listId = useId()
  const term = q.trim()
  const shown = term ? hits.slice(0, SHOW) : []

  const type = (v: string) => {
    setQ(v)
    setActive(-1)
  }
  const openFaq = (id: number) => {
    recent.add(term)
    onClose()
    navigate(faqTo.detail(id, term))
  }
  const apply = () => {
    recent.add(term)
    onApply(term) // 빈 칸이면 검색을 지움 (분류 목록으로)
    onClose()
  }
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return // 한글 조합을 끝내는 Enter · 방향키
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!shown.length) return
      e.preventDefault()
      const down = e.key === 'ArrowDown' // 끝에서 다시 처음으로 돎
      setActive(down ? (active + 1) % shown.length : active <= 0 ? shown.length - 1 : active - 1)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (shown[active]) openFaq(shown[active].faqEntrySeq)
      else apply()
    }
  }

  return (
    <Overlay
      label="FAQ 검색"
      onClose={onClose}
      top
      dim={false}
      movable
      boxClass="w-[min(560px,calc(100vw-160px))] overflow-hidden ring-1 ring-line"
    >
      <label
        data-drag
        className="flex h-14 shrink-0 cursor-move items-center gap-4 border-b border-line pr-4 pl-6"
      >
        <SearchIcon className="size-5" />
        <input
          value={q}
          onChange={(e) => type(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={SEARCH_PLACEHOLDER}
          role="combobox"
          aria-label="FAQ 검색"
          aria-expanded={shown.length > 0}
          aria-controls={listId}
          aria-activedescendant={active >= 0 ? `${listId}-${active}` : undefined}
          className="min-w-0 flex-1 bg-transparent text-strong outline-none placeholder:text-field"
        />
        <button
          type="button"
          aria-label="닫기"
          onClick={onClose}
          className="grid size-8 shrink-0 place-items-center rounded-lg text-sub hover:bg-bg hover:text-ink"
        >
          <XIcon className="size-5" />
        </button>
      </label>

      <div className="min-h-0 [scrollbar-width:thin] overflow-y-auto py-2">
        {term ? (
          shown.length ? (
            <ul id={listId} role="listbox" aria-label="검색 결과">
              {shown.map((f, i) => (
                <li
                  key={f.faqEntrySeq}
                  id={`${listId}-${i}`}
                  role="option"
                  aria-selected={i === active}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => openFaq(f.faqEntrySeq)}
                  className={`flex cursor-pointer items-baseline gap-4 px-6 py-3 ${i === active ? 'bg-bg' : ''}`}
                >
                  <span className="w-24 shrink-0 text-label text-sub">{f.category}</span>
                  <span className="min-w-0 truncate text-body">
                    <Highlight text={f.question} q={term} />
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="px-6 py-6 text-body text-sub">맞는 FAQ가 없습니다.</p>
          )
        ) : recent.items.length ? (
          <>
            <p className="flex items-center justify-between px-6 pt-2 pb-1 text-caption text-muted">
              최근 검색어
              <button type="button" onClick={recent.clear} className="hover:text-ink">
                전체 삭제
              </button>
            </p>
            {/* 누르는 곳은 검색어 글자와 ✕만 (줄 전체가 아님 — 11/04 사용자: 클릭 범위) */}
            <ul>
              {recent.items.map((t) => (
                <li key={t} className="flex items-center justify-between gap-2 px-6 py-0.5">
                  <button
                    type="button"
                    onClick={() => type(t)}
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
          </>
        ) : (
          // 예시는 따로 한 줄 · 띄어쓰기에서만 줄바꿈 (예시가 'ㅅ / ㄱ'으로 갈리지 않게, 11/04 사용자)
          <p className="px-6 py-6 text-body break-keep text-sub">
            질문 · 답변의 낱말로 찾아요. 띄어쓰기는 무시하고, 초성으로도 찾을 수 있어요.
            <br />
            예: ㅅㄱ → 수거
          </p>
        )}
      </div>

      {term && (
        <button
          type="button"
          onClick={apply}
          className="flex h-12 shrink-0 items-center justify-between border-t border-line px-6 text-label text-sub hover:bg-bg"
        >
          <span>
            “{term}” 검색 결과 {hits.length}건 모두 보기
          </span>
          <kbd className="font-sans text-caption text-muted">Enter</kbd>
        </button>
      )}
    </Overlay>
  )
}
