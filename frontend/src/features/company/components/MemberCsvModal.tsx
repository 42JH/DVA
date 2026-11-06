import { Button, FileDrop, Dialog } from '@/shared/ui'
import { CSV_HEADER, downloadExample } from '@/features/company/csvMembers'
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
          <Button big onClick={downloadExample}>
            예시 CSV 내려받기
          </Button>
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
          accept=".xlsx,.csv"
          error={vm.fileError}
          onPick={(f) => void vm.pick(f)}
          onRemove={vm.removeFile}
        />
        <p className="text-caption text-sub">
          엑셀(.xlsx) 또는 CSV · 첫 줄: {CSV_HEADER.join(',')} (상세주소 열은 빼도 됨) · 주소 4칸
          필수 · 대표자는 Y 또는 빈칸(빈칸이어도 기존 대표자는 그대로) · 부서 빈칸 = 부서 없음 ·
          없는 부서는 새로 만듦 · 이미 있는 사번은 파일 내용으로 바뀝니다 · 전화번호는 010-1234-5678
          형식 · 예시 CSV는 엑셀로 열어도 사번 · 우편번호 앞 0이 남습니다 · 엑셀에서 새로 적는
          사번이 0으로 시작하면 앞에 '를 붙여 주세요(예: '004).
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
