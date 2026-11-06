import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { ApiError } from '@/shared/api/client'
import {
  companyQueries,
  createCompany,
  saveMemberAddresses,
} from '@/features/company/api/companyApi'
import { readMembersFile, serverRowErrors, type CsvMember } from '@/features/company/csvMembers'
import { errorText } from '@/features/company/labels'

/** 파일 상태 — 아직 없음 / 읽음(사원 목록) / 틀림(처음 3줄 + 나머지 건수) */
type Picked =
  | { kind: 'none' }
  | { kind: 'ok'; file: File; members: CsvMember[] }
  | { kind: 'bad'; file: File; errors: string[]; more: number }

/** 08 CSV로 기업 등록 훅 — 기업명 + 파일 → 기업 · 부서 · 사원(대표자 · 부서 포함)을 요청 한 번으로 (11/01 백엔드 확장)
 * 하나의 트랜잭션이라 전부 되거나 전부 안 됨 → 예전의 '기업은 만들었지만…' · 대표자 따로 지정이 없어짐
 * 주소만 아직 등록 API에 칸이 없어 등록 뒤 사원마다 저장(saveMemberAddresses, shortcut) */
export function useCompanyCsv(onDone: () => void) {
  const qc = useQueryClient()
  const [name, setName] = useState('')
  const [picked, setPicked] = useState<Picked>({ kind: 'none' })

  const pick = async (file: File) => {
    const r = await readMembersFile(file)
    setPicked(r.ok ? { kind: 'ok', file, members: r.members } : { kind: 'bad', file, ...r })
    reg.reset()
  }

  const reg = useMutation({
    mutationFn: async (members: CsvMember[]) => {
      const departments = [...new Set(members.flatMap((m) => (m.department ? [m.department] : [])))]
      const id = await createCompany(
        name.trim(),
        departments,
        members.map((m) => ({
          employeeNo: m.employeeNo,
          name: m.name,
          phoneNumber: m.phoneNumber,
          ...(m.leader ? { role: 'ORG_ADMIN' as const } : {}),
          ...(m.department ? { departmentName: m.department } : {}),
        })),
      )
      // 주소는 등록이 끝난 뒤 — 못 저장한 사번 수를 돌려줌
      const failed = await saveMemberAddresses(
        id,
        members.map((m) => ({ employeeNo: m.employeeNo, address: m.address })),
      )
      return failed.length
    },
    onSettled: () => qc.invalidateQueries({ queryKey: companyQueries.all() }),
    onSuccess: (failedAddresses) => {
      if (failedAddresses === 0) onDone() // 주소 저장 실패만 창에 안내를 남김
    },
  })

  const err = reg.error
  // 서버 오류 경로는 members.N.field (등록 본문의 사원 배열) → 파일의 행으로
  const rowErrors =
    err instanceof ApiError && picked.kind === 'ok'
      ? serverRowErrors(err.details, picked.members)
      : []

  return {
    name,
    setName,
    file: picked.kind === 'none' ? null : picked.file,
    fileError:
      picked.kind === 'bad'
        ? [...picked.errors, ...(picked.more ? [`외 ${picked.more}건`] : [])].join('\n')
        : rowErrors.length
          ? rowErrors.slice(0, 3).join('\n')
          : undefined,
    count: picked.kind === 'ok' ? picked.members.length : 0, // '사원 24명'
    pick,
    removeFile: () => {
      setPicked({ kind: 'none' })
      reg.reset()
    },
    errorMessage: err
      ? rowErrors.length
        ? null // 줄 오류는 파일 칸 아래에
        : errorText(err, '등록')
      : reg.data
        ? `기업과 사원은 등록했지만 ${reg.data}명의 주소를 저장하지 못했습니다. 기업 상세의 [수정]에서 넣어 주세요.`
        : null,
    canSubmit: name.trim() !== '' && picked.kind === 'ok' && !reg.isPending && !reg.data,
    isSubmitting: reg.isPending,
    submit: () => picked.kind === 'ok' && reg.mutate(picked.members),
  }
}
