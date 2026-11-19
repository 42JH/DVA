// 08 사원 CSV → 등록 항목 (CSV로 기업 등록 · CSV로 사원 추가 공용). React를 모르는 순수 함수 — csvMembers.test.ts
// 모양: 사번,사원명,전화번호,담당자(예전 파일의 '대표자'도 받음),부서,도로명 주소,지번 주소,동,우편번호,상세주소
//   우편번호까지 9열 필수(상세주소 열만 생략 가능) · 값은 사번 · 사원명 · 전화 · 주소 4칸 필수, 담당자 · 부서 · 상세주소는 빈칸 가능
//   담당자 'Y'(여러 명) · 주소는 카카오 검색 결과의 칸을 그대로
// 서버에 파일을 보내지 않고 JSON으로 바꿔 보냄 (명세 7장: CSV API 없음). 행 번호는 머리줄 = 1행
import { parseCsv } from '@/shared/lib/csv'
import type { Member, MemberInput } from './api/companyApi'
import { MEMBER_REASON } from './labels'

const CSV_HEADER = [
  '사번',
  '사원명',
  '전화번호',
  '담당자',
  '부서',
  '도로명 주소',
  '지번 주소',
  '동',
  '우편번호',
  '상세주소',
] as const
// 예시 CSV (예시 CSV를 내려받아 엑셀로 열어도 앞 0이 사라지지 않게) — 사원 CSV · 기업 CSV(첫 칸 기업명) 두 양식
//   엑셀은 CSV를 열 때 숫자처럼 보이는 칸('001' · '04524')을 숫자로 바꿔 앞 0을 지움 (CSV엔 칸 형식이 없어서)
//   → 사번 · 우편번호는 ="001" 로 적음: 엑셀이 글자를 돌려주는 수식으로 읽어 0이 남고, 엑셀에서 저장하면 001로 저장됨
//   → 전화번호는 전화번호 형식 010-0000-0001 (전화번호 형식으로 통일) — 하이픈이 있어 엑셀이 숫자로 안 바꿈
//   맨 앞 BOM — 엑셀이 UTF-8로 읽게 (없으면 한글이 깨짐). 양식(CSV_HEADER)을 바꾸면 여기도 같이 고침
const ADDR = ['서울특별시 중구 세종대로 110', '서울특별시 중구 태평로1가 31', '태평로1가', '04524']
const EXAMPLE_ROWS = [
  ['001', '김샘플', '010-0000-0001', 'Y', '경영지원팀', ...ADDR, '샘플 101호'],
  ['002', '이샘플', '010-0000-0002', '', '개발팀', ...ADDR, '샘플 102호'],
  ['003', '박샘플', '010-0000-0003', '', '개발팀', ...ADDR, ''],
]
// 기업 CSV (기업 목록 — 첫 칸 기업명, 한 파일 = 한 기업. 담당자 Y 1명 이상, 11/11 사용자)
const COMPANY_EXAMPLE_ROWS = [
  ['샘플상사', '001', '김샘플', '010-0000-0001', 'Y', '경영지원팀', ...ADDR, '샘플 101호'],
  ['샘플상사', '002', '이샘플', '010-0000-0002', '', '경영지원팀', ...ADDR, '샘플 102호'],
  ['샘플상사', '003', '박샘플', '010-0000-0003', '', '개발팀', ...ADDR, '샘플 201호'],
  ['샘플상사', '004', '최샘플', '010-0000-0004', '', '개발팀', ...ADDR, ''],
]
const KEEP_ZERO = new Set([0, 8]) // 사번 · 우편번호 열 (기업 CSV는 한 칸씩 뒤)
export type CsvKind = 'members' | 'companies'
const headerOf = (kind: CsvKind): string[] =>
  kind === 'companies' ? ['기업명', ...CSV_HEADER] : [...CSV_HEADER]
