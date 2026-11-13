// 띠의 단계 · 확인 창 문구 — 순수 함수 (personaBand.test.ts). 상태는 usePersonaPage가 모아 넘김

/** 띠의 단계 (11/13 새 안 1번) — unapplied 반영 전 · testing 시험 중 · applying 반영 중
 *  stopped = 시험을 멈춤(2번) — [통화에 반영] 대신 [다시 시험하고 반영], 입력 칸은 다시 열림
 *  review = 시험이 끝났는데 실패가 있음(4번) — 바로 반영하지 않고 담당자가 [확인하고 반영]
 *  passed = 6번 시험 통과 — 띠의 [통화에 사용하기]. null = 띠 없음 */
export type BandStep = 'unapplied' | 'testing' | 'stopped' | 'review' | 'applying' | 'passed' | null

/** 확인 창을 띄운 까닭 — [통화에 사용하기] · [삭제] · 수정 기록 창 [이 내용 불러오기](reuse — 확인 창 없이 바로) · 띠의 버튼 셋 */
export type Confirming =
  | { kind: 'use'; personaSeq: number }
  | { kind: 'reuse'; version: number }
  | { kind: 'delete'; personaSeq: number }
  | { kind: 'test' } // 띠의 [통화에 반영] — 시험하고 반영 (모두 통과면 저절로 반영)
  | { kind: 'stop' } // 띠의 [시험 중단] (2번)
  | { kind: 'review' } // 확인 필요 띠의 [확인하고 반영] (4번) — 실패를 보고도 반영
  | null

/** 띠가 어느 단계인가
 *  switching = 통화에 안 쓰는 상담가(6번) · unapplied = 사용 중 상담가의 고친 내용이 아직 통화에 안 쓰임 — 둘 다 아니면 띠 없음
 *  연결 실패가 섞인 일부 시험(partial)도 실패가 있으면 확인 필요 (피그마 3 · 4번: 통과 7 · 실패 2 · 연결 실패 1)
 *  6번의 실패 · 중단은 4번 확인 필요 · 2번 시험 중단 띠를 그대로 (11/13 사용자). 6번은 시험 전이면 띠 없음 */
export function bandStep(
  who: { applying: boolean; switching: boolean; unapplied: boolean },
  test: { state: string; allPass: boolean; stopped: unknown; fail: number },
): BandStep {
  if (who.applying) return 'applying'
  if (!who.switching && !who.unapplied) return null
  if (test.state === 'running') return 'testing'
  if (who.switching && test.allPass) return 'passed'
  if (test.stopped) return 'stopped'
  if ((test.state === 'done' || test.state === 'partial') && test.fail > 0) return 'review'
  return who.switching ? null : 'unapplied'
}

// '친절 안내형을' · '빠른 접수형이' — 이름 끝 글자의 받침으로 을/를 · 이/가
const hasBatchim = (name: string) => {
  const c = name.charCodeAt(name.length - 1) - 0xac00
  return c >= 0 && c < 11172 && c % 28 !== 0
}
const nameEul = (name: string) => `${name}${hasBatchim(name) ? '을' : '를'}`
export const nameI = (name: string) => `${name}${hasBatchim(name) ? '이' : '가'}`

type Who = { name: string; inUse: boolean }

export interface ConfirmCopy {
  title: string
  note: string
  okLabel: string
  danger?: boolean // 확인 버튼을 빨간색으로
  failed?: string[] // 실패한 시나리오 이름 — 확인하고 반영 창 (4번, 피그마 2368:5978)
}

/** '다음 통화부터 빠른 접수형 대신 친절형이 응대합니다. 지금 통화 중인 2건은 바뀌지 않습니다.' */
const switchNote = (to: string, from: string | null, liveCalls: number | null) =>
  `다음 통화부터 ${from ? `${from} 대신 ` : ''}${nameI(to)} 응대합니다.${liveCalls ? ` 지금 통화 중인 ${liveCalls}건은 바뀌지 않습니다.` : ''}`

