import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { useBlocker } from 'react-router'
import { ApiError } from '@/shared/api/client'
import {
  DRAFT_TAG,
  emptyPromptNotice,
  PROMPT_SECTIONS,
  unsupportedText,
} from '@/features/persona/labels'
import {
  personaQueries,
  PROMPT_KEYS,
  saveDraft,
  type PromptFields,
  type PromptKey,
  type VoiceSettings,
} from '@/features/persona/api/personaApi'
import { useVoiceOptions } from '@/features/persona/hooks/useVoiceOptions'

/** 수정 창이 무엇을 고치는지 — 늘 그 페르소나의 최신 버전에서 시작: 초안이 있으면 초안, 없으면 HEAD (11/02 결정) */
export interface EditTarget {
  personaSeq: number
  personaName: string
  prompt: PromptFields // 시작 글 (여섯 칸)
  voice: VoiceSettings // 시작 음성 설정
  basedOn: number // HEAD 번호 = 서버 expectedVersion
  draftRevision: string | null // 초안의 UUID = 서버 expectedDraftRevision (초안이 없으면 null). 그새 누가 저장했으면 409
  saveTo: number // 화면 번호 = HEAD + 1. 몇 번을 저장해도 같은 번호(초안 덮어쓰기)
}

const SAMPLE = '받는 분 번호 공일공, 이삼사오, 육칠팔구 맞으실까요?' // 미리 듣기 문장 (와이어프레임 그대로)
// shortcut: 미리 듣기는 브라우저 음성(speechSynthesis)으로 속도만 흉내 — 실제 목소리(marin 등) · 기다리기는 BE TTS 음성 파일로 바꿀 것
const RATE: Record<VoiceSettings['speed'], number> = { SLOW: 0.85, NORMAL: 1, FAST: 1.2 }

/** 07 프롬프트 수정 · 음성 세부 조절 훅 (와이어프레임 07_페르소나관리_수정 · _음성세부조절, 10/31 · 11/02 실서버)
 * 화면엔 바로 'v5 · 작성 중'. [저장] = PATCH(바뀐 칸만) → 초안 덮어쓰기('v5 저장됨', 통화엔 아직 안 씀). 다시 고쳐 저장해도 v5
 * 음성 세부 조절 창은 저장 버튼 없이 바로 반영(작성 중에) → 수정 화면 [저장]으로 같이 저장
 * 저장 안 한 내용이 있으면 [취소] · 다른 화면 이동 · 탭 닫기를 한 번 막음 */
