// 08 사원 CSV → 등록 항목 (CSV로 기업 등록 · CSV로 사원 추가 공용). React를 모르는 순수 함수 — csvMembers.test.ts
// 모양 (11/01 결정): 사번,사원명,전화번호,대표자,부서,도로명 주소,지번 주소,동,우편번호,상세주소
//   우편번호까지 9열 필수(상세주소 열만 생략 가능) · 값은 사번 · 사원명 · 전화 · 주소 4칸 필수, 대표자 · 부서 · 상세주소는 빈칸 가능 (11/01 결정)
//   대표자 'Y'(여러 명) · 주소는 카카오 검색 결과의 칸을 그대로
// 서버에 파일을 보내지 않고 JSON으로 바꿔 보냄 (명세 7장: CSV API 없음). 행 번호는 머리줄 = 1행
import { parseCsv } from '@/shared/lib/csv'
import type { Member, MemberInput } from '@/features/company/api/companyApi'
import { MEMBER_REASON } from '@/features/company/labels'

export const CSV_HEADER = [
  '사번',
  '사원명',
  '전화번호',
  '대표자',
  '부서',
  '도로명 주소',
  '지번 주소',
  '동',
  '우편번호',
  '상세주소',
] as const
// 예시 파일 (public/csv-example.csv, 11/06) — 기업 등록 · 사원 추가 창 공용. 양식(CSV_HEADER)을 바꾸면 이 파일도 같이 고침
export function downloadExampleCsv() {
  const a = document.createElement('a') // 내려받기는 <a download>로만 이름을 정할 수 있음
  a.href = `${import.meta.env.BASE_URL}csv-example.csv`
  a.download = '회사등록_양식_예시.csv'
  a.click()
}

export const MAX_MEMBERS = 1000 // 명세: 한 번에 1~1000건
const SHOW_ERRORS = 3 // 오류는 처음 3줄까지 (11/01 결정), 나머지는 '외 n건'
const REQUIRED_COLUMNS = 9 // 사번 ~ 우편번호
const MAX_DEPARTMENT_NAME = 100 // 서버 부서 이름 최대 (CreateDepartmentDto)

/** 파일 바이트 → 글자. UTF-8로 읽어 보고 깨지면(잘못된 바이트) EUC-KR로 (11/01 결정 A)
 * 엑셀 '다른 이름으로 저장 → CSV'의 기본이 EUC-KR(한국어 Windows)이라 그대로 읽으면 한글이 깨짐. 브라우저 기본 TextDecoder만 씀 */
export function decodeCsv(bytes: ArrayBuffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes) // fatal: 잘못된 바이트면 '�' 대신 오류
  } catch {
    return new TextDecoder('euc-kr').decode(bytes)
  }
}

/** 전화번호: 하이픈 · 공백을 빼고 0으로 시작하는 10~11자리 (CSV · 사원 추가 창 공용) */
export const phoneDigits = (v: string) => v.replace(/[-\s]/g, '')
export const isPhone = (digits: string) => /^0\d{9,10}$/.test(digits)

/** CSV 주소 — 서버 주소의 필수 칸(좌표 빼고) + 상세주소(빈칸 가능) */
export interface CsvAddress {
  roadAddress: string
  jibunAddress: string
  dongName: string
  postalCode: string // 5자리 — 엑셀이 앞 0을 지운 4자리는 0을 채움
  detailAddress: string
}

export interface CsvMember extends MemberInput {
  leader: boolean // 대표자 Y → role=ORG_ADMIN
  department: string | null // 부서 이름 (없으면 부서 없음)
  address: CsvAddress
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
  // 우편번호까지는 꼭, 상세주소는 있어도 없어도 (그 뒤 빈 열 이름은 엑셀이 붙인 것 — 허용)
  const headOk =
    head !== undefined &&
    head.length >= REQUIRED_COLUMNS &&
    head.every((h, i) => h === (CSV_HEADER[i] ?? '') || (i >= REQUIRED_COLUMNS && h === ''))
  if (!headOk) return fail([`첫 줄은 '${CSV_HEADER.join(',')}'여야 합니다.`])
  if (body.length === 0) return fail(['사원이 한 명도 없습니다.'])
  if (body.length > MAX_MEMBERS)
    return fail([`한 번에 ${MAX_MEMBERS}명까지 등록할 수 있습니다. (지금 ${body.length}명)`])

