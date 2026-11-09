// 고객 용건 칩 — 서버의 상담 유형 횟수(접수 · 조회 · 취소 · FAQ)를 처음 보는 사람도 읽히는 말로
// (기업 피드백: '접수 4' · '조회' · 'FAQ'만으로는 무엇인지 모르겠다). 옛 화면은 shared/lib/callKind 그대로
import { KINDS, type CallKind, type KindCounts } from './callKind'

const LOOK: Record<CallKind, { label: (n: number) => string; title: (n: number) => string }> = {
  accept: {
    label: (n) => `택배 접수 ${n}건`,
    title: (n) => `이 통화에서 택배 ${n}건을 새로 접수했습니다.`,
  },
  // 서버 값은 '주문 조회 횟수' — 배송 위치만이 아니라 접수 내용 확인도 섞여 있어 넓게 '주문 확인'
  lookup: {
    label: (n) => `주문 확인 ${n}번`,
    title: (n) => `이미 접수한 주문을 ${n}번 확인했습니다.`,
  },
  cancel: {
    label: (n) => `접수 취소 ${n}건`,
    title: (n) => `접수했던 택배 ${n}건을 취소했습니다.`,
  },
  faq: {
    label: (n) => `문의 ${n}번`,
    title: (n) => `이용 방법 등을 ${n}번 묻고 AI가 답했습니다.`,
  },
}

interface KindChip {
  kind: CallKind
  label: string
  title: string
}

/** 이 통화에서 한 것만 (0번은 뺌) */
export const callKinds = (counts: KindCounts): KindChip[] =>
  KINDS.flatMap((kind) => {
    const n = counts?.[kind] ?? 0
    return n > 0 ? [{ kind, label: LOOK[kind].label(n), title: LOOK[kind].title(n) }] : []
  })
