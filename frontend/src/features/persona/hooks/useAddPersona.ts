import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'

import { ApiError } from '@/shared/api/client'
import {
  DEFAULT_VOICE,
  createPersona,
  personaQueries,
  PROMPT_KEYS,
  type PromptFields,
  type PromptKey,
} from '@/features/persona/api/personaApi'
import { useLeaveGuard } from '@/features/persona/hooks/useLeaveGuard'
import { useVoiceDraft } from '@/features/persona/hooks/useVoiceDraft'
import {
  DRAFT_TAG,
  emptyPromptNotice,
  PROMPT_SECTIONS,
  unsupportedText,
} from '@/features/persona/labels'

// Swagger 등록 API의 code(바꿀 수 없는 고유 코드)는 화면에서 받지 않고 자동으로 (10/31 결정 — 관리자가 정할 이유가 없음)
// 화면을 열 때 한 번 만들어 재시도에도 같은 값 → 첫 요청이 사실 성공했으면 두 번째는 409(중복)로 막혀 페르소나가 둘 생기지 않음
// shortcut: 코드가 AI 쪽에서 의미 있는 값인지 BE 확인 중 (backend-todo 6) — 의미가 있으면 칸을 되살리거나 서버가 만들게
// UUID 전체(122비트 무작위)를 씀: 8자로 자르면 43억 가지라 드물게 겹칠 수 있고, 겹치면 칸이 없어 관리자가 고칠 길이 없음
// (Swagger code에 길이 제한 없음) → 409는 '아까 보낸 요청이 이미 성공함' 한 가지 뜻만 남음
const newCode = () => `persona-${crypto.randomUUID()}`

/** 07 상담가 등록 훅 — 이름 · 프롬프트 → v1 저장(아직 적용 안 함, Swagger POST /api/personas)
 * 수정 화면과 같은 넓은 화면(PersonaForm)이라 반환 모양도 usePromptEditor와 같게 (11/11)
 * 음성은 기본값에서 시작, 수정 화면처럼 이름 아래 드롭다운에서 고름 (11/11 사용자)
 * 만든 뒤엔 그 페르소나를 골라 보여 줌. 통화에 쓰려면 시험 통화 → [적용] 또는 [사용하기] */
export function useAddPersona(onDone: (personaSeq: number) => void, onClose: () => void) {
  const qc = useQueryClient()
  const [name, setName] = useState('')
  const [code] = useState(newCode)
  const [prompt, setPrompt] = useState<PromptFields>({
    role: '',
    personality: '',
    tone: '',
    speedInstruction: '',
    backchannel: '',
    interruption: '',
  })
  const [triedSubmit, setTriedSubmit] = useState(false) // [등록]을 한 번 눌렀는지 — 빈칸 안내는 그 뒤부터 (11/10)
  const emptyNotice = emptyPromptNotice(prompt)
  const voiceDraft = useVoiceDraft(DEFAULT_VOICE)
  const dirty =
    name.trim() !== '' ||
    PROMPT_KEYS.some((k) => prompt[k].trim() !== '') ||
    voiceDraft.voiceChanged

  const mutation = useMutation({
    mutationFn: () =>
      createPersona({
        code,
        name: name.trim(),
        prompt,
        voice: voiceDraft.voice,
        rateRange: voiceDraft.rateRange,
      }),
    onSuccess: async (personaSeq) => {
      await qc.invalidateQueries({ queryKey: personaQueries.all() })
      onDone(personaSeq)
    },
  })
  const guard = useLeaveGuard(dirty, mutation.isPending || mutation.isSuccess, onClose)

  return {
    tag: DRAFT_TAG,
    subtitle: '새 상담가 · 통화에 쓰려면 등록 뒤 시험 통화를 하고 적용하세요',
    name,
    setName,
    sections: PROMPT_SECTIONS.map((s) => ({
      ...s,
      value: prompt[s.key],
      empty: prompt[s.key].trim() === '',
    })),
    setField: (key: PromptKey, value: string) => setPrompt((p) => ({ ...p, [key]: value })),
    emptyNotice: triedSubmit ? emptyNotice : null, // 처음부터 띄우면 여섯 칸 다 비어 있어 시끄러움

    // 음성 드롭다운
    ...voiceDraft,

    saveLabel: mutation.isPending ? '등록 중…' : '등록',
    canSave: name.trim() !== '' && !voiceDraft.optionsPending && !mutation.isPending, // 빈칸은 막지 않고 누르면 안내
    save: () => {
      setTriedSubmit(true)
      if (!emptyNotice) mutation.mutate()
    },
    saveError: !mutation.error
      ? null
      : (unsupportedText(mutation.error) ??
        (mutation.error instanceof ApiError && mutation.error.status === 409
          ? '이미 등록됐을 수 있습니다. [취소] 후 목록을 확인해 주세요.' // 코드가 겹칠 일은 사실상 없음 → 첫 요청이 성공한 것
          : '등록하지 못했습니다. 잠시 뒤 다시 시도해 주세요.')),

    ...guard, // [취소] · 나가기 확인 창
  }
}
