import { Link } from 'react-router'
import { fmtDateTimeDay } from '../../../shared/lib/format'
import { Button, Tag } from '../../../shared/ui'
import type { EditableField, OrderEdit, ResultField } from '../viewmodel/useCallDetailViewModel'

// 통화 결과 카드 (06 오른쪽) — 보내는 분 · 받는 분 · 접수 정보, 항목 이름 왼쪽 / 값 오른쪽 열
// 고친 칸은 [수정됨] + 마우스 올리면 로그(수정한 사람 · 시각 · 전 → 후 · 요청 통화). 수정 사유 없음 (10/21)
// 관리자는 AI가 잘못 받아 적은 칸만 값을 눌러 고침: 입력칸 + [취소] [저장]
export function CallResult({
  className = '',
  hasOrder,
  sections,
  editing,
  onStartEdit,
  onEditValue,
  onCancel,
  onSave,
  isSaving,
  saveError,
}: {
  className?: string
  hasOrder: boolean
  sections: { title: string; fields: ResultField[] }[]
  editing: { key: EditableField; value: string } | null
  onStartEdit: (key: EditableField, value: string) => void
  onEditValue: (value: string) => void
  onCancel: () => void
  onSave: () => void
  isSaving: boolean
  saveError: string | null
}) {
  return (
    <section className={`rounded-xl bg-surface p-8 ring-1 ring-line ring-inset ${className}`}>
      <div className="flex h-10 items-center gap-2">
        <h2 className="text-card font-bold">통화 결과</h2>
        <span
          className="text-label text-muted"
          title="값을 누르면 고칠 수 있습니다. 고친 항목은 수정됨으로 표시됩니다."
        >
          ⓘ
        </span>
      </div>

      {!hasOrder ? (
        <p className="py-12 text-body text-muted">접수된 주문이 없는 통화입니다.</p>
      ) : (
        sections.map((sec, i) => (
          <div key={sec.title} className={i ? 'mt-3 border-t border-line pt-3' : 'mt-3.5'}>
            <h3 className="h-[34px] text-body leading-[34px] font-bold">{sec.title}</h3>
            {sec.fields.map((f) => {
              const isEditing = editing?.key === f.key
              return (
                <div key={f.key} className="flex min-h-9 items-center gap-6 py-1">
                  <span className="w-[112px] shrink-0 text-label text-sub">{f.label}</span>
                  {isEditing ? (
                    <div className="relative flex-1">
                      <input
                        autoFocus
                        aria-label={f.label}
                        value={editing.value}
                        onChange={(e) => onEditValue(e.target.value)}
                        onKeyDown={(e) => {
                          // 한글 조합 중 Enter(isComposing)는 확정일 뿐 — 저장 아님
                          if (e.key === 'Enter' && !e.nativeEvent.isComposing) onSave()
                          if (e.key === 'Escape') onCancel()
                        }}
                        className="-ml-3.5 h-9 w-[calc(100%+14px)] rounded-lg bg-surface px-3.5 text-body ring-[1.5px] ring-action outline-none ring-inset"
                      />
                      {/* 고치는 칸 오른쪽 아래 떠 있는 상자: 취소 · 저장만 */}
                      <div className="absolute top-full right-0 z-10 mt-2 flex items-center gap-2 rounded-xl bg-surface p-3 shadow-[0_12px_40px_rgba(43,47,54,0.16)] ring-1 ring-line ring-inset">
                        {saveError && (
                          <span className="pr-2 text-caption font-semibold text-danger">
                            {saveError}
                          </span>
                        )}
                        <Button onClick={onCancel}>취소</Button>
                        <Button kind="primary" onClick={onSave} disabled={isSaving}>
                          저장
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <span className="flex min-w-0 flex-1 items-center gap-2.5">
                      {/* 값은 잘라내지 않고 줄바꿈 — 긴 주소 · 품목도 다 보이게 */}
                      {f.editable ? (
                        <button
                          type="button"
                          onClick={() => onStartEdit(f.key as EditableField, f.value)}
                          title="눌러서 고치기"
                          className="-mx-2 rounded-md px-2 text-left text-body break-words hover:bg-bg"
                        >
                          {f.value}
                        </button>
                      ) : (
                        <span className="text-body break-words">{f.value}</span>
                      )}
                      {f.edit && <EditedTag edit={f.edit} />}
                      {f.fixed && <span className="ml-auto text-caption text-muted">고정</span>}
                    </span>
                  )}
                </div>
              )
            })}
          </div>
        ))
      )}
    </section>
  )
}

/** [수정됨] + 마우스 올리면 수정 로그 (06 · 05 상세 공용 모양) */
function EditedTag({ edit }: { edit: OrderEdit }) {
  const rows: [string, React.ReactNode][] = [
    ['수정한 사람', edit.editedBy.name],
    ['수정 시각', fmtDateTimeDay(edit.editedAt)],
    ['수정 전 → 후', `${edit.before || '—'} → ${edit.after || '—'}`],
  ]
  if (edit.requestCallSessionSeq)
    rows.push([
      '요청 통화',
      <Link to={`/inquiries/${edit.requestCallSessionSeq}`} className="text-action">
        {fmtDateTimeDay(edit.editedAt)} 통화 문의 ›
      </Link>,
    ])
  // 툴팁은 태그 아래 12 띄우되 그 사이를 padding으로 메워 마우스가 내려가도 안 닫힘. 키보드(Tab)로도 열림
  // 오른쪽 끝을 태그에 맞춰 왼쪽으로 펼침 — 결과 카드가 화면 오른쪽이라 카드 밖으로 안 나가게
  return (
    <span className="group relative shrink-0" tabIndex={0}>
      <Tag kind="blue">수정됨</Tag>
      <span className="absolute top-full right-0 z-10 hidden pt-3 group-focus-within:block group-hover:block">
        <span className="relative block w-max rounded-xl bg-surface p-5 text-label shadow-[0_12px_40px_rgba(43,47,54,0.16)] ring-1 ring-line ring-inset">
          <span className="absolute -top-[7px] right-5 size-3 rotate-45 border-t border-l border-line bg-surface" />
          <span className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2.5">
            {rows.map(([k, v]) => (
              <span key={k} className="contents">
                <span className="text-sub">{k}</span>
                <span className="font-semibold text-ink">{v}</span>
              </span>
            ))}
          </span>
        </span>
      </span>
    </span>
  )
}
