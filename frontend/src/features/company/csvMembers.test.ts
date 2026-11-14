// 실행: npx tsx --tsconfig tsconfig.app.json src/features/company/csvMembers.test.ts  (프레임워크 없이 assert만)
import assert from 'node:assert/strict'
import type { Member } from './api/companyApi'
import {
  decodeCsv,
  exampleCsv,
  phoneInput,
  previewAgainst,
  readMembersCsv,
  serverRowErrors,
  type CsvMember,
} from './csvMembers'
import { errorText } from './labels'

const HEAD = '사번,사원명,전화번호,대표자,부서,도로명 주소,지번 주소,동,우편번호'
const ADDR = '도로,지번,동,06236'
// 사번,사원명,전화번호,대표자 → 부서 빈칸 + 주소 4칸을 붙인 한 줄
const row = (s: string) => `${s}${s.split(',').length === 3 ? ',' : ''},,${ADDR}`
const address = {
  roadAddress: '도로',
  jibunAddress: '지번',
  dongName: '동',
  postalCode: '06236',
  detailAddress: '',
}
const ok = (text: string) => {
  const r = readMembersCsv(text)
  assert.ok(r.ok, JSON.stringify(r))
  return r.members
}
const errs = (text: string) => {
  const r = readMembersCsv(text)
  assert.ok(!r.ok, '오류여야 함')
  return r
}

// 정상: 사번 앞 0 보존 · 전화 하이픈 제거 · 대표자 여러 명 · 소문자 y · BOM
const m = ok(
  `\uFEFF${HEAD}\n${row('00121,이서미,010-2481-3375,Y')}\n${row('00134,박준호,01077135092,')}\n${row('00152,김하린,010 3358 0164,y')}\n`,
)
assert.deepEqual(
  m.map((x) => [x.employeeNo, x.phoneNumber, x.leader, x.line]),
  [
    ['00121', '01024813375', true, 2],
    ['00134', '01077135092', false, 3],
    ['00152', '01033580164', true, 4],
  ],
)
// 주소 열까지는 필수 — 예전 3 · 4열 파일은 거절
assert.match(errs('사번,사원명,전화번호\n1,가,0212345678').errors[0]!, /첫 줄/)

// 머리줄 · 빈 파일 · 1000명 초과
assert.match(errs('번호,이름,전화\n1,가,01012345678').errors[0]!, /첫 줄/)
assert.match(errs(HEAD).errors[0]!, /한 명도/)
assert.match(
  errs(
    [
      HEAD,
      ...Array.from({ length: 1001 }, (_, i) => row(`${i},가,010${String(i).padStart(8, '0')}`)),
    ].join('\n'),
  ).errors[0]!,
  /1000명/,
)

// 줄 오류: 처음 3줄 + 나머지 건수
const e = errs(
  [HEAD, ',가,01011112222', '2,,01011112223', '3,다,123', '4,라,01011112224,X', '4,마,01011112225']
    .map((r, i) => (i ? row(r) : r))
    .join('\n'),
)
assert.deepEqual(e.errors, [
  '2행 사번이 비어 있습니다.',
  '3행 사원명이 비어 있습니다.',
  '4행 전화번호는 숫자 11자리로 넣어 주세요.',
])
assert.equal(e.more, 1) // 5행 대표자 X (6행은 5행이 오류라 사번이 기록 안 돼 겹침 아님)

// 겹침
assert.deepEqual(errs(`${HEAD}\n${row('1,가,01011112222')}\n${row('1,나,01033334444')}`).errors, [
  '3행 사번이 2행과 겹칩니다.',
])
assert.deepEqual(errs(`${HEAD}\n${row('1,가,01011112222')}\n${row('2,나,010-1111-2222')}`).errors, [
  '3행 전화번호가 2행과 겹칩니다.',
])

