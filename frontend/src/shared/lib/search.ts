// 검색 규칙 (10/30 결정, 04 · 09 · 01 홈 공통) — 띄어쓰기 · 대소문자 무시 + 초성 검색
//   '수거시간' = '수거 시간' · 'ㅅㄱ' → 수거 · 'ㄱㄷㅇ' → 강도윤 · 섞어도 됨 '수ㄱ'
//   치는 중인 마지막 글자도 맞게 (한글 조합 중에 목록이 잠깐 비지 않게):
//   받침 전 '강도유' → 강도윤, 다음 글자 첫소리가 받침으로 잠깐 붙은 '강동' → 강도윤 · '숙' → 수거 (다음 글자 첫소리가 같을 때만)
// 주의: BE가 검색하게 되면(04 목록 등) BE도 같은 규칙이어야 같은 결과 — 화면에서 거르는 동안만 여기서 보장
const CHO = 'ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ'
// 받침 번호(0~27) → 그 받침이 다음 글자 첫소리가 될 때의 초성. 빈칸 = 받침 없음 · 겹받침(그대로 비교)
const JONG_AS_CHO = ' ㄱㄲ ㄴ  ㄷㄹ       ㅁㅂ ㅅㅆㅇㅈㅊㅋㅌㅍㅎ'
const BASE = 0xac00 // '가'
const SYLLABLES = 11172 // '가' ~ '힣'

const norm = (s: string) => s.replace(/\s+/g, '').toLowerCase()
const syllable = (c: string | undefined) => {
  const n = c === undefined ? -1 : c.charCodeAt(0) - BASE
  return n >= 0 && n < SYLLABLES ? n : -1
}
const choOf = (n: number) => CHO[Math.floor(n / 588)]

/** 글자 하나 비교 — q가 초성이면 초성만. 마지막 글자면 치는 중인 모양도 (next = text의 다음 글자) */
function same(t: string, q: string, last: boolean, next: string | undefined): boolean {
  if (t === q) return true
  const tn = syllable(t)
  if (tn < 0) return false
  if (CHO.includes(q)) return choOf(tn) === q
  const qn = syllable(q)
  if (!last || qn < 0) return false
  const jong = qn % 28
  if (jong === 0) return tn - (tn % 28) === qn // 받침 전
  const nn = syllable(next)
  return tn === qn - jong && nn >= 0 && JONG_AS_CHO[jong] === choOf(nn) // 받침이 다음 글자 첫소리
}

/** text 안에서 query에 맞는 자리들 [시작, 끝) — 원래 글(띄어쓰기 포함) 기준이라 하이라이트에 그대로 씀 (09 FAQ, 11/04) */
export function findKo(text: string, query: string): [number, number][] {
  const q = norm(query)
  if (!q) return []
  let t = '' // 띄어쓰기 뺀 소문자 글
  const at: number[] = [] // t의 글자 → text 자리
  for (let i = 0; i < text.length; i++) {
    if (/\s/.test(text[i])) continue
    const c = text[i].toLowerCase()
    t += c.length === 1 ? c : text[i] // 소문자가 두 글자로 바뀌는 문자는 그대로 (자리가 어긋나지 않게)
    at.push(i)
  }
  const hits: [number, number][] = []
  for (let i = 0; i + q.length <= t.length; i++) {
    let ok = true
    for (let j = 0; ok && j < q.length; j++)
      ok = same(t[i + j], q[j], j === q.length - 1, t[i + j + 1])
    if (ok) {
      hits.push([at[i], at[i + q.length - 1] + 1])
      i += q.length - 1 // 겹치지 않게 다음 자리부터
    }
  }
  return hits
}

/** text 안에 query가 들어 있나 (빈 검색어는 다 맞음) */
export function matchKo(text: string, query: string): boolean {
  return !norm(query) || findKo(text, query).length > 0
}

/** 전화번호로 찾을 숫자 — 검색어가 숫자 · 하이픈 · 띄어쓰기로만 돼 있을 때만 ('3시'처럼 글자에 섞인 숫자로 번호를 찾지 않게) */
export function phoneDigits(query: string): string {
  return /^[\d\s-]+$/.test(query.trim()) ? query.replace(/\D/g, '') : ''
}

/** 추천 목록 — texts 중 검색어에 맞는 것, 같은 글 한 번만, 검색어와 똑같은 건 빼고 최대 n개 (순서는 texts 순서) */
export function suggest(texts: string[], query: string, n = 5): string[] {
  if (!norm(query)) return []
  const out: string[] = []
  for (const t of texts) {
    if (out.length >= n) break
    if (t !== query.trim() && !out.includes(t) && matchKo(t, query)) out.push(t)
  }
  return out
}
