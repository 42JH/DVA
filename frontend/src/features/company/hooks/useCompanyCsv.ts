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

/** 08 CSV로 기업 등록 훅 (11/11) — 파일 첫 칸이 기업명, 한 파일 = 한 기업(검사는 csvMembers)
 * POST /companies 한 번(기업 · 부서 · 사원이 한 트랜잭션이라 전부 되거나 전부 안 됨)
 * 주소는 아직 등록 API에 칸이 없어 등록 뒤 사원마다 저장(saveMemberAddresses, shortcut) */
export function useCompanyCsv(onDone: () => void) {
  const qc = useQueryClient()
  const [picked, setPicked] = useState<Picked>({ kind: 'none' })

  const pick = async (file: File) => {
    const r = await readMembersFile(file, 'companies')
    setPicked(r.ok ? { kind: 'ok', file, members: r.members } : { kind: 'bad', file, ...r })
    reg.reset()
  }

  const members = picked.kind === 'ok' ? picked.members : []
  const companyName = members[0]?.company ?? ''
  const departments = [...new Set(members.flatMap((m) => (m.department ? [m.department] : [])))]

  const reg = useMutation({
    mutationFn: async () => {
      const id = await createCompany(
        companyName,
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
  // 서버 오류 경로는 members.N.field (등록 본문의 사원 배열) → 파일의 행
  const rowErrors = err instanceof ApiError ? serverRowErrors(err.details, members) : []

  // 파일 칸 아래 — 파일을 못 읽었으면 그 이유, 서버가 줄을 거절했으면 그 줄 (3줄까지)
  const fileErrorOf = () => {
    if (picked.kind === 'bad')
      return [...picked.errors, ...(picked.more ? [`외 ${picked.more}건`] : [])].join('\n')
    return rowErrors.length ? rowErrors.slice(0, 3).join('\n') : undefined
  }
  // 버튼 줄 — 줄 오류는 파일 칸 아래에 보이므로 여기엔 없음. 등록은 됐는데 주소만 실패했으면 안내
  const failText = () => {
    if (err) return rowErrors.length ? null : errorText(err, '등록')
    return reg.data
      ? `기업과 사원은 등록했지만 ${reg.data}명의 주소를 저장하지 못했습니다. 기업 상세의 [수정]에서 넣어 주세요.`
      : null
  }

  return {
    file: picked.kind === 'none' ? null : picked.file,
    fileError: fileErrorOf(),
    // '샘플상사, 부서 2곳, 사원 4명을 등록합니다.'
    summary: members.length
      ? [
          companyName,
          ...(departments.length ? [`부서 ${departments.length}곳`] : []),
          `사원 ${members.length}명을 등록합니다.`,
        ].join(', ')
      : null,
    members, // 읽은 사원 — 등록 전에 표로 보여 줌
    pick,
    removeFile: () => {
      setPicked({ kind: 'none' })
      reg.reset()
    },
    errorMessage: failText(),
    canSubmit: picked.kind === 'ok' && !reg.isPending && !reg.data,
    isSubmitting: reg.isPending,
    submit: () => picked.kind === 'ok' && reg.mutate(),
  }
}
