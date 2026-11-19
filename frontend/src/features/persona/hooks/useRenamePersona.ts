import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { ApiError } from '@/shared/api/client'
import { unsupportedText } from '../labels'
import { personaQueries, requestApply, saveVersion } from '../api/personaApi'
import type { EditTarget } from './usePromptEditor'
import { useVoiceOptions } from './useVoiceOptions'

/** 07 이름 연필 — 이름 자리가 입력 칸으로만 바뀜
 * Enter = 이름만 새 버전으로 저장, Esc · 칸 밖 = 원래 이름. target이 null이면(권한 없음 · 지난 버전) 연필 없음
 * applyAfter: 통화에 쓰는 상담가이고 반영 전 내용이 없을 때 — 이름만 바뀐 버전이라 시험할 것이 없으니 바로 반영 (이름만 바뀌고 띠 없음) */
export function useRenamePersona(target: EditTarget | null, applyAfter = false) {
  const qc = useQueryClient()
  const options = useVoiceOptions() // saveVersion이 받는 값 — 이름만 보내도 형식상 필요
  const [draft, setDraft] = useState<string | null>(null) // null = 안 고치는 중
  const mutation = useMutation({
    mutationFn: (name: string) =>
      saveVersion(target!.personaSeq, {
        expectedVersion: target!.basedOn,
        expectedDraftRevision: target!.draftRevision,
        name,
        prompt: {},
        voice: {},
        rateRange: options.rateRange,
      }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: personaQueries.all() })
      const p = qc
        .getQueryData(personaQueries.list().queryKey)
        ?.find((x) => x.personaSeq === target!.personaSeq)
      if (applyAfter && p) {
        // 실패하면 반영 전 띠가 남음 — 띠의 [통화에 반영]이 시험 없이 다시 보냄 (usePersonaPage sameTalk)
        await requestApply(p.personaSeq, p.head).catch(() => {})
        await qc.invalidateQueries({ queryKey: personaQueries.all() })
      }
      setDraft(null)
    },
  })
  const name = draft?.trim() ?? ''

  return {
    canRename: target !== null,
    renaming: draft !== null,
    draft: draft ?? '',
    setDraft,
    start: () => {
      mutation.reset()
      setDraft(target?.personaName ?? '')
    },
    // Esc · 칸 밖 — 저장 중이면 기다림 (끝나면 새 이름으로 닫힘)
    stop: () => {
      if (!mutation.isPending) setDraft(null)
    },
    submit: () => {
      if (!target || mutation.isPending) return
      // 비었거나 그대로면 저장할 게 없음 (서버는 빈 저장을 400으로 거절) → 원래 이름으로
      if (!name || name === target.personaName) return setDraft(null)
      mutation.mutate(name)
    },
    pending: mutation.isPending,
    error: !mutation.error
      ? null
      : (unsupportedText(mutation.error) ??
        (mutation.error instanceof ApiError && mutation.error.status === 409
          ? '그새 다른 관리자가 이 상담가를 저장했습니다. Esc로 닫고 다시 시도해 주세요.'
          : '이름을 바꾸지 못했습니다. 잠시 뒤 다시 시도해 주세요.')),
  }
}