const LEGACY_ROLE_COL = 3 // 담당자 열 — 예전 이름 '대표자'
const csvCell = (v: string) => (/[",\r\n]/.test(v) ? `"${v.replaceAll('"', '""')}"` : v)
/** 예시 CSV 글 (테스트에서 이 글을 그대로 읽어 봄) */
export function exampleCsv(kind: CsvKind = 'members'): string {
  const shift = kind === 'companies' ? 1 : 0
  const rows = kind === 'companies' ? COMPANY_EXAMPLE_ROWS : EXAMPLE_ROWS
  const body = rows.map((r) =>
    r.map((v, i) => csvCell(KEEP_ZERO.has(i - shift) && v ? `="${v}"` : v)).join(','),
  )
  return `\uFEFF${[headerOf(kind).join(','), ...body].join('\r\n')}\r\n`
}
export function downloadExample(kind: CsvKind = 'members') {
  const url = URL.createObjectURL(new Blob([exampleCsv(kind)], { type: 'text/csv;charset=utf-8' }))
  const a = document.createElement('a') // 내려받기는 <a download>로만 이름을 정할 수 있음
  a.href = url
  a.download = kind === 'companies' ? '기업등록_양식_샘플.csv' : '사원등록_양식_샘플.csv'
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 0)
}
/** 엑셀 글자 칸 표기를 벗김 — 예시의 ="001" (엑셀 말고 메모장으로 고친 파일) · 엑셀에서 쓴 '001 */
const plainCell = (v: string) => /^="(.*)"$/s.exec(v)?.[1] ?? v.replace(/^'(?=\d)/, '')

/** 올린 파일 → 검사 결과. 엑셀(.xlsx)이면 첫 시트를, 아니면 CSV로 읽어 같은 검사(readMembersRows)에 넘김 */
export async function readMembersFile(file: File, kind: CsvKind = 'members'): Promise<CsvResult> {
  if (!/\.xlsx$/i.test(file.name)) return readMembersCsv(decodeCsv(await file.arrayBuffer()), kind)
  try {
    const { readSheet } = await import('read-excel-file/browser') // 엑셀을 올릴 때만 받음 (첫 화면이 무거워지지 않게)
    // 숫자 칸도 엑셀에 저장된 글자 그대로 — 숫자로 바꾸면 '001'이 1, 큰 번호가 1.01E+10이 됨
    const rows = await readSheet(file, { parseNumber: (s) => s })
    return readMembersRows(
      rows.map((r) => r.map((v) => (v === null ? '' : String(v)))),
      kind,
    )
  } catch {
    return fail(['엑셀 파일을 읽지 못했습니다. .xlsx로 저장했는지 확인해 주세요.'])
  }
}

const MAX_MEMBERS = 1000 // 명세: 한 번에 1~1000건
const SHOW_ERRORS = 3 // 오류는 처음 3줄까지, 나머지는 '외 n건'
const REQUIRED_COLUMNS = 9 // 사번 ~ 우편번호 (기업 CSV는 앞에 기업명)
const MAX_COMPANY_NAME = 100
const MAX_DEPARTMENT_NAME = 100 // 서버 부서 이름 최대 (CreateDepartmentDto)

/** 파일 바이트 → 글자. UTF-8로 읽어 보고 깨지면(잘못된 바이트) EUC-KR로 (A)
 * 엑셀 '다른 이름으로 저장 → CSV'의 기본이 EUC-KR(한국어 Windows)이라 그대로 읽으면 한글이 깨짐. 브라우저 기본 TextDecoder만 씀 */
export function decodeCsv(bytes: ArrayBuffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes) // fatal: 잘못된 바이트면 '�' 대신 오류
  } catch {
    return new TextDecoder('euc-kr').decode(bytes)
  }
}

