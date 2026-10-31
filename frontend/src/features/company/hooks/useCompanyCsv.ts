import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { ApiError } from '@/shared/api/client'
import {
  addMembers,
  companyQueries,
  createCompany,
  fetchAllMembers,
  setMemberRole,
} from '@/features/company/api/companyApi'
import {
  decodeCsv,
  readMembersCsv,
  serverRowErrors,
  type CsvMember,
} from '@/features/company/csvMembers'

/** 파일 상태 — 아직 없음 / 읽음(사원 목록) / 틀림(처음 3줄 + 나머지 건수) */
type Picked =
  | { kind: 'none' }
  | { kind: 'ok'; file: File; members: CsvMember[] }
  | { kind: 'bad'; file: File; errors: string[]; more: number }

/** 08 CSV로 기업 등록 훅 — 기업명 + 파일 → ① 기업 만들기 → ② 사원 등록 → ③ 대표자 지정
 * 서버엔 CSV API가 없어 브라우저에서 읽어 JSON으로 (명세 7장). ①②③은 묶인 요청이 아님 → 어디서 멈췄는지 안내 */
export function useCompanyCsv(onDone: () => void) {
  const qc = useQueryClient()
  const [name, setName] = useState('')
  const [picked, setPicked] = useState<Picked>({ kind: 'none' })
  // ①이 성공하고 ②에서 실패했을 때 다시 [등록]을 누르면 기업을 또 만들지 않게 기억
  const [createdId, setCreatedId] = useState<number | null>(null)

  const pick = async (file: File) => {
    const r = readMembersCsv(decodeCsv(await file.arrayBuffer()))
    setPicked(r.ok ? { kind: 'ok', file, members: r.members } : { kind: 'bad', file, ...r })
    reg.reset()
  }

  const reg = useMutation({
    mutationFn: async (members: CsvMember[]) => {
      const id = createdId ?? (await createCompany(name.trim())) // ①
      setCreatedId(id)
      await addMembers(
        id,
        members.map(({ employeeNo, name, phoneNumber }) => ({ employeeNo, name, phoneNumber })),
      ) // ② 전체 트랜잭션: 한 줄이라도 틀리면 전부 안 들어감
      // ③ 등록 응답엔 번호가 없어 전체 사원을 다시 받아 사번으로 찾음 (backend-todo 10: role을 등록에 실어 주면 없어짐)
      const leaders = members.filter((m) => m.leader).map((m) => m.employeeNo)
      if (leaders.length === 0) return 0
      const byNo = new Map((await fetchAllMembers(id)).map((m) => [m.membership.employeeNo, m]))
      let failed = 0
      for (const no of leaders) {
        const seq = byNo.get(no)?.membership.membershipSeq
        if (seq === undefined) failed++
        else await setMemberRole(seq, 'ORG_ADMIN').catch(() => failed++)
      }
      return failed
    },
    onSettled: () => qc.invalidateQueries({ queryKey: companyQueries.all() }), // 실패해도 ①은 됐을 수 있음
    onSuccess: (failedLeaders) => {
      if (failedLeaders === 0) onDone() // 다 됐으면 창 닫기, 대표자 지정 실패는 창에 안내를 남김
    },
  })

  const err = reg.error
  const rowErrors =
    err instanceof ApiError && picked.kind === 'ok'
      ? serverRowErrors(err.details, picked.members)
      : []
  const errorMessage = !err
    ? reg.data
      ? `사원은 등록했지만 대표자 ${reg.data}명 지정에 실패했습니다. 기업 상세에서 다시 지정해 주세요.`
      : null
    : err instanceof ApiError && err.code === 'REQUEST_IN_PROGRESS'
      ? '다른 등록을 처리하는 중이에요. 잠시 뒤 다시 [등록]을 눌러 주세요.'
      : createdId !== null
        ? `기업은 만들었지만 사원을 등록하지 못했습니다. ${rowErrors[0] ?? err.message}`
        : err.message

  return {
    name,
    setName: (v: string) => {
      setName(v)
      if (createdId !== null) setCreatedId(null) // 이름을 바꾸면 새 기업으로 (앞서 만든 빈 기업은 목록에서 지울 수 있음)
    },
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
    errorMessage,
    canSubmit: name.trim() !== '' && picked.kind === 'ok' && !reg.isPending && !reg.data,
    isSubmitting: reg.isPending,
    submit: () => picked.kind === 'ok' && reg.mutate(picked.members),
  }
}
