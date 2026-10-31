// 08 사원 CSV → 등록 항목 (CSV로 기업 등록 · CSV로 사원 추가 공용). React를 모르는 순수 함수 — csvMembers.test.ts
// 모양 (11/01 결정): 사번,사원명,전화번호,대표자   — 대표자 열은 없어도 됨, 'Y'면 대표자(여러 명 가능)
// 서버에 파일을 보내지 않고 JSON으로 바꿔 보냄 (명세 7장: CSV API 없음). 행 번호는 머리줄 = 1행
import { parseCsv } from '@/shared/lib/csv'
import type { MemberInput } from '@/features/company/api/companyApi'

export const CSV_HEADER = ['사번', '사원명', '전화번호', '대표자'] as const
export const MAX_MEMBERS = 1000 // 명세: 한 번에 1~1000건
const SHOW_ERRORS = 3 // 오류는 처음 3줄까지 (11/01 결정), 나머지는 '외 n건'

/** 파일 바이트 → 글자. UTF-8로 읽어 보고 깨지면(잘못된 바이트) EUC-KR로 (11/01 결정 A)
 * 엑셀 '다른 이름으로 저장 → CSV'의 기본이 EUC-KR(한국어 Windows)이라 그대로 읽으면 한글이 깨짐. 브라우저 기본 TextDecoder만 씀 */
export function decodeCsv(bytes: ArrayBuffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes) // fatal: 잘못된 바이트면 '�' 대신 오류
  } catch {
    return new TextDecoder('euc-kr').decode(bytes)
  }
}

export interface CsvMember extends MemberInput {
  leader: boolean // 대표자 Y → 등록 후 PATCH role=ORG_ADMIN
  line: number // 파일의 행 번호 (오류 안내용)
}

export type CsvResult =
  { ok: true; members: CsvMember[] } | { ok: false; errors: string[]; more: number } // errors = 처음 3줄, more = 나머지 건수

// 칸 이름 + 목적격 조사 ('사번을' · '전화번호를') — 서버 오류 안내용
const FIELD: Record<keyof MemberInput, string> = {
  employeeNo: '사번을',
  name: '사원명을',
  phoneNumber: '전화번호를',
}

const fail = (all: string[]): CsvResult => ({
  ok: false,
  errors: all.slice(0, SHOW_ERRORS),
  more: Math.max(0, all.length - SHOW_ERRORS),
})

export function readMembersCsv(text: string): CsvResult {
  const [head, ...body] = parseCsv(text).map((r) => r.map((v) => v.trim()))
  const headOk =
    head !== undefined &&
    CSV_HEADER.slice(0, 3).every((h, i) => head[i] === h) &&
    (head.length < 4 || head[3] === CSV_HEADER[3] || head.slice(3).every((v) => v === ''))
  if (!headOk) return fail([`첫 줄은 '${CSV_HEADER.join(',')}'여야 합니다.`])
  if (body.length === 0) return fail(['사원이 한 명도 없습니다.'])
  if (body.length > MAX_MEMBERS)
    return fail([`한 번에 ${MAX_MEMBERS}명까지 등록할 수 있습니다. (지금 ${body.length}명)`])

  const errors: string[] = []
  const members: CsvMember[] = []
  const seenNo = new Map<string, number>()
  const seenPhone = new Map<string, number>()
  body.forEach(([no = '', name = '', phone = '', leader = ''], i) => {
    const line = i + 2 // 머리줄 다음부터
    const digits = phone.replace(/[-\s]/g, '')
    if (!no) return errors.push(`${line}행 사번이 비어 있습니다.`)
    if (!name) return errors.push(`${line}행 사원명이 비어 있습니다.`)
    if (!/^0\d{9,10}$/.test(digits)) return errors.push(`${line}행 전화번호 형식이 맞지 않습니다.`)
    if (leader !== '' && leader.toUpperCase() !== 'Y')
      return errors.push(`${line}행 대표자는 Y 또는 빈칸이어야 합니다.`)
    // 명세: 요청 안의 사번 · 전화 중복은 보내기 전에 정리 → 겹치면 어느 줄인지 알려 줌
    if (seenNo.has(no)) return errors.push(`${line}행 사번이 ${seenNo.get(no)}행과 겹칩니다.`)
    if (seenPhone.has(digits))
      return errors.push(`${line}행 전화번호가 ${seenPhone.get(digits)}행과 겹칩니다.`)
    seenNo.set(no, line)
    seenPhone.set(digits, line)
    members.push({ employeeNo: no, name, phoneNumber: digits, leader: leader !== '', line })
  })
  return errors.length ? fail(errors) : { ok: true, members }
}

/** 서버 오류의 항목 경로(items.3.phoneNumber) → '5행 전화번호를 확인해 주세요.' — 경로 형식은 backend-todo 10에서 확인 중 */
export function serverRowErrors(
  details: { field: string; reason: string }[],
  members: CsvMember[],
): string[] {
  return details.flatMap((d) => {
    const m = /^items\.(\d+)(?:\.(\w+))?/.exec(d.field)
    const row = m ? members[Number(m[1])] : undefined
    if (!row) return []
    const field = FIELD[m![2] as keyof MemberInput]
    return [`${row.line}행 ${field ?? '내용을'} 확인해 주세요.`]
  })
}
