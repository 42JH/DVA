import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { useBlocker } from 'react-router'
import { useSession } from '@/shared/auth/useSession'
import type { Option } from '@/shared/ui'
import { DRAFT_TAG, SPEED_CHOICE, WAIT_CHOICE } from '@/features/persona/labels'
import {
  VOICES,
  personaQueries,
  savePromptVersion,
  type Speed,
  type VoiceSettings,
  type WaitTime,
} from '@/features/persona/api/personaApi'

/** 수정 창이 무엇을 고치는지 — usePersonaPage가 지금 보는 버전으로 정함 */
export interface EditTarget {
  personaSeq: number
  personaName: string
  prompt: string // 시작 글 (지금 보던 버전의 프롬프트)
  voice: VoiceSettings // 시작 음성 설정 (지금 보던 버전의 것)
  basedOn: number // 어느 버전에서 시작했는지
  saveTo: number // 저장하면 생길 새 번호 = 가장 큰 번호 + 1 ('저장 → v8')
  voiceFirst: boolean // 보기 화면의 [음성 세부 조절]로 들어왔으면 음성 창부터 열기
}

const SAMPLE = '받는 분 번호 공일공, 이삼사오, 육칠팔구 맞으실까요?' // 미리 듣기 문장 (와이어프레임 그대로)
// shortcut: 미리 듣기는 브라우저 음성(speechSynthesis)으로 속도만 흉내 — 실제 목소리(marin 등) · 기다리기는 BE TTS 음성 파일로 바꿀 것
const RATE: Record<Speed, number> = { SLOW: 0.85, NORMAL: 1, FAST: 1.2 }

/** 무엇을 바꿨는지 한 줄 (버전 히스토리 요약) — 디자인에 요약 칸이 없어 자동으로: '프롬프트 수정, 발화 속도 보통 → 빠르게' */
function summaryOf(promptChanged: boolean, from: VoiceSettings, to: VoiceSettings): string {
  return [
    promptChanged && '프롬프트 수정',
    from.voice !== to.voice && `목소리 ${from.voice} → ${to.voice}`,
    from.speed !== to.speed && `발화 속도 ${SPEED_CHOICE[from.speed]} → ${SPEED_CHOICE[to.speed]}`,
    from.waitTime !== to.waitTime &&
      `말 끝 기다리기 ${WAIT_CHOICE[from.waitTime]} → ${WAIT_CHOICE[to.waitTime]}`,
  ]
    .filter(Boolean)
    .join(', ')
}

/** 07 프롬프트 수정 · 음성 세부 조절 훅 (와이어프레임 07_페르소나관리_수정 · _음성세부조절, 10/31)
 * 화면엔 바로 'v8 · 작성 중' — 저장 전엔 서버에 아무것도 없음. [저장] = 프롬프트 + 음성 설정을 그 번호로 새 버전(저장됨, 통화엔 아직 안 씀)
 * 음성 세부 조절 창은 저장 버튼 없이 바로 반영(작성 중에) → 수정 화면 [저장]으로 같이 저장
 * 저장 안 한 내용이 있으면 [취소] · 다른 화면 이동 · 탭 닫기를 한 번 막음 */
export function usePromptEditor(target: EditTarget, onDone: (savedVersion?: number) => void) {
  const qc = useQueryClient()
  const { me } = useSession()
  const [text, setText] = useState(target.prompt)
  const [voice, setVoice] = useState(target.voice)
  const [voiceOpen, setVoiceOpen] = useState(target.voiceFirst)
  const [caretLine, setCaretLine] = useState<number | null>(null) // 커서가 있는 줄 (줄 번호 남색)
  const [askingCancel, setAskingCancel] = useState(false)
  const promptChanged = text !== target.prompt
  const voiceChanged =
    voice.voice !== target.voice.voice ||
    voice.speed !== target.voice.speed ||
    voice.waitTime !== target.voice.waitTime
  const dirty = promptChanged || voiceChanged

  const mutation = useMutation({
    mutationFn: () =>
      savePromptVersion(target.personaSeq, {
        prompt: text,
        voice,
        basedOn: target.basedOn,
        author: me?.loginId ?? '',
        summary: summaryOf(promptChanged, target.voice, voice),
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
  useEffect(() => () => window.speechSynthesis?.cancel(), []) // 화면을 떠나면 미리 듣기 멈춤

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
    voiceOptions: VOICES.map((x) => ({ value: x, label: x })),
    setVoiceName: (x: string) => setVoice((v) => ({ ...v, voice: x })),
    speedOptions: (Object.keys(SPEED_CHOICE) as Speed[]).map((k): Option<Speed> => ({
      value: k,
      label: SPEED_CHOICE[k],
    })),
    setSpeed: (speed: Speed) => setVoice((v) => ({ ...v, speed })),
    waitOptions: (Object.keys(WAIT_CHOICE) as WaitTime[]).map((k): Option<WaitTime> => ({
      value: k,
      label: WAIT_CHOICE[k],
    })),
    setWaitTime: (waitTime: WaitTime) => setVoice((v) => ({ ...v, waitTime })),
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