  const errors: string[] = []
  const members: CsvMember[] = []
  const seenNo = new Map<string, number>()
  const seenPhone = new Map<string, number>()
  body.forEach(([no = '', name = '', phone = '', leader = '', dept = '', ...addr], i) => {
    const line = i + 2 // 머리줄 다음부터
    const digits = phoneDigits(phone)
    if (!no) return errors.push(`${line}행 사번이 비어 있습니다.`)
    if (!name) return errors.push(`${line}행 사원명이 비어 있습니다.`)
    if (!isPhone(digits)) return errors.push(`${line}행 전화번호 형식이 맞지 않습니다.`)
    if (leader !== '' && leader.toUpperCase() !== 'Y')
      return errors.push(`${line}행 대표자는 Y 또는 빈칸이어야 합니다.`)
    if (dept.length > MAX_DEPARTMENT_NAME)
      return errors.push(`${line}행 부서 이름은 ${MAX_DEPARTMENT_NAME}자까지입니다.`)
    const [road = '', jibun = '', dong = '', postal = '', detail = ''] = addr
    if (!(road && jibun && dong && postal))
      return errors.push(`${line}행 주소는 도로명 · 지번 · 동 · 우편번호를 모두 써 주세요.`)
    // 엑셀은 0으로 시작하는 번호(서울 01~09)의 앞 0만 지움 → 4자리면 0 하나가 빠진 것. 그 밖의 길이는 원래 값을 알 수 없어 막음
    const zip = /^\d{4}$/.test(postal) ? `0${postal}` : postal
    if (!/^\d{5}$/.test(zip)) return errors.push(`${line}행 우편번호는 숫자 5자리여야 합니다.`)
    // 명세: 요청 안의 사번 · 전화 중복은 보내기 전에 정리 → 겹치면 어느 줄인지 알려 줌
    if (seenNo.has(no)) return errors.push(`${line}행 사번이 ${seenNo.get(no)}행과 겹칩니다.`)
    if (seenPhone.has(digits))
      return errors.push(`${line}행 전화번호가 ${seenPhone.get(digits)}행과 겹칩니다.`)
    seenNo.set(no, line)
    seenPhone.set(digits, line)
    members.push({
      employeeNo: no,
      name,
      phoneNumber: digits,
      leader: leader !== '',
      department: dept || null,
      address: {
        roadAddress: road,
        jibunAddress: jibun,
        dongName: dong,
        postalCode: zip,
        detailAddress: detail,
      },
      line,
    })
  })
  return errors.length ? fail(errors) : { ok: true, members }
}

/** 서버 오류의 항목 경로(items.3.phoneNumber · members.3.phoneNumber) → '5행 전화번호를 확인해 주세요.' — 경로 형식은 backend-todo 10에서 확인 중 */
export function serverRowErrors(
  details: { field: string; reason: string }[],
  members: CsvMember[],
): string[] {
  return details.flatMap((d) => {
    // 사원 추가는 items.N, 기업 한 번에 등록은 members.N (11/01)
    const m = /^(?:items|members)\.(\d+)(?:\.(\w+))?/.exec(d.field)
    const row = m ? members[Number(m[1])] : undefined
    if (!row) return []
    if (MEMBER_REASON[d.reason]) return [`${row.line}행: ${MEMBER_REASON[d.reason]}`] // 이유를 알면 그 문장
    const field = FIELD[m![2] as keyof MemberInput]
    return [`${row.line}행 ${field ?? '내용을'} 확인해 주세요.`]
  })
}

