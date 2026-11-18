// 미답변 질문을 누르면 뜨는 통화 창 — 화면을 옮기지 않고 그 통화 대화를 보여 주고, 질문한 고객 말로 바로 스크롤해 노랗게
// [통화 상세 열기]로 들어갔다가 뒤로 오면 미답변 문의로 돌아옴 (state.from)
import { Link, useLocation } from 'react-router'
import { useQuestionAt } from '@/features/faq/hooks/useQuestionAt'
import { AiToggle } from '@/shared/call/AiSteps'
import { CallLog } from '@/shared/call/CallLog'
import { useShowAi } from '@/shared/lib/useShowAi'
import { Modal } from '@/shared/ui/Modal'

export function UnansweredCall({
  callSeq,
  unansweredSeq,
  question,
  who,
  onClose,
}: {
  callSeq: number
  unansweredSeq: number
  question: string
  who: string // '강도윤 010-6638-2047'
  onClose: () => void
}) {
  const { pathname, search } = useLocation()
  const [showAi, setShowAi] = useShowAi()
  // 이 질문이 나온 통화 안 시각 — 처리 결과(AI가 답하지 못한 질문)에 있음
  const { sec: focusSec, ready } = useQuestionAt(callSeq, unansweredSeq)
  return (
    <Modal
      title={`통화 #${callSeq}`}
      sub={who}
      width={760}
      onClose={onClose}
      footer={
        <>
          <AiToggle on={showAi} onChange={setShowAi} />
          <Link
            to={`/calls/${callSeq}`}
            state={{ from: pathname + search, unanswered: unansweredSeq }}
            className="ml-auto inline-flex h-8 items-center rounded-md px-3 text-[13px] font-semibold ring-1 ring-ops-line ring-inset hover:bg-ops-paper"
          >
            통화 상세 열기
          </Link>
        </>
      }
    >
      <p className="mb-3 rounded-md bg-ops-wait-soft px-3 py-2 text-[13px]">
        <span className="font-semibold text-ops-wait">AI가 답하지 못한 질문</span>
        <span className="ml-2">“{question}”</span>
      </p>
      {/* 처리 결과를 받은 뒤 그려야 질문한 말로 바로 스크롤됨 */}
      {!ready ? null : <CallLog seq={callSeq} showAi={showAi} focusSec={focusSec} />}
    </Modal>
  )
}