// 전화번호 = 010-1234-5678 형식 하나로 통일 (11/06) — 하이픈은 있어도 없어도, 서버엔 숫자 11자리
const phoneOf = (phone: string) => {
  const r = readMembersCsv(`${HEAD}\n${row(`1,가,${phone}`)}`)
  assert.ok(r.ok, `${phone}: ${JSON.stringify(r)}`)
  return r.members[0]!.phoneNumber
}
assert.equal(phoneOf('010-1234-5678'), '01012345678')
assert.equal(phoneOf('01012345678'), '01012345678')
// 안전망: 엑셀이 지운 휴대전화 앞 0(10자리 '1012345678')은 되살림
assert.equal(phoneOf('1012345678'), '01012345678')
assert.equal(phoneOf('1612345678'), '01612345678')
// 11자리가 아니면 거절 (02 · 지역번호 9~10자리 · 대표번호 · 아무 숫자 · 너무 긺)
const BAD = '2행 전화번호는 숫자 11자리로 넣어 주세요.'
for (const bad of ['02-123-4567', '054-123-4567', '15881234', '1234567890', '010123456789', '123'])
  assert.deepEqual(errs(`${HEAD}\n${row(`1,가,${bad}`)}`).errors, [BAD])
// 수기 등록 칸: 치는 대로 3-4-4 하이픈, 11자리까지만
assert.deepEqual(
  ['010', '0101', '0101234', '01012345', '01012345678', '010-1234-56789', '010 1234 5678'].map(
    phoneInput,
  ),
  ['010', '010-1', '010-1234', '010-1234-5', '010-1234-5678', '010-1234-5678', '010-1234-5678'],
)
// 엑셀 글자 칸 표기: 예시의 ="001" · 엑셀에서 쓴 '004 → 그대로 글자
assert.deepEqual(
  ok(
    `${HEAD}\n"=""001""",가,010-1111-2222,,,도로,지번,동,"=""04524"""\n'004,나,010-1111-3333,,,${ADDR}`,
  ).map((m) => [m.employeeNo, m.address.postalCode]),
  [
    ['001', '04524'],
    ['004', '06236'],
  ],
)
// 엑셀 지수 표기는 원래 숫자를 알 수 없음 → 열을 텍스트로 바꾸라고
assert.match(errs(`${HEAD}\n${row('1,가,1.01E+10')}`).errors[0]!, /전화번호 열을 텍스트/)
assert.match(errs(`${HEAD}\n${row('1.23E+11,가,01012345678')}`).errors[0]!, /사번 열을 텍스트/)

// 서버 오류 경로 → 행 번호 (items 순서 = members 순서)
const rows: CsvMember[] = [
  {
    employeeNo: '1',
    name: '가',
    phoneNumber: '01011112222',
    leader: false,
    department: null,
    address,
    line: 2,
  },
  {
    employeeNo: '2',
    name: '나',
    phoneNumber: '01033334444',
    leader: false,
    department: null,
    address,
    line: 3,
  },
]
assert.deepEqual(
  serverRowErrors(
    [
      { field: 'items.1.phoneNumber', reason: 'X' },
      { field: 'items.0', reason: 'X' },
      { field: 'name', reason: 'X' }, // 항목 경로가 아니면 버림 → 훅이 서버 문구로
    ],
    rows,
  ),
  ['3행 전화번호를 확인해 주세요.', '2행 내용을 확인해 주세요.'],
)
// 기업 한 번에 등록의 경로(members.N)도 행으로
assert.deepEqual(serverRowErrors([{ field: 'members.0.name', reason: 'X' }], rows), [
  '2행 사원명을 확인해 주세요.',
])
// 이유 코드를 알면 그 문장 (백엔드 답 11/01)
assert.deepEqual(
  serverRowErrors([{ field: 'items.1.phoneNumber', reason: 'OTHER_COMPANY_MEMBERSHIP' }], rows),
  ['3행: 다른 기업에 소속된 고객의 전화번호입니다.'],
)

// 인코딩: UTF-8은 그대로, EUC-KR(엑셀 기본)은 다시 읽음
const utf8 = new TextEncoder().encode(HEAD).buffer as ArrayBuffer
assert.equal(decodeCsv(utf8), HEAD)
const eucKr = new Uint8Array([0xbb, 0xe7, 0xb9, 0xf8]).buffer // '사번'을 EUC-KR로
assert.equal(decodeCsv(eucKr), '사번')