export function usePromptEditor(target: EditTarget, onDone: (savedVersion?: number) => void) {
  const qc = useQueryClient()
  const options = useVoiceOptions()
  const [prompt, setPrompt] = useState(target.prompt)
  const [voice, setVoice] = useState(target.voice)
  const [voiceOpen, setVoiceOpen] = useState(false)
  const [askingCancel, setAskingCancel] = useState(false)
  const afterLeave = useRef<(() => void) | undefined>(undefined) // 확인 창에서 [나가기]를 누르면 할 일 (패널에서 고른 페르소나 · 버전 보기)
  const changedKeys = PROMPT_KEYS.filter((k) => prompt[k] !== target.prompt[k])
  const promptChanged = changedKeys.length > 0
  // 빈 칸은 프롬프트를 고칠 때만 막음 — 음성만 바꾼 저장은 프롬프트를 안 보내니 따로 저장되게 (11/11 사용자, 서버는 빈 칸 허용)
  const emptyNotice = promptChanged ? emptyPromptNotice(prompt) : null
  const voiceChanged =
    voice.voice !== target.voice.voice ||
    voice.speed !== target.voice.speed ||
    voice.waitTime !== target.voice.waitTime
  const dirty = promptChanged || voiceChanged

  const mutation = useMutation({
    // 바뀐 칸만 보냄 — 안 바꾼 음성 값(서버의 정확한 숫자 속도 등)은 그대로 둠
    mutationFn: () =>
      saveDraft(target.personaSeq, {
        expectedVersion: target.basedOn,
        expectedDraftRevision: target.draftRevision,
        prompt: Object.fromEntries(changedKeys.map((k) => [k, prompt[k]])), // 바뀐 칸만
        voice: {
          ...(voice.voice !== target.voice.voice && { voice: voice.voice }),
          ...(voice.speed !== target.voice.speed && { speed: voice.speed }),
          ...(voice.waitTime !== target.voice.waitTime && { waitTime: voice.waitTime }),
        },
        rateRange: options.rateRange,
      }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: personaQueries.all() })
      onDone(target.saveTo)
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
  useEffect(() => () => window.speechSynthesis?.cancel(), []) // 화면을 떠나면 미리 듣기 멈춤

  function leave(then?: () => void) {
    if (!dirty) {
      onDone()
      return then?.()
    }
    afterLeave.current = then
    setAskingCancel(true)
  }

  return {
    tag: `v${target.saveTo} · ${DRAFT_TAG}`,
    subtitle: `${target.personaName} · v${target.basedOn}에서 시작`,
    // 칸마다 고정 제목 + 입력칸 (11/10 — 제목은 못 고침, 줄 번호 없음)
    sections: PROMPT_SECTIONS.map((s) => ({
      ...s,
      value: prompt[s.key],
      empty: prompt[s.key].trim() === '',
    })),
    setField: (key: PromptKey, value: string) => setPrompt((p) => ({ ...p, [key]: value })),
    emptyNotice, // 저장이 막힌 이유 — 고친 게 있을 때만 화면에 보이면 됨

    // 음성 세부 조절 창
    voiceOpen,
    openVoice: () => setVoiceOpen(true),
    closeVoice: () => {
      window.speechSynthesis?.cancel()
      setVoiceOpen(false)
    },
    voiceTitle: `v${target.saveTo} ${DRAFT_TAG}`,
    voiceChanged, // '음성 설정 바뀜' 태그
    voice,
    voiceOptions: options.voiceOptions(voice.voice),
    setVoiceName: (x: string) => setVoice((v) => ({ ...v, voice: x })),
    speedOptions: options.speedOptions(voice.speed),
    setSpeed: (speed: VoiceSettings['speed']) => setVoice((v) => ({ ...v, speed })),
    waitOptions: options.waitOptions(voice.waitTime),
    setWaitTime: (waitTime: VoiceSettings['waitTime']) => setVoice((v) => ({ ...v, waitTime })),
    sample: SAMPLE,
    canPreview: typeof window !== 'undefined' && 'speechSynthesis' in window,
    preview: () => {
      window.speechSynthesis.cancel()
      const u = new SpeechSynthesisUtterance(SAMPLE)
      u.lang = 'ko-KR'
      u.rate = RATE[voice.speed]
      window.speechSynthesis.speak(u)
    },

    saveLabel: mutation.isPending ? '저장 중…' : `저장 → v${target.saveTo}`,
    canSave: dirty && !emptyNotice && !options.isPending && !mutation.isPending,
    save: () => mutation.mutate(),
    saveError: !mutation.error
      ? null
      : (unsupportedText(mutation.error) ??
        (mutation.error instanceof ApiError && mutation.error.status === 409
          ? '그새 다른 관리자가 이 상담가를 저장 · 적용했습니다. 고친 글을 복사해 두고 [취소] 후 최신 버전에서 다시 수정해 주세요.'
          : '저장하지 못했습니다. 잠시 뒤 다시 시도해 주세요.')),

    // [취소] · 패널에서 다른 페르소나 · 버전 고르기: 바뀐 게 없으면 바로 나가고(then), 있으면 확인 창. 화면 이동이 막혔을 때도 같은 창
    leave,
    cancel: () => leave(),
    confirmingDiscard: askingCancel || blocker.state === 'blocked',
    discard: () => {
      setAskingCancel(false)
      if (blocker.state === 'blocked') return blocker.proceed()
      onDone()
      afterLeave.current?.()
    },
    keepEditing: () => {
      setAskingCancel(false)
      afterLeave.current = undefined
      if (blocker.state === 'blocked') blocker.reset()
    },
  }
}
