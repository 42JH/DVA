import { useEffect, useRef } from 'react'
import { Button, FormModal, Tag } from '@/shared/ui'
import { useTestCall, type TestCallTarget } from '@/features/persona/hooks/useTestCall'

// 07 시험 통화 창 (와이어프레임 07_페르소나관리_시험통화, 10/31)
// '시험 통화' + 빨간 '통화 중' · 통화 시간 → 설명 줄 → 대화 줄(AI 남색 / 나 회색 · 말 · 시각) → 🎙 듣는 중 → [통화 끝내기]
// 닫기(✕ · Esc)도 통화를 끝냄 — 몰래 계속되는 통화가 없게
export function TestCallModal({
  target,
  onEnd,
}: {
  target: TestCallTarget
  onEnd: (seconds: number) => void
}) {
  const vm = useTestCall(target, onEnd)
  const bottom = useRef<HTMLDivElement>(null)
  // 새 말이 나오면 아래로. 중괄호 필수: 최신 브라우저는 scrollIntoView가 Promise를 돌려줘서, 그대로 반환하면 React가 정리 함수로 오해함
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'nearest' })
  }, [vm.lines.length])

  return (
    <FormModal
      title="시험 통화"
      titleExtra={
        <>
          <Tag kind="red">통화 중</Tag>
          <span className="ml-4 text-strong font-bold tabular-nums" aria-label="통화 시간">
            {vm.clock}
          </span>
        </>
      }
      description={vm.subtitle}
      width={720}
      onClose={vm.end}
      footer={
        <Button kind="danger" onClick={vm.end}>
          통화 끝내기
        </Button>
      }
    >
      <ol aria-live="polite" className="flex flex-col">
        {vm.lines.map((l) => (
          <li
            key={l.key}
            className="grid min-h-[46px] grid-cols-[56px_1fr_auto] items-center gap-x-2"
          >
            <span className={`text-caption font-bold ${l.isAi ? 'text-action' : 'text-sub'}`}>
              {l.who}
            </span>
            <span className="text-body">{l.text}</span>
            <span className="text-caption text-sub tabular-nums">{l.time}</span>
          </li>
        ))}
        <li className="flex min-h-[46px] items-center gap-3">
          <span className="grid size-8 place-items-center rounded-full bg-action-soft">
            <svg
              viewBox="0 0 20 20"
              className="size-4 stroke-action"
              fill="none"
              strokeWidth={1.6}
              strokeLinecap="round"
              aria-hidden
            >
              <rect x="7" y="2.5" width="6" height="10" rx="3" />
              <path d="M4.5 9.5a5.5 5.5 0 0 0 11 0M10 15v2.5" />
            </svg>
          </span>
          <span className="text-label font-bold text-action">듣는 중</span>
        </li>
      </ol>
      <div ref={bottom} />
    </FormModal>
  )
}
