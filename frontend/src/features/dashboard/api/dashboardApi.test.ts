// 실행: npx tsx src/features/dashboard/api/dashboardApi.test.ts  (프레임워크 없이 assert만)
// pickVersions는 '@/' 모듈을 import하는 파일 안에 있어 tsx가 못 읽으므로, 같은 규칙을 여기서 다시 확인하지 않고
// 입력 → 출력만 검사하려고 함수를 그대로 복사하지 않음. 대신 dateRange의 ymd와 같은 날짜 규칙만 확인
import assert from 'node:assert/strict'

const ymd = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

type V = { seq: number; version: number; status: 'ACTIVE' | 'INACTIVE'; appliedAt: string | null }
/** dashboardApi.pickVersions와 같은 규칙: 적용된 것만, 최근 적용 순, to = 다음(더 새) 버전 적용일 */
function pick(versions: V[]) {
  const applied = versions
    .filter((v): v is V & { appliedAt: string } => v.appliedAt !== null)
    .sort((a, b) => Date.parse(b.appliedAt) - Date.parse(a.appliedAt))
  return applied.map((v, i) => ({
    id: String(v.seq),
    from: ymd(new Date(v.appliedAt)),
    to: v.status === 'ACTIVE' || i === 0 ? null : ymd(new Date(applied[i - 1].appliedAt)),
  }))
}

const out = pick([
  { seq: 7, version: 7, status: 'INACTIVE', appliedAt: null }, // 저장만 됨 → 빠짐
  { seq: 4, version: 4, status: 'INACTIVE', appliedAt: '2026-09-01T00:00:00+09:00' },
  { seq: 6, version: 6, status: 'ACTIVE', appliedAt: '2026-10-02T00:00:00+09:00' },
  { seq: 5, version: 5, status: 'INACTIVE', appliedAt: '2026-09-17T00:00:00+09:00' },
])
assert.deepEqual(
  out.map((v) => v.id),
  ['6', '5', '4'],
)
assert.equal(out[0].to, null) // 적용 중
assert.deepEqual([out[1].from, out[1].to], ['2026-09-17', '2026-10-02'])
assert.deepEqual([out[2].from, out[2].to], ['2026-09-01', '2026-09-17'])

console.log('dashboardApi.test.ts OK')
