import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { useBlocker } from 'react-router'
import { useSession } from '@/shared/auth/useSession'
import { DRAFT_TAG } from '@/features/persona/labels'
import { personaQueries, savePromptVersion } from '@/features/persona/api/personaApi'

/** 수정 창이 무엇을 고치는지 — usePersonaPage가 지금 보는 버전으로 정함 */
export interface EditTarget {
  personaSeq: number
  personaName: string
  prompt: string // 시작 글 (지금 보던 버전의 프롬프트)
  basedOn: number // 어느 버전에서 시작했는지
  saveTo: number // 저장하면 생길 새 번호 = 가장 큰 번호 + 1 ('저장 → v8')
}

/** 07 프롬프트 수정 훅 (와이어프레임 07_페르소나관리_수정, 10/31)
 * 화면엔 바로 'v8 · 작성 중' — 저장 전엔 서버에 아무것도 없음. [저장] = 그 번호로 새 버전(저장됨, 통화엔 아직 안 씀)
 * 저장 안 한 글이 있으면 [취소] · 다른 화면 이동 · 탭 닫기를 한 번 막음 */
export function usePromptEditor(target: EditTarget, onDone: (savedVersion?: number) => void) {
  const qc = useQueryClient()
  const { me } = useSession()
  const [text, setText] = useState(target.prompt)
  const [caretLine, setCaretLine] = useState<number | null>(null) // 커서가 있는 줄 (줄 번호 남색)
  const [askingCancel, setAskingCancel] = useState(false)
  const dirty = text !== target.prompt

  const mutation = useMutation({
    mutationFn: () =>
      savePromptVersion(target.personaSeq, {
        prompt: text,
        basedOn: target.basedOn,
        author: me?.loginId ?? '',
      }),
    onSuccess: async (version) => {
      await qc.invalidateQueries({ queryKey: personaQueries.all() })
      onDone(version)
    },
  })

  // 다른 화면으로 가려 하면(사이드바 등) 확인 — 저장 중 · 저장 후엔 막지 않음
  const blocker = useBlocker(dirty && !mutation.isPending && !mutation.isSuccess)
  // 탭 닫기 · 새로고침은 브라우저 기본 확인 창 (문구는 브라우저가 정함)
  useEffect(() => {
    if (!dirty) return
    const warn = (e: BeforeUnloadEvent) => e.preventDefault()
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty])

  return {
    tag: `v${target.saveTo} · ${DRAFT_TAG}`,
    subtitle: `${target.personaName} · v${target.basedOn}에서 시작`,
    text,
    setText,
    lineCount: text.split('\n').length,
    caretLine,
    // 커서 위치(글자 번호) → 몇째 줄인지. 입력 직후엔 아직 이전 글이 state에 있어서, 방금 바뀐 글을 같이 받음
    onCaret: (value: string, pos: number) => setCaretLine(value.slice(0, pos).split('\n').length),
    clearCaret: () => setCaretLine(null),

    saveLabel: mutation.isPending ? '저장 중…' : `저장 → v${target.saveTo}`,
    canSave: dirty && text.trim() !== '' && !mutation.isPending,
    save: () => mutation.mutate(),
    saveError: mutation.error?.message ?? null,

    // [취소]: 바뀐 게 없으면 바로 닫고, 있으면 확인 창. 화면 이동이 막혔을 때도 같은 창
    cancel: () => (dirty ? setAskingCancel(true) : onDone()),
    confirmingDiscard: askingCancel || blocker.state === 'blocked',
    discard: () => {
      setAskingCancel(false)
      if (blocker.state === 'blocked') blocker.proceed()
      else onDone()
    },
    keepEditing: () => {
      setAskingCancel(false)
      if (blocker.state === 'blocked') blocker.reset()
    },
  }
}
