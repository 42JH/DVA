import { Button, FileDrop, FormModal } from '@/shared/ui'
import { CSV_HEADER } from '@/features/company/csvMembers'
import { useMemberCsv } from '@/features/company/hooks/useMemberCsv'

// 08 CSV로 사원 추가 창 (기존 기업) — 파일 → 미리 보기('신규 · 정보 바뀜 · 변경 없음') + 바뀌는 사람 → [취소] [등록]
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
    <FormModal
      title="CSV로 사원 추가"
      description={companyName}
      onClose={onClose}
      footer={
        <>
          {vm.errorMessage && (
            <p role="alert" className="mr-auto text-label text-danger">
              {vm.errorMessage}
            </p>
          )}
          <Button onClick={onClose}>취소</Button>
          <Button kind="primary" disabled={!vm.canSubmit} onClick={vm.submit}>
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
          첫 줄: {CSV_HEADER.join(',')} · 대표자는 Y 또는 빈칸(빈칸이어도 기존 대표자는 그대로) ·
          이미 있는 사번은 이름 · 전화번호가 파일 내용으로 바뀝니다.
        </p>

        {vm.comparing && <p className="text-label text-sub">지금 등록된 사원과 비교하는 중…</p>}
        {vm.preview && (
          <section aria-label="미리 보기" className="flex flex-col gap-2 rounded-lg bg-bg p-4">
            <p className="text-label font-semibold">{vm.preview.summary}</p>
            {vm.preview.changes.length > 0 && (
              <>
                <p className="text-caption text-sub">정보가 바뀌는 사원</p>
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
    </FormModal>
  )
}
