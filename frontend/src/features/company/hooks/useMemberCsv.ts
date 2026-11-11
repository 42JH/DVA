import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { ApiError } from '@/shared/api/client'
import { fmtPhone } from '@/shared/lib/format'
import {
  addMembers,
  companyQueries,
  createDepartment,
  saveMemberAddresses,
} from '@/features/company/api/companyApi'
import {
  previewAgainst,
  readMembersFile,
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
 * 같은 사번은 서버가 덮어씀 → '신규 · 바뀜 · 변경 없음'을 먼저 보여 줌 (11/01 결정 B). 변경 없는 줄은 보내지 않음
 * 등록 (11/01): 없는 부서 만들기 → 사원 등록 한 번(담당자 role · departmentSeq 포함) → 주소가 새로 · 바뀐 사원만 주소 저장 */
export function useMemberCsv(companyId: number, onDone: () => void) {
  const qc = useQueryClient()
  const [picked, setPicked] = useState<Picked>({ kind: 'none' })
  const all = useQuery(companyQueries.allMembers(companyId)) // 비교 기준 = 지금 등록된 전체 사원
  const deps = useQuery(companyQueries.departments(companyId)) // 부서 이름 ↔ 번호
  const deptNames = new Map(deps.data?.map((d) => [d.departmentSeq, d.name]))

  const pv: CsvPreview | null =
    picked.kind === 'ok' && all.data && deps.data
      ? previewAgainst(picked.rows, all.data, deptNames)
      : null
  const toSend = pv ? [...pv.added, ...pv.changed.map((c) => c.row)] : []

  const reg = useMutation({
    mutationFn: async (p: CsvPreview) => {
      // 1) 없는 부서 이름 → 새 부서 (11/01 결정). 사원 등록과 묶이지 않아, 여기서 실패하면 앞에서 만든 부서는 남음
      const seqOf = new Map(deps.data?.map((d) => [d.name, d.departmentSeq]))
      for (const name of new Set(toSend.flatMap((r) => (r.department ? [r.department] : []))))
        if (!seqOf.has(name)) seqOf.set(name, await createDepartment(companyId, name))
      // 2) 사원 한 번에 — 담당자 빈칸은 role을 빼서 기존 역할 유지, 부서 빈칸은 null = 부서 없음
      await addMembers(
        companyId,
        toSend.map((r) => ({
          employeeNo: r.employeeNo,
          name: r.name,
          phoneNumber: r.phoneNumber,
          ...(r.leader ? { role: 'ORG_ADMIN' as const } : {}),
          departmentSeq: r.department ? seqOf.get(r.department)! : null,
        })),
      )
      // 3) 주소 — 신규 + 주소가 바뀐 사원만 (그대로인 실제 좌표를 1로 덮지 않게)
      const failed = await saveMemberAddresses(
        companyId,
        [...p.added, ...p.changed.filter((c) => c.fields.includes('주소')).map((c) => c.row)].map(
          (r) => ({ employeeNo: r.employeeNo, address: r.address }),
        ),
      )
      return failed.length
    },
    onSettled: () => qc.invalidateQueries({ queryKey: companyQueries.all() }),
    onSuccess: (failed) => {
      if (failed === 0) onDone()
    },
  })

  const pick = async (file: File) => {
    const r = await readMembersFile(file)
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
    comparing: picked.kind === 'ok' && (all.isPending || deps.isPending), // 기존 사원 · 부서를 받는 중
    // 비교 기준을 못 받으면 미리 보기가 안 나옴 → 이유를 알림 (창을 다시 열면 다시 받음)
    loadError:
      picked.kind === 'ok' && (all.error ?? deps.error)
        ? '지금 등록된 사원 · 부서를 불러오지 못해 비교할 수 없습니다. 창을 닫고 다시 열어 주세요.'
        : null,
    // 읽은 사원 + 구분 — 등록 전에 표로 보여 줌 (오류가 있으면 안 보임)
    rows:
      pv && pv.errors.length === 0
        ? [
            ...pv.added.map((r) => ({ ...r, mark: '신규' })),
            ...pv.changed.map((c) => ({ ...c.row, mark: '바뀜' })),
            ...pv.same.map((r) => ({ ...r, mark: '그대로' })),
          ].sort((a, b) => a.line - b.line)
        : [],
    // 미리 보기 — 오류가 있으면 안 보임(먼저 고쳐야 함)
    preview:
      pv && pv.errors.length === 0
        ? {
            summary: [
              `신규 ${pv.added.length}명`,
              `바뀜 ${pv.changed.length}명`,
              `변경 없음 ${pv.same.length}명`,
              ...(pv.leaders.length ? [`담당자 지정 ${pv.leaders.length}명`] : []),
            ].join(' · '),
            changes: pv.changed.slice(0, SHOW_CHANGES).map((c) => ({
              key: c.row.employeeNo,
              text: [
                c.row.employeeNo,
                c.fields.includes('사원명') ? `${c.before.name} → ${c.row.name}` : c.row.name,
                c.fields.includes('전화번호') &&
                  `${fmtPhone(c.before.phoneNumber)} → ${fmtPhone(c.row.phoneNumber)}`,
                c.fields.includes('담당자') && '담당자 지정',
                c.fields.includes('부서') &&
                  `부서 ${c.before.department ?? '없음'} → ${c.row.department ?? '없음'}`,
                c.fields.includes('주소') &&
                  (c.before.roadAddress === c.row.address.roadAddress
                    ? '상세주소 변경'
                    : `주소 → ${c.row.address.roadAddress}`),
              ]
                .filter(Boolean)
                .join(' · '),
            })),
            moreChanges: Math.max(0, pv.changed.length - SHOW_CHANGES),
          }
        : null,
    errorMessage: !err
      ? reg.data
        ? `사원은 등록했지만 ${reg.data}명의 주소를 저장하지 못했습니다. [수정]에서 넣어 주세요.`
        : null
      : rowErrors.length
        ? null // 줄 오류는 파일 칸 아래에
        : errorText(err, '등록'),
    // 할 일이 하나도 없으면(전부 변경 없음) [등록] 꺼짐
    canSubmit: !!pv && pv.errors.length === 0 && toSend.length > 0 && !reg.isPending && !reg.data,
    isSubmitting: reg.isPending,
    submit: () => pv && reg.mutate(pv),
  }
}
