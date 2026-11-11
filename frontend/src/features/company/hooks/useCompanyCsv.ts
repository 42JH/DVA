import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { ApiError } from '@/shared/api/client'
import {
  companyQueries,
  createCompany,
  saveMemberAddresses,
} from '@/features/company/api/companyApi'
import {
  groupByCompany,
  readMembersFile,
  serverRowErrors,
  type CsvMember,
} from '@/features/company/csvMembers'
import { errorText } from '@/features/company/labels'

/** 파일 상태 — 아직 없음 / 읽음(사원 목록) / 틀림(처음 3줄 + 나머지 건수) */
type Picked =
  | { kind: 'none' }
  | { kind: 'ok'; file: File; members: CsvMember[] }
  | { kind: 'bad'; file: File; errors: string[]; more: number }

/** 기업 하나 등록 결과 */
interface Result {
  name: string
  ok: boolean
  message: string | null // 실패 이유 · 주소 저장 실패 안내
}

/** 08 CSV로 기업 등록 훅 (11/11) — 파일 첫 칸이 기업명, 한 파일에 여러 기업
 * 기업마다 POST /companies 한 번(기업 · 부서 · 사원이 한 트랜잭션) → 기업 사이는 따로라 일부만 될 수 있음 → 기업별 결과를 보여 줌
 * 주소는 아직 등록 API에 칸이 없어 등록 뒤 사원마다 저장(saveMemberAddresses, shortcut) */
export function useCompanyCsv(onDone: () => void) {
  const qc = useQueryClient()
  const [picked, setPicked] = useState<Picked>({ kind: 'none' })

  const pick = async (file: File) => {
    const r = await readMembersFile(file, 'companies')
    setPicked(r.ok ? { kind: 'ok', file, members: r.members } : { kind: 'bad', file, ...r })
    reg.reset()
  }

  const groups = picked.kind === 'ok' ? groupByCompany(picked.members) : []

  const reg = useMutation({
    // 한 기업이 실패해도 다음 기업은 계속 — 같은 파일을 다시 올리면 된 기업이 또 생기므로 결과를 남겨 둠
    mutationFn: async (): Promise<Result[]> => {
      const out: Result[] = []
      for (const g of groups) {
        try {
          const departments = [
            ...new Set(g.members.flatMap((m) => (m.department ? [m.department] : []))),
          ]
          const id = await createCompany(
            g.name,
            departments,
            g.members.map((m) => ({
              employeeNo: m.employeeNo,
              name: m.name,
              phoneNumber: m.phoneNumber,
              ...(m.leader ? { role: 'ORG_ADMIN' as const } : {}),
              ...(m.department ? { departmentName: m.department } : {}),
            })),
          )
          const failed = await saveMemberAddresses(
            id,
            g.members.map((m) => ({ employeeNo: m.employeeNo, address: m.address })),
          )
          out.push({
            name: g.name,
            ok: true,
            message: failed.length
              ? `${failed.length}명의 주소를 저장하지 못했습니다. 기업 상세의 [수정]에서 넣어 주세요.`
              : null,
          })
        } catch (e) {
          // 서버 오류 경로 members.N → 파일의 행
          const rows = e instanceof ApiError ? serverRowErrors(e.details, g.members) : []
          out.push({ name: g.name, ok: false, message: rows[0] ?? errorText(e, '등록') })
        }
      }
      return out
    },
    onSettled: () => qc.invalidateQueries({ queryKey: companyQueries.all() }),
    onSuccess: (results) => {
      if (results.every((r) => r.ok && !r.message)) onDone() // 하나라도 문제가 있으면 창에 결과를 남김
    },
  })

  return {
    file: picked.kind === 'none' ? null : picked.file,
    fileError:
      picked.kind === 'bad'
        ? [...picked.errors, ...(picked.more ? [`외 ${picked.more}건`] : [])].join('\n')
        : undefined,
    companies: groups.length, // '기업 2곳'
    count: picked.kind === 'ok' ? picked.members.length : 0, // '사원 24명'
    members: picked.kind === 'ok' ? picked.members : [], // 읽은 사원 — 등록 전에 표로 보여 줌
    results: reg.data ?? null,
    pick,
    removeFile: () => {
      setPicked({ kind: 'none' })
      reg.reset()
    },
    canSubmit: picked.kind === 'ok' && !reg.isPending && !reg.data,
    isSubmitting: reg.isPending,
    submit: () => picked.kind === 'ok' && reg.mutate(),
  }
}