/** 확인 창의 글 — 그새 상태가 바뀌어 물을 것이 없으면 null (창이 닫힘) */
export function confirmCopy(
  confirming: Confirming,
  s: {
    step: BandStep
    current: Who | null // 탭에서 고른 상담가
    inUseName: string | null // 통화에 쓰는 상담가
    liveCalls: number | null
    sameTalk: boolean // 고친 내용의 프롬프트 · 목소리가 통화에 쓰는 내용과 같음
    test: { failed: string[]; toRun: number; resume: boolean; allPass: boolean; total: number }
    find: (personaSeq: number) => Who | undefined
  },
): ConfirmCopy | null {
  const other = s.current && !s.current.inUse ? s.current : null // 6번 — 통화에 안 쓰는 상담가를 보는 중
  switch (confirming?.kind) {
    case 'review': {
      if (s.step !== 'review') return null // 그새 반영 · 다시 고침
      const failed = s.test.failed
      // 6번 — 마지막 확인은 사용 확인 창 모양 그대로 + 실패 이름
      if (other)
        return {
          title: `실패한 시나리오 ${failed.length}개가 있습니다. ${nameEul(other.name)} 통화에 사용할까요?`,
          note: switchNote(other.name, s.inUseName, s.liveCalls),
          okLabel: '사용하기',
          failed,
        }
      return {
        title: `실패한 시나리오 ${failed.length}개가 있습니다. 통화에 반영할까요?`,
        note: '반영하면 다음 통화부터 고친 내용으로 응대합니다.',
        okLabel: '반영',
        failed,
      }
    }
    case 'delete': {
      const p = s.find(confirming.personaSeq)
      if (!p) return null
      return {
        title: `${nameEul(p.name)} 삭제할까요?`,
        note: '삭제하면 되돌릴 수 없습니다.',
        okLabel: '삭제',
        danger: true,
      }
    }
    case 'stop':
      if (s.step !== 'testing') return null // 그새 시험이 끝남
      return {
        title: '시험을 중단할까요?',
        note: '지금까지 돌린 결과는 남습니다. 통화에는 반영되지 않고, 다시 시험해야 반영할 수 있습니다.',
        okLabel: '중단',
        danger: true,
      }
    case 'test': {
      const runs = s.test.resume
        ? `남은 시나리오 ${s.test.toRun}개를`
        : `시나리오 ${s.test.toRun}개를 모두`
      if (other)
        return {
          title: `통화에 쓰기 전에 ${nameEul(other.name)} 시험할까요?`,
          note: `${runs} 돌린 뒤, 결과를 보고 통화에 사용할지 정합니다.`,
          okLabel: '시험 시작',
        }
      return {
        title: '시험하고 통화에 반영할까요?',
        note: `${runs} 돌립니다. 모두 통과하면 바로 반영하고, 실패가 있으면 결과를 확인한 뒤 반영할 수 있습니다.`,
        okLabel: '시험하고 반영',
      }
    }
    case 'use': {
      const p = s.find(confirming.personaSeq)
      if (!p) return null
      // 다른 상담가로 바꾸기 — 6번 시험 통과 뒤 (피그마 6번 줄 '통화에 사용 확인') · 시나리오 시험이 꺼진 환경
      if (!p.inUse)
        return {
          title: `${nameEul(p.name)} 통화에 사용할까요?`,
          note: switchNote(p.name, s.inUseName, s.liveCalls),
          okLabel: '사용하기',
        }
      // 사용 중 상담가의 고친 내용을 시험 없이 반영 — 프롬프트 · 목소리가 그대로 · 이미 모두 통과(시험 화면에서 따로 돌림) · 시나리오 시험이 꺼진 환경
      return {
        title: '통화에 반영할까요?',
        note: s.sameTalk
          ? '프롬프트와 목소리가 통화에 쓰는 내용과 같아 시험 없이 반영합니다.'
          : `${s.test.allPass ? `시나리오 ${s.test.total}개를 모두 통과했습니다. ` : ''}반영하면 다음 통화부터 고친 내용으로 응대합니다.`,
        okLabel: '반영',
      }
    }
    default:
      return null // reuse는 확인 창 없이 바로
  }
}
