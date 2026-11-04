import { Link } from 'react-router'
import { FAQ_CATEGORIES, faqTo, type FaqCategory } from '@/features/faq/hooks/useFaqList'

// 09 FAQ 네 화면 공통 틀 (Figma 'FAQ' · 'FAQ 상세' · 'FAQ 등록' · 'FAQ 수정' 11/04) — 왼쪽 분류 열 244 · 36 띄우고 내용
// 카드 왼쪽 64부터 · 오른쪽 끝은 작성 상자 끝(카드 오른쪽에서 118). 분류 글자는 카드 왼쪽 100 — 경로 · 상자 안 분류와 같은 선
// 위 여백은 화면마다(상단바 · 경로 아래 디자인 자리). 세로 크기는 화면 높이를 따라 줄고 늚(text-v24 · gap-v28 … global.css) — 한 화면에 다 보이게
// 오른쪽 여백은 화면 폭을 따라 (1440에서 86, 1920에서 115)
export const FAQ_GRID =
  'grid grid-cols-[244px_minmax(0,1fr)] gap-x-9 pr-[clamp(32px,5.97vw,160px)] pl-8'

const tone = (on: boolean) => (on ? 'text-brand' : 'text-sub hover:text-ink')

/** 목록 · 상세: 분류를 누르면 그 분류 목록으로 (고른 분류 = 파랑 · 24/600 · 줄 간격 57). value null = 고른 분류 없음(검색 중) */
export function FaqCategoryNav({ value }: { value: FaqCategory | null }) {
  return (
    <nav aria-label="분류" className="flex flex-col items-start gap-v24 pl-9">
      {FAQ_CATEGORIES.map(({ name }) => (
        <Link
          key={name}
          to={faqTo.list(name)}
          aria-current={value === name ? 'true' : undefined}
          className={`text-v24 font-semibold ${tone(value === name)}`}
        >
          {name}
        </Link>
      ))}
    </nav>
  )
}

/** 작성 · 수정: 상자 안에서 분류 하나를 고름 (라디오). 상자 높이에 맞춰 고르게 벌림 — 900 높이에서 줄 간격 61(디자인), 낮으면 좁아짐 */
export function FaqCategoryPicker({
  value,
  onChange,
}: {
  value: FaqCategory | ''
  onChange: (c: FaqCategory) => void
}) {
  return (
    <div
      role="radiogroup"
      aria-label="분류"
      className="flex flex-col items-start justify-between rounded-xl border border-line py-5 pl-9"
    >
      {FAQ_CATEGORIES.map(({ name }) => (
        <button
          key={name}
          type="button"
          role="radio"
          aria-checked={value === name}
          onClick={() => onChange(name)}
          className={`text-v24 font-semibold ${tone(value === name)}`}
        >
          {name}
        </button>
      ))}
    </div>
  )
}
