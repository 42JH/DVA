import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { ApiError } from '@/shared/api/client'
import { emptyPromptNotice, PROMPT_SECTIONS, unsupportedText } from '@/features/persona/labels'
import {
  personaQueries,
  PROMPT_KEYS,
  ConfirmError,
  saveVersion,
  type PromptFields,
  type PromptKey,
  type VoiceSettings,
} from '@/features/persona/api/personaApi'
import { useVoiceDraft } from '@/features/persona/hooks/useVoiceDraft'
import { useLeaveGuard } from '@/features/persona/hooks/useLeaveGuard'

/** 수정 창이 무엇을 고치는지 — 늘 그 페르소나의 최신 버전에서 시작: 초안이 있으면 초안, 없으면 HEAD */
export interface EditTarget {
  personaSeq: number
  personaName: string // 시작 이름 — 초안에서 바꿨으면 초안 이름
  prompt: PromptFields // 시작 글 (여섯 칸)
  voice: VoiceSettings // 시작 음성 설정
  basedOn: number // HEAD 번호 = 서버 expectedVersion
  draftRevision: string | null // 초안의 UUID = 서버 expectedDraftRevision (초안이 없으면 null). 그새 누가 저장했으면 409
  saveTo: number // 화면 번호 = HEAD + 1. 몇 번을 저장해도 같은 번호(초안 덮어쓰기)
}

/** 07 프롬프트 수정 · 음성 설정 훅 (와이어프레임 07_페르소나관리_수정 · _음성세부조절, 10/31 · 11/02 실서버)
 * 화면엔 바로 'v5 · 작성 중'. [저장] = PATCH(바뀐 칸만) + 바로 확정 → 새 버전 v5 (통화엔 [통화에 사용하기]로만)
 * 음성 드롭다운은 저장 버튼 없이 바로 반영(작성 중에) → 수정 화면 [저장]으로 같이 저장
 * 저장 안 한 내용이 있으면 [취소] · 다른 화면 이동 · 탭 닫기를 한 번 막음 */
export function usePromptEditor(target: EditTarget, onDone: (savedVersion?: number) => void) {
  const qc = useQueryClient()
  const [name, setName] = useState(target.personaName)
  const [prompt, setPrompt] = useState(target.prompt)
  const voiceDraft = useVoiceDraft(target.voice)
  const { voice, voiceChanged, setVoice } = voiceDraft
  const changedKeys = PROMPT_KEYS.filter((k) => prompt[k] !== target.prompt[k])
  const promptChanged = changedKeys.length > 0
  // 빈 칸은 프롬프트를 고칠 때만 막음 — 음성만 바꾼 저장은 프롬프트를 안 보내니 따로 저장되게 (, 서버는 빈 칸 허용)
  const emptyNotice = promptChanged ? emptyPromptNotice(prompt) : null
  const nameChanged = name.trim() !== target.personaName
  const dirty = nameChanged || promptChanged || voiceChanged

  const mutation = useMutation({
    // 바뀐 칸만 보냄 — 안 바꾼 음성 값(서버의 정확한 숫자 속도 등)은 그대로 둠
    mutationFn: () =>
      saveVersion(target.personaSeq, {
        expectedVersion: target.basedOn,
        expectedDraftRevision: target.draftRevision,
        ...(nameChanged && { name: name.trim() }),
        prompt: Object.fromEntries(changedKeys.map((k) => [k, prompt[k]])), // 바뀐 칸만
        voice: {
          ...(voice.voice !== target.voice.voice && { voice: voice.voice }),
          ...(voice.speed !== target.voice.speed && { speed: voice.speed }),
          ...(voice.waitTime !== target.voice.waitTime && { waitTime: voice.waitTime }),
        },
        rateRange: voiceDraft.rateRange,
      }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: personaQueries.all() })
      onDone(target.saveTo)
    },
    // 확정만 실패하면 초안이 바뀌었으니 다시 받음 → target이 새 초안이 되어 [저장]을 다시 누르면 확정만 감
    onError: (e) => {
      if (e instanceof ConfirmError) void qc.invalidateQueries({ queryKey: personaQueries.all() })
    },
  })

  const guard = useLeaveGuard(dirty, mutation.isPending || mutation.isSuccess, () => onDone())

  return {
    subtitle: target.personaName,
    name,
    setName,
    // 칸마다 고정 제목 + 입력칸 (제목은 못 고침, 줄 번호 없음)
    sections: PROMPT_SECTIONS.map((s) => ({
      ...s,
      value: prompt[s.key],
      empty: prompt[s.key].trim() === '',
    })),
    setField: (key: PromptKey, value: string) => setPrompt((p) => ({ ...p, [key]: value })),
    // 수정 기록 [이 내용 불러오기] — 칸에 채우기만, 기록은 [저장]을 눌러야 남음 (누르자마자 저장한 것처럼 기록에 뜸)
    load: (v: { name: string; prompt: PromptFields; voice: VoiceSettings }) => {
      setName(v.name)
      setPrompt(v.prompt)
      setVoice(v.voice)
    },
    emptyNotice, // 저장이 막힌 이유 — 고친 게 있을 때만 화면에 보이면 됨

    // 음성 드롭다운
    ...voiceDraft,

    dirty, // 고치기 시작하면 머리 줄 버튼이 [취소] [저장]으로
    saveLabel: mutation.isPending ? '저장 중…' : '저장',
    canSave:
      (dirty || target.draftRevision !== null) && // 남은 초안은 고치지 않아도 확정할 수 있게
      name.trim() !== '' &&
      !emptyNotice &&
      !voiceDraft.optionsPending &&
      !mutation.isPending,
    save: () => mutation.mutate(),
    saveError: !mutation.error
      ? null
      : mutation.error instanceof ConfirmError
        ? '저장을 마치지 못했습니다. [저장]을 다시 눌러 주세요.'
        : (unsupportedText(mutation.error) ??
          (mutation.error instanceof ApiError && mutation.error.status === 409
            ? '그새 다른 관리자가 이 상담가를 저장하거나 반영했습니다. 고친 글을 복사해 두고 [취소] 후 최신 내용에서 다시 수정해 주세요.'
            : '저장하지 못했습니다. 잠시 뒤 다시 시도해 주세요.')),

    ...guard, // [취소] · 나가기 확인 창
  }
}
