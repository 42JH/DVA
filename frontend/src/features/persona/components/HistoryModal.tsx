import type { ReactNode } from 'react'
import type { usePersonaPage } from '@/features/persona/hooks/usePersonaPage'
import { Badge, Btn } from '@/shared/ui'
import { Modal } from '@/shared/ui/Modal'

type Vm = ReturnType<typeof usePersonaPage>

// 수정 기록 창 (11/13 새 안 5번, 피그마 2368:6500) — 왼쪽 날짜별 목록, 오른쪽은 고른 날짜 내용 중 통화에 쓰는 내용과 다른 칸만
// [이 내용 불러오기] = 그 내용으로 새 버전 저장 → 창이 닫히고 (사용 중 상담가면) 반영 전 띠
// 크기는 시안: 창 1000 · 몸 540, 목록 300(날짜 16 · 사람 14), 오른쪽 제목 17 · 글 16 / 1.7. 창 머리 · 아래 줄은 공용 창 그대로
export function HistoryModal({ vm }: { vm: Vm }) {
  const d = vm.picked
  const count = d ? d.meta.length + d.changed.length : 0
  return (
    <Modal
      title="수정 기록"
      width={1000}
      onClose={vm.closeHistory}
      footer={
        <>
          {vm.confirmError && (
            <p role="alert" className="text-[12px] text-ops-stop">
              {vm.confirmError}
            </p>
          )}
          <Btn className="ml-auto" onClick={vm.closeHistory}>
            취소
          </Btn>
          {d?.canLoad && (
            <Btn kind="primary" disabled={vm.loading} onClick={vm.loadPicked}>
              {vm.loading ? '불러오는 중…' : '이 내용 불러오기'}
            </Btn>
          )}
        </>
      }
    >
      {/* 공용 창 몸의 여백(24 · 20)을 지워 목록이 창 왼쪽 · 위아래 끝에 닿게 */}
      <div className="-mx-6 -my-5 grid h-[540px] grid-cols-[300px_1fr]">
        <ol className="flex [scrollbar-width:thin] flex-col overflow-y-auto border-r border-ops-line p-2">
          {vm.history.map((h) => (
            <li key={h.version}>
              <button
                type="button"
                aria-current={h.selected || undefined}
                onClick={() => vm.selectVersion(h.version)}
                className={`w-full rounded-lg px-4 py-3.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ops-route ${h.selected ? 'bg-ops-route-soft' : 'hover:bg-ops-paper'}`}
              >
                <span
                  className={`block text-[16px] leading-[19px] font-bold ${h.selected ? 'text-ops-route' : ''}`}
                >
                  {h.time}
                </span>
                <span className="mt-1.5 flex min-h-[22px] flex-wrap items-center gap-2.5 text-[14px] text-ops-faint">
                  {h.author}
                  {h.badges.map((b) => (
                    <Badge key={b.label} tone={b.tone}>
                      {b.label}
                    </Badge>
                  ))}
                </span>
              </button>
            </li>
          ))}
        </ol>
        {d && (
          <section
            aria-label={d.title}
            className="min-w-0 [scrollbar-width:thin] overflow-y-auto px-8"
          >
            <h3 className="flex flex-wrap items-baseline gap-3 pt-5 pb-1 text-[17px] font-bold">
              {d.title}
              <span className="text-[14px] font-normal text-ops-faint">
                {count ? `통화에 쓰는 내용과 다른 항목 ${count}개` : '통화에 쓰는 내용과 같습니다'}
              </span>
            </h3>
            {d.meta.map((m) => (
              <Item key={m.label} title={m.label}>
                <Del>{m.from}</Del> <Ins>{m.to}</Ins>
              </Item>
            ))}
            {d.changed.map((s) => (
              <Item key={s.key} title={s.title}>
                {s.rows!.map((r) => (
                  <span key={r.key} className="block">
                    {r.parts.map((x, i) =>
                      x.kind === 'del' ? (
                        <Del key={i}>{x.text}</Del>
                      ) : x.kind === 'add' ? (
                        <Ins key={i}>{x.text}</Ins>
                      ) : (
                        x.text || ' '
                      ),
                    )}
                  </span>
                ))}
              </Item>
            ))}
          </section>
        )}
      </div>
    </Modal>
  )
}

// 다른 항목 한 칸 — 제목 17 + 비교 글 16 / 1.7, 칸 사이 옅은 선
const Item = ({ title, children }: { title: string; children: ReactNode }) => (
  <div className="border-b border-ops-idle-soft py-5">
    <h4 className="mb-2.5 text-[17px] leading-5 font-bold">{title}</h4>
    <span className="block text-[16px] leading-[1.7] whitespace-pre-wrap">{children}</span>
  </div>
)

// 비교 글 — 빠진 말 = 회색 취소선, 더한 말 = 파란 바탕 굵은 글씨 (시안)
// 빠진 말의 회색은 시안(#8a95a2, 흰 바탕 3.1:1)보다 진한 흐린 글자 색 — 대비 4.5:1 규칙 (11/12 접근성)
const Del = ({ children }: { children: ReactNode }) => (
  <del className="text-ops-faint">
    <span className="sr-only">빠진 말: </span>
    {children}
  </del>
)
const Ins = ({ children }: { children: ReactNode }) => (
  <ins className="rounded-[3px] bg-ops-route-soft font-semibold text-ops-route no-underline">
    <span className="sr-only">더한 말: </span>
    {children}
  </ins>
)
