import { useLocation, useParams } from 'react-router'
import { TopBar } from '@/shared/ui'
import { useCallDetail } from '@/features/call/hooks/useCallDetail'
import { CallActions } from './CallActions'
import { CallPlayer } from './CallPlayer'
import { CallScript } from './CallScript'

// 06 통화 상세 (11/05 새 디자인, 사용자 이미지)
// 상단바: 경로 '통화 > “김민수”님 통화'(04 목록에서 왔으면 그 목록으로) · 발신번호 · AI 미답변 알림
// 몸: 왼쪽 대본(화자 | 말 | 시각, 재생 중인 말 하이라이트) | 오른쪽 AI 동작 기록(아이콘 + 요약, 짚은 말이 부른 동작 하이라이트) — 각자 스크롤
// 맨 아래 재생 줄(카드 폭 전체): 상담가 · 이전/재생/다음 발화 · 진행 막대 · 음량
// 예전 머리(상담 유형 칩 · 시작 시각 · 통화 시간 · 불만 줄)와 처리 내용(주문 보기 · AI 미답변 보기)은 새 디자인에 없어 뺌
export function CallDetailPage() {
  const { callId } = useParams()
  // 라우트는 하나(calls/:callId)라 통화가 바뀌어도(관련 통화 · 뒤로가기) 언마운트되지 않음 → key로 다시 마운트해 플레이어를 초기화
  return <CallDetailBody key={callId} callId={Number(callId)} />
}

function CallDetailBody({ callId }: { callId: number }) {
  const vm = useCallDetail(callId)
  // 04 목록에서 왔으면 그 주소(날짜 · 검색 · 필터 그대로)로, 다른 곳(주문 상세 · AI 미답변)에서 왔으면 오늘 목록으로
  const from = (useLocation().state as { from?: string } | null)?.from ?? '/calls'

  return (
    <div className="flex min-h-0 flex-[1_1_0px] flex-col">
      <TopBar
        crumbs={[
          { label: '통화', to: from },
          { label: vm.customer ? `“${vm.customer}”님 통화` : '통화 상세' },
        ]}
        extra={vm.caller && <span className="shrink-0 text-card tabular-nums">{vm.caller}</span>}
      />
      {vm.error ? (
        <p className="py-16 text-center text-body text-muted">{vm.error}</p>
      ) : (
        <>
          {vm.notice && (
            <p role="status" className="shrink-0 pb-1 text-caption text-muted">
              {vm.notice}
            </p>
          )}
          <div className="mt-v24 flex min-h-0 flex-1 gap-10">
            <CallScript
              className="min-w-0 flex-1"
              segments={vm.segments}
              focusKey={vm.focusKey}
              jump={vm.jump}
              emptyText={vm.isLoading ? '불러오는 중…' : vm.scriptEmpty}
            />
            <CallActions
              className="w-[min(420px,32%)] shrink-0"
              actions={vm.actions}
              emptyText={vm.actionsEmpty}
            />
          </div>
          {/* 카드 폭 전체 · 위 구분선 — 본문 좌우 · 아래 여백(content)을 끌어옴 */}
          <CallPlayer
            className="-mx-content mt-4 -mb-content shrink-0 border-t border-line px-content pt-5 pb-6"
            player={vm.player}
            audioRef={vm.audioRef}
            persona={vm.persona}
          />
        </>
      )}
    </div>
  )
}
