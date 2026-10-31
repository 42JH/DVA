import { Button, FileDrop, FormModal, TextField } from '@/shared/ui'
import { CSV_HEADER } from '@/features/company/csvMembers'
import { useCompanyCsv } from '@/features/company/hooks/useCompanyCsv'

// 08 CSV로 기업 등록 창 (Figma 08_기업관리_CSV기업등록 · CSV오류, 11/01) — 기업명 + CSV 파일 → [취소] [등록]
// 파일을 고르자마자 검사해 칸 아래 빨간 오류(처음 3줄). 엑셀 CSV(EUC-KR)도 자동으로 읽음
export function CompanyCsvModal({ onClose }: { onClose: () => void }) {
  const vm = useCompanyCsv(onClose)

  return (
    <FormModal
      title="CSV로 기업 등록"
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
      <div className="flex flex-col gap-5">
        <TextField
          label="기업명"
          inline
          placeholder="기업명"
          value={vm.name}
          onChange={(e) => vm.setName(e.target.value)}
        />
        <div className="flex flex-col gap-2">
          <FileDrop
            file={vm.file}
            accept=".csv"
            error={vm.fileError}
            onPick={(f) => void vm.pick(f)}
            onRemove={vm.removeFile}
          />
          {/* 파일 모양 안내 — 엑셀이 사번 앞 0을 지우는 일이 많아 함께 알림 */}
          <p className="text-caption text-sub">
            첫 줄: {CSV_HEADER.join(',')} · 대표자는 Y 또는 빈칸(여러 명 가능) · 사번 칸은 텍스트로
            저장해야 앞자리 0이 남습니다.
            {vm.count > 0 && ` · 사원 ${vm.count}명`}
          </p>
        </div>
      </div>
    </FormModal>
  )
}
