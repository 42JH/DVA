// 실행: npx tsx --tsconfig tsconfig.app.json src/features/company/csvMembers.test.ts  (프레임워크 없이 assert만)
import assert from 'node:assert/strict'
import type { Member } from './api/companyApi'
import {
  decodeCsv,
  previewAgainst,
  readMembersCsv,
  serverRowErrors,
  type CsvMember,
} from './csvMembers'
import { errorText } from './labels'

const HEAD = '사번,사원명,전화번호,대표자'
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
  `\uFEFF${HEAD}\n00121,이서미,010-2481-3375,Y\n00134,박준호,01077135092,\n00152,김하린,010 3358 0164,y\n`,
)
assert.deepEqual(
  m.map((x) => [x.employeeNo, x.phoneNumber, x.leader, x.line]),
  [
    ['00121', '01024813375', true, 2],
    ['00134', '01077135092', false, 3],
    ['00152', '01033580164', true, 4],
  ],
)
// 대표자 열이 없어도 됨
assert.equal(ok('사번,사원명,전화번호\n1,가,0212345678')[0]!.leader, false)

// 머리줄 · 빈 파일 · 1000명 초과
assert.match(errs('번호,이름,전화\n1,가,01012345678').errors[0]!, /첫 줄/)
assert.match(errs(HEAD).errors[0]!, /한 명도/)
assert.match(
  errs(
    [
      HEAD,
      ...Array.from({ length: 1001 }, (_, i) => `${i},가,010${String(i).padStart(8, '0')}`),
    ].join('\n'),
  ).errors[0]!,
  /1000명/,
)

// 줄 오류: 처음 3줄 + 나머지 건수
const e = errs(
  [
    HEAD,
    ',가,01011112222',
    '2,,01011112223',
    '3,다,123',
    '4,라,01011112224,X',
    '4,마,01011112225',
  ].join('\n'),
)
assert.deepEqual(e.errors, [
  '2행 사번이 비어 있습니다.',
  '3행 사원명이 비어 있습니다.',
  '4행 전화번호 형식이 맞지 않습니다.',
])
assert.equal(e.more, 1) // 5행 대표자 X (6행은 5행이 오류라 사번이 기록 안 돼 겹침 아님)

// 겹침
assert.deepEqual(errs(`${HEAD}\n1,가,01011112222\n1,나,01033334444`).errors, [
  '3행 사번이 2행과 겹칩니다.',
])
assert.deepEqual(errs(`${HEAD}\n1,가,01011112222\n2,나,010-1111-2222`).errors, [
  '3행 전화번호가 2행과 겹칩니다.',
])

// 서버 오류 경로 → 행 번호 (items 순서 = members 순서)
const rows: CsvMember[] = [
  { employeeNo: '1', name: '가', phoneNumber: '01011112222', leader: false, line: 2 },
  { employeeNo: '2', name: '나', phoneNumber: '01033334444', leader: false, line: 3 },
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

// 미리 보기: 기존 사원과 비교
const existing = (
  [
    ['00121', '이서미', '01011110001', 'ORG_ADMIN'],
    ['00134', '박준호', '01011110002', 'MEMBER'],
    ['00152', '김하린', '01011110003', 'MEMBER'],
  ] as const
).map(([employeeNo, name, phoneNumber, role], i): Member => ({
  membership: {
    membershipSeq: i + 1,
    customerSeq: i + 1,
    organizationSeq: 1,
    departmentSeq: null,
    employeeNo,
    role,
    status: 'ACTIVE',
  },
  customer: { customerSeq: i + 1, name, phoneNumber, address: null, status: 'ACTIVE' },
}))
const csv = ok(
  [
    HEAD,
    '00121,이서미,01011110001,Y', // 그대로 · 이미 대표자 → 지정 안 함
    '00134,박준호,01099990002,Y', // 전화 바뀜 · 대표자 새로
    '00160,정우석,01011110004,', // 신규
    '00170,오세린,01011110003,', // CSV엔 없는 김하린(00152)의 번호 → 거절될 줄
  ].join('\n'),
)
const pv = previewAgainst(csv, existing)
assert.deepEqual(
  pv.added.map((r) => r.employeeNo),
  ['00160'],
)
assert.deepEqual(
  pv.changed.map((c) => [c.row.employeeNo, c.before.phoneNumber]),
  [['00134', '01011110002']],
)
assert.deepEqual(
  pv.same.map((r) => r.employeeNo),
  ['00121'],
)
assert.deepEqual(pv.leaders, ['00134'])
assert.deepEqual(pv.errors, ['5행 전화번호를 이미 김하린(사번 00152) 님이 쓰고 있습니다.'])

// 창 한 줄 설명: 이유 코드가 있으면 그 문장, 없으면 상태 코드별 설명
assert.equal(
  errorText(
    { status: 422, details: [{ field: 'items.0.phoneNumber', reason: 'CUSTOMER_WITHDRAWN' }] },
    '등록',
  ),
  '탈퇴한 고객의 전화번호라 등록할 수 없습니다.',
)
assert.match(errorText({ status: 422, details: [] }, '등록'), /등록 조건에 맞지 않아/)

console.log('csvMembers OK')