// 미리 보기: 기존 사원과 비교 (이름 · 전화 · 대표자 · 부서 · 주소)
const existing = (
  [
    ['00121', '이서미', '01011110001', 'ORG_ADMIN', 10],
    ['00134', '박준호', '01011110002', 'MEMBER', null],
    ['00152', '김하린', '01011110003', 'MEMBER', null],
    ['00180', '최유나', '01011110005', 'MEMBER', 10],
  ] as const
).map(([employeeNo, name, phoneNumber, role, departmentSeq], i): Member => ({
  membership: {
    membershipSeq: i + 1,
    customerSeq: i + 1,
    organizationSeq: 1,
    departmentSeq,
    employeeNo,
    role,
    status: 'ACTIVE',
  },
  customer: {
    customerSeq: i + 1,
    name,
    phoneNumber,
    address,
    status: 'ACTIVE',
  },
}))
const csv = ok(
  [
    HEAD + ',상세주소',
    `00121,이서미,01011110001,Y,개발팀,${ADDR}`, // 그대로 · 이미 대표자 → 지정 안 함
    `00134,박준호,01099990002,Y,,${ADDR}`, // 전화 바뀜 · 대표자 새로
    `00160,정우석,01011110004,,,${ADDR}`, // 신규
    `00170,오세린,01011110003,,,${ADDR}`, // CSV엔 없는 김하린(00152)의 번호 → 거절될 줄
    `00180,최유나,01011110005,,,${ADDR},2층`, // 부서 빈칸 = 부서 없음 · 상세주소 바뀜
  ].join('\n'),
)
const pv = previewAgainst(csv, existing, new Map([[10, '개발팀']]))
assert.deepEqual(
  pv.added.map((r) => r.employeeNo),
  ['00160'],
)
assert.deepEqual(
  pv.changed.map((c) => [c.row.employeeNo, c.fields, c.before.department]),
  [
    ['00134', ['전화번호', '담당자'], null],
    ['00180', ['부서', '주소'], '개발팀'],
  ],
)
assert.deepEqual(
  pv.same.map((r) => r.employeeNo),
  ['00121'],
)
assert.deepEqual(pv.leaders, ['00134'])
assert.deepEqual(pv.errors, ['5행 전화번호를 이미 김하린(사번 00152) 님이 쓰고 있습니다.'])

// 엑셀이 사번 앞 0을 지움(00134 → 134): 새 사원으로 따로 만들지 않고 막음 (사번은 등록 뒤 못 바꿈)
const csvOf = (r: string) => ok(`${HEAD}\n${row(r)}`)
const lost = previewAgainst(csvOf('134,박준호,01011110002'), existing, new Map())
assert.deepEqual(lost.added, [])
assert.match(lost.errors[0]!, /2행 사번 '134'은 기존 사번 '00134'\(박준호\)과 앞의 0만 다릅니다/)
// 진짜 다른 번호는 그대로 신규
assert.deepEqual(
  previewAgainst(csvOf('1340,새사람,01022223333'), existing, new Map()).added.map(
    (r) => r.employeeNo,
  ),
  ['1340'],
)

// 창 한 줄 설명: 이유 코드가 있으면 그 문장, 없으면 상태 코드별 설명
assert.equal(
  errorText(
    { status: 422, details: [{ field: 'items.0.phoneNumber', reason: 'CUSTOMER_WITHDRAWN' }] },
    '등록',
  ),
  '탈퇴한 고객의 전화번호라 등록할 수 없습니다.',
)
assert.match(errorText({ status: 422, details: [] }, '등록'), /등록 조건에 맞지 않아/)

// 부서 · 주소 열 (11/01): 주소 4칸 필수, 부서 · 상세주소는 빈칸 가능, 상세주소 열은 생략 가능
const FULL = '사번,사원명,전화번호,담당자,부서,도로명 주소,지번 주소,동,우편번호,상세주소'
const withAddr = ok(
  [
    FULL,
    '001,가,01011110001,Y,개발팀,서울 강남구 역삼로 150,서울 강남구 역삼동 737,역삼동,06236,5층',
    '002,나,01011110002,,,도로,지번,동,6236,', // 부서 없음 · 엑셀이 앞 0을 지운 우편번호 → 채움
  ].join('\n'),
)
assert.deepEqual(
  withAddr.map((m) => [m.department, m.address.postalCode, m.address.detailAddress]),
  [
    ['개발팀', '06236', '5층'],
    [null, '06236', ''],
  ],
)
assert.deepEqual(
  errs([FULL, '003,다,01011110003,,,서울 강남구 역삼로 150,,역삼동,06236,'].join('\n')).errors,
  ['2행 주소는 도로명, 지번, 동, 우편번호를 모두 써 주세요.'],
)
for (const zip of ['236', '062360', '0623a'])
  assert.match(
    errs([FULL, `004,라,01011110004,,,도로,지번,동,${zip},`].join('\n')).errors[0]!,
    /우편번호는 숫자 5자리/, // 4자리 말고는 원래 값을 알 수 없음
  )
