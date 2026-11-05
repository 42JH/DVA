import { useNavigate, useParams, useSearchParams } from 'react-router'
import { Button, Crumbs, Highlight, Markdown, TopBar } from '@/shared/ui'
import { faqTo, useFaqDetail, useRecentQuestions } from '@/features/faq/hooks/useFaqList'
import { FAQ_GRID, FaqCategoryNav } from './FaqCategories'

// 09 FAQ 상세 (Figma 'FAQ 상세' 11/04) — 경로 'FAQ > FAQ 상세' · 왼쪽 분류(이 FAQ 분류 파랑, 누르면 그 목록)
// 오른쪽: 질문 28/500 · 답변 24(마크다운 — 표 · 목록) · [수정](파랑 선, 답변 아래 오른쪽 — Figma 자리) · 구분선 · 이 FAQ로 AI가 답한 최근 고객 질문
// 질문 · 답변은 수정 화면의 질문칸 · 답변칸과 같은 글자 · 같은 자리 (11/04 사용자: 화면마다 폰트 맞춤)
// 고객 질문 = GET /faqs/{id}의 recentQuestions (11/05 실서버 연동 — 최대 10 · 서버 순서(최신순) 그대로 · 같은 문장도 따로)
//   RAG가 이 FAQ를 고른 발화 원문 그대로('어음... 저...'까지, 가공 · 말줄임 없음, 일반 글). 없으면 구분선째 안 보임
// 한 화면에 다 보이게: 답변 칸이 남는 높이를 채우고, 긴 답변은 그 칸 안에서 스크롤 (화면 전체는 안 밀림)
// 검색해서 들어오면(?q=) 경로 'FAQ > “박스” 검색 > “박스” 검색 상세' · 질문 · 답변의 맞은 자리 하이라이트 (11/04 사용자)
export function FaqDetailPage() {
  const id = Number(useParams().faqId)
  const q = useSearchParams()[0].get('q') ?? ''
  const { faq, isLoading, error } = useFaqDetail(id)
  const questions = useRecentQuestions(id)
  const navigate = useNavigate()

  return (
    <>
      <TopBar search={{ tab: 'faq' }} />
      <Crumbs
        items={
          q
            ? [
                { label: 'FAQ', to: faqTo.list(faq?.category) },
                { label: `“${q}” 검색`, to: faqTo.search(q) },
                { label: `“${q}” 검색 상세` },
              ]
            : [{ label: 'FAQ', to: faqTo.list(faq?.category) }, { label: 'FAQ 상세' }]
        }
        className="pl-17"
      />

      {/* 수정 화면(FaqEditPage)과 같은 틀 — 분류 상자 안 여백 20 · 질문 줄 높이 76 · 답변 위아래 24 */}
      <div className={`${FAQ_GRID} mb-v44 min-h-80 flex-1 grid-rows-[minmax(0,1fr)] pt-v84`}>
        <div className="pt-5">
          <FaqCategoryNav value={faq?.category ?? null} />
        </div>
        {faq ? (
          <article className="flex min-h-0 min-w-0 flex-col">
            <h1 className="flex min-h-v76 shrink-0 items-center px-5 text-v28 font-medium break-words">
              <span>
                <Highlight text={faq.question} q={q} />
              </span>
            </h1>
            <Markdown
              text={faq.answer}
              highlight={q}
              className="min-h-15 flex-1 [scrollbar-width:thin] overflow-y-auto px-5 py-6 text-v24"
            />
            <div className="flex shrink-0 justify-end">
              <Button kind="brandLine" big onClick={() => navigate(faqTo.edit(id, q))}>
                수정
              </Button>
            </div>
            {questions.length > 0 && (
              <ul
                aria-label="이 FAQ로 답한 최근 고객 질문"
                className="mt-5 flex shrink-0 flex-col gap-4 border-t border-line px-5 pt-6"
              >
                {questions.map((qe) => (
                  <li
                    key={qe.faqQuestionExampleSeq}
                    className="flex items-start gap-2 text-body text-sub"
                  >
                    <svg
                      viewBox="0 0 16 16"
                      className="mt-[3px] size-4 shrink-0"
                      fill="none"
                      stroke="currentColor"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden
                    >
                      <path d="M8 14C11.3137 14 14 11.3137 14 8C14 4.68629 11.3137 2 8 2C4.68629 2 2 4.68629 2 8C2 8.7981 2.15582 9.5598 2.43871 10.2563C2.49285 10.3897 2.51992 10.4563 2.532 10.5102C2.54381 10.5629 2.54813 10.6019 2.54814 10.6559C2.54814 10.7111 2.53812 10.7713 2.51807 10.8916L2.12275 13.2635C2.08135 13.5119 2.06065 13.6361 2.09917 13.7259C2.13289 13.8045 2.19552 13.8671 2.27412 13.9008C2.36393 13.9393 2.48812 13.9186 2.73651 13.8772L5.10843 13.4819C5.22872 13.4619 5.28887 13.4519 5.34409 13.4519C5.3981 13.4519 5.43711 13.4562 5.48981 13.468C5.54369 13.4801 5.61035 13.5072 5.74366 13.5613C6.4402 13.8442 7.2019 14 8 14Z" />
                    </svg>
                    <span className="min-w-0 break-words whitespace-pre-wrap">
                      {qe.questionText}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </article>
        ) : (
          <p className="pt-6 pl-5 text-body text-sub">
            {isLoading ? '불러오는 중…' : (error ?? '없는 FAQ입니다. 이미 지워졌을 수 있어요.')}
          </p>
        )}
      </div>
    </>
  )
}
