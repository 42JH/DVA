import { UnansweredPreview } from '@/features/faq/components/UnansweredPreview'
import { HomeToday } from '@/features/home/components/HomeToday'

// 01 홈 — 두 기능을 배치만 함 (컨벤션 4.5): 검색 · 오늘 숫자(home) + 처리할 AI 미답변(faq, 09와 같은 표 · 버튼)
export function HomePage() {
  return (
    <div className="flex flex-col gap-8">
      <HomeToday />
      <UnansweredPreview />
    </div>
  )
}