assert.match(
  errs([FULL, '006,바,01011110006,,,,,,,'].join('\n')).errors[0]!,
  /도로명, 지번, 동, 우편번호를 모두/, // 주소 없음
)
assert.match(
  errs([FULL, '005,마,01011110005,,,,,,,7층'].join('\n')).errors[0]!,
  /도로명, 지번, 동, 우편번호를 모두/, // 상세주소만
)
assert.match(
  errs([FULL, `007,사,01011110007,,${'가'.repeat(101)},도로,지번,동,06236,`].join('\n')).errors[0]!,
  /부서 이름은 100자까지/,
)
// 머리줄 순서가 다르면 거절
assert.match(errs('사번,사원명,전화번호,부서\n1,가,01011112222,개발팀').errors[0]!, /첫 줄/)

// 예시 CSV(예시 CSV 내려받기)가 지금 양식을 통과하고 앞 0이 남음 — 양식을 바꾸고 예시를 안 고치면 여기서 걸림
// 엑셀이 0을 지우지 않게: 맨 앞 BOM(한글) · 사번 · 우편번호는 ="001" · 전화번호는 010-0000-0001 형식
const exText = exampleCsv()
assert.equal(exText.charCodeAt(0), 0xfeff)
assert.ok(exText.includes(`"=""001""",김샘플,010-0000-0001,Y,`))
assert.ok(exText.includes(`,"=""04524""",`))
assert.deepEqual(
  ok(exText).map((m) => [m.employeeNo, m.phoneNumber, m.address.postalCode]),
  [
    ['001', '01000000001', '04524'],
    ['002', '01000000002', '04524'],
    ['003', '01000000003', '04524'],
  ],
)

// 기업 CSV (11/11): 첫 칸 기업명 · 한 파일 = 한 기업 · 담당자 1명 이상
const coText = exampleCsv('companies')
assert.ok(coText.startsWith('﻿기업명,사번,'))
const co = readMembersCsv(coText, 'companies')
assert.ok(co.ok)
assert.deepEqual([...new Set(co.members.map((m) => m.company))], ['샘플상사'])
assert.deepEqual([...new Set(co.members.map((m) => m.department))], ['경영지원팀', '개발팀']) // 부서 2곳
assert.equal(co.members.filter((m) => m.leader).length, 1)
assert.equal(co.members[0]!.employeeNo, '001') // 사원 칸이 한 칸씩 밀려 읽히지 않음
assert.equal(co.members[0]!.address.postalCode, '04524')
const CO_HEAD = '기업명,사번,사원명,전화번호,담당자,부서,도로명 주소,지번 주소,동,우편번호'
const coRow = (c: string) => `${c},${ADDR}`
const coErr = (t: string) => {
  const r = readMembersCsv(t, 'companies')
  assert.ok(!r.ok)
  return r.errors
}
assert.match(
  coErr(`${CO_HEAD}
${coRow('가사,1,가,01011112222,,')}`)[0]!,
  /담당자를 1명 이상/,
)
assert.match(
  coErr(`${CO_HEAD}
${coRow(',1,가,01011112222,Y,')}`)[0]!,
  /기업명이 비어/,
)
assert.match(
  coErr(`${HEAD}
${row('1,가,01011112222,Y')}`)[0]!,
  /첫 줄은 '기업명/,
)
// 기업명이 둘이면 막음 (한 파일 = 한 기업)
assert.match(
  coErr(`${CO_HEAD}
${coRow('가사,1,가,01011112222,Y,')}
${coRow('나사,2,나,01011113333,Y,')}`)[0]!,
  /한 파일에는 한 기업만/,
)
assert.match(
  coErr(`${CO_HEAD}
${coRow('가사,1,가,01011112222,Y,')}
${coRow('가사,1,나,01011113333,,')}`)[0]!,
  /사번이 2행과 겹칩니다/,
)

console.log('csvMembers OK')