// 전화번호 = 전화번호 형식 010-1234-5678 하나로 통일 (무조건 전화번호 형식) — CSV · 사원 추가 창(수기 등록) 공용
//   하이픈 · 공백은 있어도 없어도 받고, 서버엔 숫자 11자리로 보냄 = 백엔드 사원 전화(MOBILE_PHONE_PATTERN '휴대전화 번호 11자리 문자열, 선행 0 유지')
export const phoneDigits = (v: string) => v.replace(/[-\s]/g, '')
const isPhone = (digits: string) => /^0\d{10}$/.test(digits)
const PHONE_RULE = '전화번호는 숫자 11자리로 넣어 주세요.'
/** 전화번호 오류 문구 (없으면 null) */
export const phoneError = (digits: string): string | null => (isPhone(digits) ? null : PHONE_RULE)
/** 화면에 보이는 전화번호 형식 — 치는 대로 3-4-4로 하이픈 (사원 추가 창 입력 칸). 숫자 11자리까지만 */
export function phoneInput(v: string): string {
  const d = v.replace(/\D/g, '').slice(0, 11)
  return d.length > 7
    ? `${d.slice(0, 3)}-${d.slice(3, 7)}-${d.slice(7)}`
    : d.length > 3
      ? `${d.slice(0, 3)}-${d.slice(3)}`
      : d
}

// 안전망: 그래도 엑셀이 숫자로 바꿔 앞 0이 지워진 전화번호(10자리 '1012345678')는 0을 붙여 11자리로
//   (예시 CSV를 쓰지 않고 직접 만든 파일 · 숫자 칸을 붙여 넣은 경우) — 0을 붙여 휴대전화 앞자리(010 · 011 · 016~019)가 될 때만
/** CSV · 엑셀 칸의 전화번호 → 숫자만 */
const csvPhone = (v: string) => {
  const d = phoneDigits(v)
  return /^1[016-9]\d{8}$/.test(d) ? `0${d}` : d
}
// 엑셀이 긴 숫자를 지수로 바꿔 저장한 값 '1.01E+10' — 원래 숫자를 알 수 없어 고칠 수 없음 → 원인을 알려 줌
const EXCEL_NUMBER = /^\d(?:\.\d+)?e\+?\d+$/i
const excelNumberError = (line: number, col: string) =>
  `${line}행 ${col}이 엑셀에서 숫자(지수 표기)로 바뀌었습니다. ${col} 열을 텍스트 형식으로 바꿔 다시 저장해 주세요.`

/** CSV 주소 — 서버 주소의 필수 칸(좌표 빼고) + 상세주소(빈칸 가능) */
interface CsvAddress {
  roadAddress: string
  jibunAddress: string
  dongName: string
  postalCode: string // 5자리 — 엑셀이 앞 0을 지운 4자리는 0을 채움
  detailAddress: string
}

export interface CsvMember extends MemberInput {
  company?: string // 기업 CSV의 기업명 (사원 CSV는 없음)
  leader: boolean // 담당자 Y → role=ORG_ADMIN
  department: string | null // 부서 이름 (없으면 부서 없음)
  address: CsvAddress
  line: number // 파일의 행 번호 (오류 안내용)
}

type CsvResult = { ok: true; members: CsvMember[] } | { ok: false; errors: string[]; more: number } // errors = 처음 3줄, more = 나머지 건수

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

export const readMembersCsv = (text: string, kind: CsvKind = 'members'): CsvResult =>
  readMembersRows(parseCsv(text), kind)

