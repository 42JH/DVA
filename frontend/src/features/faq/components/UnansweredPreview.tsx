import { Link } from 'react-router'
import { useUnansweredList } from '@/features/faq/hooks/useUnansweredList'
import { UnansweredTable } from './UnansweredTable'

const PREVIEW = 6 // 01 홈 미리보기 6줄 (와이어프레임 01)

// 01 홈 '처리할 AI 미답변' — 09 AI 미답변의 앞 6줄(오래된 순). [FAQ 추가] · [삭제]도 그 화면과 똑같이 동작
export function UnansweredPreview() {
  const vm = useUnansweredList(PREVIEW)

  return (
    <UnansweredTable
      vm={vm}
      head={
        <>
          <h2 className="flex items-baseline gap-3.5 text-card font-bold">
            처리할 AI 미답변
            <span className="text-label font-normal text-sub">{vm.count}개</span>
          </h2>
          <Link to="/faqs/unanswered" className="text-label font-bold text-action">
            자세히 보기 ›
          </Link>
        </>
      }
      empty="처리할 AI 미답변이 없습니다."
    />
  )
}