/** CSV 사원 추가 미리 보기 (11/01 결정 B) — 기존 사원과 비교해 신규 · 바뀜 · 변경 없음으로 나눔
 * 서버는 같은 사번이면 조용히 덮어써서, 무엇이 바뀌는지 [등록] 전에 보여 줌
 * 비교 칸 (11/01 결정): 이름 · 전화 · 대표자 · 부서 · 주소(좌표 빼고) */
export type ChangedField = '사원명' | '전화번호' | '대표자' | '부서' | '주소'
export interface CsvChange {
  row: CsvMember
  before: {
    name: string
    phoneNumber: string
    department: string | null
    roadAddress: string | null
  }
  fields: ChangedField[] // 바뀐 칸 — '주소'가 있으면 주소도 다시 저장
}
export interface CsvPreview {
  added: CsvMember[] // 새 사번
  changed: CsvChange[] // 같은 사번, 하나라도 다름 → 덮어씀
  same: CsvMember[] // 같은 사번, 그대로 → 보내지 않음
  leaders: string[] // 대표자로 새로 지정할 사번 (이미 대표자면 뺌). 빈칸은 '지정 안 함' — 기존 대표자를 내리지 않음
  errors: string[] // 보내면 서버가 전체를 거절할 줄 (다른 사원이 쓰는 전화)
}

const ADDRESS_KEYS = [
  'roadAddress',
  'jibunAddress',
  'dongName',
  'postalCode',
  'detailAddress',
] as const

/** departmentNames: 부서 번호 → 이름 (GET /companies/{id}/departments). 기존 사원은 부서를 번호로만 가짐 */
export function previewAgainst(
  rows: CsvMember[],
  existing: Member[],
  departmentNames: Map<number, string>,
): CsvPreview {
  const byNo = new Map(existing.map((m) => [m.membership.employeeNo, m]))
  const byPhone = new Map(existing.map((m) => [m.customer.phoneNumber, m]))
  const out: CsvPreview = { added: [], changed: [], same: [], leaders: [], errors: [] }
  for (const r of rows) {
    const old = byNo.get(r.employeeNo)
    const owner = byPhone.get(r.phoneNumber)
    // 이 번호를 다른 사번의 사원이 이미 씀 → 서버가 전체 거절 (명세 7장)
    if (owner && owner.membership.employeeNo !== r.employeeNo) {
      out.errors.push(
        `${r.line}행 전화번호를 이미 ${owner.customer.name}(사번 ${owner.membership.employeeNo}) 님이 쓰고 있습니다.`,
      )
      continue
    }
    const newLeader = r.leader && old?.membership.role !== 'ORG_ADMIN'
    if (newLeader) out.leaders.push(r.employeeNo)
    if (!old) {
      out.added.push(r)
      continue
    }
    const seq = old.membership.departmentSeq
    const department = seq === null ? null : (departmentNames.get(seq) ?? null)
    const addr = old.customer.address
    const fields: ChangedField[] = []
    if (old.customer.name !== r.name) fields.push('사원명')
    if (old.customer.phoneNumber !== r.phoneNumber) fields.push('전화번호')
    if (newLeader) fields.push('대표자')
    // 서버는 부서를 빼고 보내면 '부서 없음' → 빈칸도 바뀜으로 보여 줌 (대표자 빈칸과 다름)
    if (department !== r.department) fields.push('부서')
    if (!addr || ADDRESS_KEYS.some((k) => (addr[k] ?? '') !== r.address[k])) fields.push('주소')
    if (fields.length === 0) out.same.push(r)
    else
      out.changed.push({
        row: r,
        before: {
          name: old.customer.name,
          phoneNumber: old.customer.phoneNumber,
          department,
          roadAddress: addr?.roadAddress ?? null,
        },
        fields,
      })
  }
  return out
}
