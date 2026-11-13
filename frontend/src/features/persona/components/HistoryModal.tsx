import type { usePersonaPage } from '@/features/persona/hooks/usePersonaPage'
import { Badge, Btn } from '@/shared/ui'
import { Modal } from '@/shared/ui/Modal'

type Vm = ReturnType<typeof usePersonaPage>

// 수정 기록 창 (11/13 새 안 5번, 피그마 2368:6500) — 왼쪽 날짜별 목록, 오른쪽은 고른 날짜 내용 중 통화에 쓰는 내용과 다른 칸만
// [이 내용 불러오기] = 그 내용으로 새 버전 저장 → 창이 닫히고 (사용 중 상담가면) 반영 전 띠
export function HistoryModal({ vm }: { vm: Vm }) {
  const d = vm.picked
  return (
    <Modal
      title="수정 기록"
      width={960}
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
      <div className="grid min-h-[420px] grid-cols-[240px_1fr] gap-6">
        <ol className="flex flex-col gap-1 border-r border-ops-line pr-4">
          {vm.history.map((h) => (
            <li key={h.version}>
              <button
                type="button"
                aria-current={h.selected || undefined}
                onClick={() => vm.selectVersion(h.version)}
                className={`w-full rounded-lg px-3 py-2.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ops-route ${h.selected ? 'bg-ops-route-soft' : 'hover:bg-ops-paper'}`}
              >
                <span
                  className={`block text-[15px] font-bold ${h.selected ? 'text-ops-route' : ''}`}
                >
                  {h.time}
                </span>
                <span className="mt-1 flex flex-wrap items-center gap-2 text-[13px] text-ops-sub">
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
          <section aria-label={d.title} className="min-w-0">
            <h3 className="flex flex-wrap items-baseline gap-2 text-[15px] font-bold">
              {d.title}
              <span className="text-[13px] font-normal text-ops-sub">
                {d.changed.length
                  ? `통화에 쓰는 내용과 다른 항목 ${d.changed.length}개`
                  : '통화에 쓰는 내용과 같습니다'}
              </span>
            </h3>
            {d.changed.map((s) => (
              <div key={s.key} className="border-b border-ops-line py-4">
                <h4 className="mb-2 text-[14px] font-bold">{s.title}</h4>
                <DiffText rows={s.rows!} />
              </div>
            ))}
          </section>
        )}
      </div>
    </Modal>
  )
}

type Rows = NonNullable<NonNullable<Vm['picked']>['changed'][number]['rows']>

// 비교 글 — 빠진 말 = 파란 취소선, 더한 말 = 파란 강조
function DiffText({ rows }: { rows: Rows }) {
  return (
    <span className="block text-[14px] leading-6 whitespace-pre-wrap">
      {rows.map((r) => (
        <span key={r.key} className="block">
          {r.parts.map((x, i) =>
            x.kind === 'del' ? (
              <del key={i} className="decoration-ops-route">
                <span className="sr-only">빠진 말: </span>
                {x.text}
              </del>
            ) : x.kind === 'add' ? (
              <ins key={i} className="bg-ops-route-soft text-ops-route no-underline">
                <span className="sr-only">더한 말: </span>
                {x.text}
              </ins>
            ) : (
              x.text || ' '
            ),
          )}
        </span>
      ))}
    </span>
  )
}
