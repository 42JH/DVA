import { Button, FileDrop, Dialog } from '@/shared/ui'
import { CSV_HEADER } from '@/features/company/csvMembers'
import { useMemberCsv } from '@/features/company/hooks/useMemberCsv'

// 08 CSV로 사원 추가 창 (기존 기업) — 파일 → 미리 보기('신규 · 바뀜 · 변경 없음') + 바뀌는 사람 → [취소] [등록]
// 디자인엔 이 창이 따로 없어 CSV로 기업 등록 창과 같은 틀 + 미리 보기 (11/01 결정 B: 같은 사번은 덮어쓰므로 먼저 보여 줌)
export function MemberCsvModal({
  companyId,
  companyName,
  onClose,
}: {
  companyId: number
  companyName: string
  onClose: () => void
}) {
  const vm = useMemberCsv(companyId, onClose)

  return (
    <Dialog
      label="CSV로 사원 추가"
      width={600}
      title="CSV로 사원 추가"
      sub={companyName}
      onClose={onClose}
      footer={
        <>
          {vm.errorMessage && (
            <p role="alert" className="min-w-0 text-body text-danger">
              {vm.errorMessage}
            </p>
          )}
          <Button big className="ml-auto" onClick={onClose}>
            취소
          </Button>
          <Button big kind="brand" disabled={!vm.canSubmit} onClick={vm.submit}>
            {vm.isSubmitting ? '등록 중…' : '등록'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <FileDrop
          file={vm.file}
          accept=".csv"
          error={vm.fileError}
          onPick={(f) => void vm.pick(f)}
          onRemove={vm.removeFile}
        />
        <p className="text-caption text-sub">
          첫 줄: {CSV_HEADER.join(',')} (상세주소 열은 빼도 됨) · 주소 4칸 필수 · 대표자는 Y 또는
          빈칸(빈칸이어도 기존 대표자는 그대로) · 부서 빈칸 = 부서 없음 · 없는 부서는 새로 만듦 ·
          이미 있는 사번은 파일 내용으로 바뀝니다.
        </p>

        {vm.comparing && <p className="text-label text-sub">지금 등록된 사원과 비교하는 중…</p>}
        {vm.loadError && (
          <p role="alert" className="text-label text-danger">
            {vm.loadError}
          </p>
        )}
        {vm.preview && (
          <section aria-label="미리 보기" className="flex flex-col gap-2 rounded-lg bg-bg p-4">
            <p className="text-label font-semibold">{vm.preview.summary}</p>
            {vm.preview.changes.length > 0 && (
              <>
                <p className="text-caption text-sub">바뀌는 사원</p>
                <ul className="flex flex-col gap-1 text-label">
                  {vm.preview.changes.map((c) => (
                    <li key={c.key} className="tabular-nums">
                      {c.text}
                    </li>
                  ))}
                  {vm.preview.moreChanges > 0 && (
                    <li className="text-sub">외 {vm.preview.moreChanges}명</li>
                  )}
                </ul>
              </>
            )}
          </section>
        )}
      </div>
    </Dialog>
  )
}