/** 줄 · 칸(CSV든 엑셀이든) → 사원 목록 또는 오류 */
function readMembersRows(rows: string[][], kind: CsvKind = 'members'): CsvResult {
  const [rawHead, ...rawBody] = rows.map((r) => r.map((v) => plainCell(v.trim())))
  // 기업 CSV는 첫 칸(기업명)을 떼고 사원 CSV와 같은 검사를 함
  const withCompany = kind === 'companies'
  if (withCompany && rawHead?.[0] !== '기업명')
    return fail([`첫 줄은 '${headerOf(kind).join(',')}'여야 합니다.`])
  const head = withCompany ? rawHead?.slice(1) : rawHead
  const companies = withCompany ? rawBody.map((r) => r[0] ?? '') : []
  const body = withCompany ? rawBody.map((r) => r.slice(1)) : rawBody
  // 우편번호까지는 꼭, 상세주소는 있어도 없어도 (그 뒤 빈 열 이름은 엑셀이 붙인 것 — 허용)
  const headOk =
    head !== undefined &&
    head.length >= REQUIRED_COLUMNS &&
    head.every(
      (h, i) =>
        h === (CSV_HEADER[i] ?? '') ||
        (i === LEGACY_ROLE_COL && h === '대표자') || // 11/11 이전 예시 파일
        (i >= REQUIRED_COLUMNS && h === ''),
    )
  if (!headOk) return fail([`첫 줄은 '${headerOf(kind).join(',')}'여야 합니다.`])
  if (body.length === 0) return fail(['사원이 한 명도 없습니다.'])
  if (body.length > MAX_MEMBERS)
    return fail([`한 번에 ${MAX_MEMBERS}명까지 등록할 수 있습니다. (지금 ${body.length}명)`])

  const errors: string[] = []
  const members: CsvMember[] = []
  const seenNo = new Map<string, number>()
  const seenPhone = new Map<string, number>()
  body.forEach(([no = '', name = '', phone = '', leader = '', dept = '', ...addr], i) => {
    const line = i + 2 // 머리줄 다음부터
    const digits = csvPhone(phone)
    const company = companies[i] ?? ''
    if (withCompany && !company) return errors.push(`${line}행 기업명이 비어 있습니다.`)
    if (company.length > MAX_COMPANY_NAME)
      return errors.push(`${line}행 기업명은 ${MAX_COMPANY_NAME}자까지입니다.`)
    // 사번은 같은 기업 안에서만 겹치면 안 됨. 전화번호는 한 사람이 두 기업에 들 수 없어 파일 전체에서
    const noKey = `${company}|${no}`
    if (!no) return errors.push(`${line}행 사번이 비어 있습니다.`)
    if (EXCEL_NUMBER.test(no)) return errors.push(excelNumberError(line, '사번'))
    if (!name) return errors.push(`${line}행 사원명이 비어 있습니다.`)
    if (EXCEL_NUMBER.test(phone)) return errors.push(excelNumberError(line, '전화번호'))
    const badPhone = phoneError(digits)
    if (badPhone) return errors.push(`${line}행 ${badPhone}`)
    if (leader !== '' && leader.toUpperCase() !== 'Y')
      return errors.push(`${line}행 담당자는 Y 또는 빈칸이어야 합니다.`)
    if (dept.length > MAX_DEPARTMENT_NAME)
      return errors.push(`${line}행 부서 이름은 ${MAX_DEPARTMENT_NAME}자까지입니다.`)
    const [road = '', jibun = '', dong = '', postal = '', detail = ''] = addr
    if (!(road && jibun && dong && postal))
      return errors.push(`${line}행 주소는 도로명, 지번, 동, 우편번호를 모두 써 주세요.`)
    // 엑셀은 0으로 시작하는 번호(서울 01~09)의 앞 0만 지움 → 4자리면 0 하나가 빠진 것. 그 밖의 길이는 원래 값을 알 수 없어 막음
    const zip = /^\d{4}$/.test(postal) ? `0${postal}` : postal
    if (!/^\d{5}$/.test(zip)) return errors.push(`${line}행 우편번호는 숫자 5자리여야 합니다.`)
    // 명세: 요청 안의 사번 · 전화 중복은 보내기 전에 정리 → 겹치면 어느 줄인지 알려 줌
    if (seenNo.has(noKey)) return errors.push(`${line}행 사번이 ${seenNo.get(noKey)}행과 겹칩니다.`)
    if (seenPhone.has(digits))
      return errors.push(`${line}행 전화번호가 ${seenPhone.get(digits)}행과 겹칩니다.`)
    seenNo.set(noKey, line)
    seenPhone.set(digits, line)
    members.push({
      ...(withCompany ? { company } : {}),
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
  // 한 파일 = 한 기업 · 담당자 1명 이상
  if (withCompany && errors.length === 0) {
    const companies = [...new Set(members.map((m) => m.company ?? ''))] // 파일에 나온 순서
    if (companies.length > 1)
      errors.push(`한 파일에는 한 기업만 넣어 주세요. (지금 ${companies.join(', ')})`)
    else if (!members.some((m) => m.leader)) errors.push('담당자를 1명 이상 Y로 표시해 주세요.')
  }
  return errors.length ? fail(errors) : { ok: true, members }
}

/** 서버 오류의 항목 경로(items.3.phoneNumber · members.3.phoneNumber) → '5행 전화번호를 확인해 주세요.' — 경로 형식은 backend-todo 10에서 확인 중 */
export function serverRowErrors(
  details: { field: string; reason: string }[],
  members: CsvMember[],
): string[] {
  return details.flatMap((d) => {
    // 사원 추가는 items.N, 기업 한 번에 등록은 members.N
    const m = /^(?:items|members)\.(\d+)(?:\.(\w+))?/.exec(d.field)
    const row = m ? members[Number(m[1])] : undefined
    if (!row) return []
    if (MEMBER_REASON[d.reason]) return [`${row.line}행: ${MEMBER_REASON[d.reason]}`] // 이유를 알면 그 문장
    const field = FIELD[m![2] as keyof MemberInput]
    return [`${row.line}행 ${field ?? '내용을'} 확인해 주세요.`]
  })
}

/** CSV 사원 추가 미리 보기 (B) — 기존 사원과 비교해 신규 · 바뀜 · 변경 없음으로 나눔
 * 서버는 같은 사번이면 조용히 덮어써서, 무엇이 바뀌는지 [등록] 전에 보여 줌
 * 비교 칸: 이름 · 전화 · 담당자 · 부서 · 주소(좌표 빼고) */
type ChangedField = '사원명' | '전화번호' | '담당자' | '부서' | '주소'
interface CsvChange {
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
  leaders: string[] // 담당자로 새로 지정할 사번 (이미 담당자면 뺌). 빈칸은 '지정 안 함' — 기존 담당자를 내리지 않음
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
  // 숫자만인 사번은 앞 0을 뗀 값으로도 찾음 — 엑셀이 '001'을 1로 바꾸면 같은 사람이 새 사원 '1'로 따로 생김 (사번은 등록 뒤 못 바꿈)
  const unpad = (no: string) => (/^\d+$/.test(no) ? no.replace(/^0+(?=\d)/, '') : null)
  const byNumber = new Map(
    existing.flatMap((m) => {
      const k = unpad(m.membership.employeeNo)
      return k === null ? [] : [[k, m] as const]
    }),
  )
  const byPhone = new Map(existing.map((m) => [m.customer.phoneNumber, m]))
  const out: CsvPreview = { added: [], changed: [], same: [], leaders: [], errors: [] }
  for (const r of rows) {
    const old = byNo.get(r.employeeNo)
    const padded = old ? undefined : byNumber.get(unpad(r.employeeNo) ?? '')
    if (padded) {
      out.errors.push(
        `${r.line}행 사번 '${r.employeeNo}'은 기존 사번 '${padded.membership.employeeNo}'(${padded.customer.name})과 앞의 0만 다릅니다. 엑셀이 0을 지웠을 수 있으니 사번 열을 텍스트 형식으로 바꿔 다시 저장해 주세요.`,
      )
      continue
    }
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
    if (newLeader) fields.push('담당자')
    // 서버는 부서를 빼고 보내면 '부서 없음' → 빈칸도 바뀜으로 보여 줌 (담당자 빈칸과 다름)
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
