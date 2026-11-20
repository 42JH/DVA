// 백엔드 DTO 계약 스냅샷 — 서버 Swagger(/api/docs-json, 백엔드 DTO 데코레이터로 만들어짐)에서
// 화면이 보내는 요청 본문의 스키마만 뽑아 src/app/contract/backend-dto.json 으로 저장 → backendContract.test.ts 가 검사
// 사용: npm run sync:dto <서버 주소>   (자체 서명 인증서여도 되게 이 스크립트에서만 검증을 끔)
// 백엔드 DTO가 바뀌면 다시 돌려 커밋 (스냅샷이라 CI는 서버 없이 돎)
import { writeFileSync } from 'node:fs'

const base = process.argv[2] ?? process.env.DTO_SERVER
if (!base) throw new Error('서버 주소가 필요합니다 — npm run sync:dto https://<백엔드 서버>')
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'

/** 화면이 본문을 보내는 요청 — 'METHOD 경로' (경로는 Swagger 그대로) */
const OPS = [
  'POST /api/admin/orders',
  'PATCH /api/orders/{id}',
  'PATCH /api/customers/{id}',
  'POST /api/companies/{id}/members',
  'POST /api/faqs',
  'PATCH /api/faqs/{id}',
]

const spec = await (await fetch(`${base}/api/docs-json`)).json()
const all = spec.components.schemas

// 설명 · 예시는 빼고(크기), 검사에 쓰는 칸만 남김
const KEEP = new Set([
  '$ref',
  'type',
  'nullable',
  'enum',
  'properties',
  'required',
  'items',
  'allOf',
  'oneOf',
  'minimum',
  'maximum',
  'minLength',
  'maxLength',
  'minItems',
  'maxItems',
  'pattern',
  'format',
])
const used = new Set()
function slim(s) {
  if (Array.isArray(s)) return s.map(slim)
  if (!s || typeof s !== 'object') return s
  const out = {}
  for (const [k, v] of Object.entries(s)) {
    if (!KEEP.has(k)) continue
    if (k === '$ref') used.add(v.split('/').pop())
    out[k] =
      k === 'properties'
        ? Object.fromEntries(Object.entries(v).map(([p, ps]) => [p, slim(ps)]))
        : slim(v)
  }
  return out
}

const operations = {}
for (const op of OPS) {
  const [method, path] = op.split(' ')
  const schema =
    spec.paths[path]?.[method.toLowerCase()]?.requestBody?.content?.['application/json']?.schema
  if (!schema) throw new Error(`서버 명세에 없음: ${op}`)
  operations[op] = slim(schema)
}
const schemas = {}
for (const seen = new Set(); [...used].some((n) => !seen.has(n));)
  for (const n of [...used]) if (!seen.has(n)) (seen.add(n), (schemas[n] = slim(all[n])))

const out = { source: '/api/docs-json', version: spec.info?.version, operations, schemas }
writeFileSync(
  new URL('../src/app/contract/backend-dto.json', import.meta.url),
  JSON.stringify(out, null, 2) + '\n',
)
console.log(`backend-dto.json — 요청 ${OPS.length}개 · 스키마 ${Object.keys(schemas).length}개`)
