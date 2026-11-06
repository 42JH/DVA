import { Button, FileDrop, Dialog, TextField } from '@/shared/ui'
import { CSV_HEADER, downloadExample } from '@/features/company/csvMembers'
import { useCompanyCsv } from '@/features/company/hooks/useCompanyCsv'

// 08 CSV로 기업 등록 창 (Figma 08_기업관리_CSV기업등록 · CSV오류, 11/01) — 기업명 + CSV 파일 → [취소] [등록]
// 파일을 고르자마자 검사해 칸 아래 빨간 오류(처음 3줄). 엑셀 CSV(EUC-KR)도 자동으로 읽음
export function CompanyCsvModal({ onClose }: { onClose: () => void }) {
  const vm = useCompanyCsv(onClose)

  return (
    <Dialog
      label="엑셀로 기업 등록"
      width={600}
      title="엑셀로 기업 등록"
      onClose={onClose}
      footer={
        <>
          <Button big onClick={downloadExample}>
            예시 엑셀 내려받기
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
            accept=".xlsx,.csv"
            error={vm.fileError}
            onPick={(f) => void vm.pick(f)}
            onRemove={vm.removeFile}
          />
          {/* 파일 모양 안내 — 엑셀이 사번 앞 0을 지우는 일이 많아 함께 알림 */}
          <p className="text-caption text-sub">
            엑셀(.xlsx) 또는 CSV · 첫 줄: {CSV_HEADER.join(',')} (상세주소 열은 빼도 됨) · 주소는
            도로명 · 지번 · 동 · 우편번호 모두 필수 · 대표자(Y) · 부서 · 상세주소는 빈칸 가능 · 없는
            부서는 새로 만듦 · 전화번호는 010-1234-5678처럼 하이픈을 넣으면 엑셀이 앞자리 0을 지우지
            않습니다 · CSV를 엑셀로 다시 열면 사번 · 전화번호 · 우편번호 앞 0이 지워지니, 예시
            엑셀(.xlsx)에 채워 그대로 올려 주세요(사번 · 전화번호 · 우편번호 칸이 텍스트 형식).
            {vm.count > 0 && ` · 사원 ${vm.count}명`}
          </p>
        </div>
      </div>
    </Dialog>
  )
}
