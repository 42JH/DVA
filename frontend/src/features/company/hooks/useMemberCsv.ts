import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { ApiError } from '@/shared/api/client'
import { fmtPhone } from '@/shared/lib/format'
import { addMembers, assignLeaders, companyQueries } from '@/features/company/api/companyApi'
import {
  decodeCsv,
  previewAgainst,
  readMembersCsv,
  serverRowErrors,
  type CsvMember,
  type CsvPreview,
} from '@/features/company/csvMembers'
import { errorText } from '@/features/company/labels'

const SHOW_CHANGES = 5 // 바뀌는 사람은 처음 5명까지, 나머지는 '외 n명'

type Picked =
  | { kind: 'none' }
  | { kind: 'ok'; file: File; rows: CsvMember[] }
  | { kind: 'bad'; file: File; errors: string[]; more: number }

/** 08 CSV로 사원 추가 훅 (기존 기업) — 파일 → 검사 → 기존 사원과 비교한 미리 보기 → [등록]
 * 같은 사번은 서버가 덮어씀 → '신규 · 바뀜 · 변경 없음'을 먼저 보여 줌 (11/01 결정 B). 변경 없는 줄은 보내지 않음 */
export function useMemberCsv(companyId: number, onDone: () => void) {
  const qc = useQueryClient()
  const [picked, setPicked] = useState<Picked>({ kind: 'none' })
  const all = useQuery(companyQueries.allMembers(companyId)) // 비교 기준 = 지금 등록된 전체 사원

  const pv: CsvPreview | null =
    picked.kind === 'ok' && all.data ? previewAgainst(picked.rows, all.data) : null
  const toSend = pv ? [...pv.added, ...pv.changed.map((c) => c.row)] : []

  const reg = useMutation({
    mutationFn: async (p: CsvPreview) => {
      if (toSend.length)
        await addMembers(
          companyId,
          toSend.map(({ employeeNo, name, phoneNumber }) => ({ employeeNo, name, phoneNumber })),
        )
      return assignLeaders(companyId, p.leaders) // 실패 수
    },
    onSettled: () => qc.invalidateQueries({ queryKey: companyQueries.all() }),
    onSuccess: (failed) => {
      if (failed === 0) onDone()
    },
  })

  const pick = async (file: File) => {
    const r = readMembersCsv(decodeCsv(await file.arrayBuffer()))
    setPicked(r.ok ? { kind: 'ok', file, rows: r.members } : { kind: 'bad', file, ...r })
    reg.reset()
  }

  const err = reg.error
  const rowErrors = err instanceof ApiError ? serverRowErrors(err.details, toSend) : []
  const fileErrors =
    picked.kind === 'bad'
      ? [...picked.errors, ...(picked.more ? [`외 ${picked.more}건`] : [])]
      : pv?.errors.length
        ? [
            ...pv.errors.slice(0, 3),
            ...(pv.errors.length > 3 ? [`외 ${pv.errors.length - 3}건`] : []),
          ]
        : rowErrors.slice(0, 3)

  return {
    file: picked.kind === 'none' ? null : picked.file,
    fileError: fileErrors.length ? fileErrors.join('\n') : undefined,
    pick,
    removeFile: () => {
      setPicked({ kind: 'none' })
      reg.reset()
    },
    comparing: picked.kind === 'ok' && all.isPending, // 기존 사원을 받는 중
    // 미리 보기 — 오류가 있으면 안 보임(먼저 고쳐야 함)
    preview:
      pv && pv.errors.length === 0
        ? {
            summary: [
              `신규 ${pv.added.length}명`,
              `정보 바뀜 ${pv.changed.length}명`,
              `변경 없음 ${pv.same.length}명`,
              ...(pv.leaders.length ? [`대표자 지정 ${pv.leaders.length}명`] : []),
            ].join(' · '),
            changes: pv.changed.slice(0, SHOW_CHANGES).map((c) => ({
              key: c.row.employeeNo,
              text: [
                c.row.employeeNo,
                c.before.name === c.row.name ? c.row.name : `${c.before.name} → ${c.row.name}`,
                c.before.phoneNumber === c.row.phoneNumber
                  ? null
                  : `${fmtPhone(c.before.phoneNumber)} → ${fmtPhone(c.row.phoneNumber)}`,
              ]
                .filter(Boolean)
                .join(' · '),
            })),
            moreChanges: Math.max(0, pv.changed.length - SHOW_CHANGES),
          }
        : null,
    errorMessage: !err
      ? reg.data
        ? `사원은 등록했지만 대표자 ${reg.data}명 지정에 실패했습니다. [수정]에서 다시 지정해 주세요.`
        : null
      : rowErrors.length
        ? null // 줄 오류는 파일 칸 아래에
        : errorText(err, '등록'),
    // 할 일이 하나도 없으면(전부 변경 없음) [등록] 꺼짐
    canSubmit:
      !!pv &&
      pv.errors.length === 0 &&
      (toSend.length > 0 || pv.leaders.length > 0) &&
      !reg.isPending &&
      !reg.data,
    isSubmitting: reg.isPending,
    submit: () => pv && reg.mutate(pv),
  }
}
