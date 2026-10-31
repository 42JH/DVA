import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'

import { ApiError } from '@/shared/api/client'
import { useSession } from '@/shared/auth/useSession'
import type { Option } from '@/shared/ui'
import { SPEED_CHOICE, WAIT_CHOICE } from '@/features/persona/labels'
import {
  DEFAULT_VOICE,
  VOICES,
  createPersona,
  personaQueries,
  type Speed,
  type WaitTime,
} from '@/features/persona/api/personaApi'

// Swagger 등록 API의 code(바꿀 수 없는 고유 코드)는 화면에서 받지 않고 자동으로 (10/31 결정 — 관리자가 정할 이유가 없음)
// 창을 열 때 한 번 만들어 재시도에도 같은 값 → 첫 요청이 사실 성공했으면 두 번째는 409(중복)로 막혀 페르소나가 둘 생기지 않음
// shortcut: 코드가 AI 쪽에서 의미 있는 값인지 BE 확인 중 (backend-todo 6) — 의미가 있으면 칸을 되살리거나 서버가 만들게
// UUID 전체(122비트 무작위)를 씀: 8자로 자르면 43억 가지라 드물게 겹칠 수 있고, 겹치면 칸이 없어 관리자가 고칠 길이 없음
// (Swagger code에 길이 제한 없음) → 409는 '아까 보낸 요청이 이미 성공함' 한 가지 뜻만 남음
const newCode = () => `persona-${crypto.randomUUID()}`

/** 07 페르소나 추가 창 훅 — 이름 · 프롬프트 · 음성 → v1 저장(아직 적용 안 함, Swagger POST /api/personas)
 * 만든 뒤엔 그 페르소나를 골라 보여 줌. 통화에 쓰려면 시험 통화 → [적용] 또는 [사용하기] */
export function useAddPersona(onDone: (personaSeq: number) => void) {
  const qc = useQueryClient()
  const { me } = useSession()
  const [name, setName] = useState('')
  const [code] = useState(newCode)
  const [prompt, setPrompt] = useState('')
  const [voice, setVoice] = useState(DEFAULT_VOICE)

  const mutation = useMutation({
    mutationFn: () =>
      createPersona({
        code,
        name: name.trim(),
        prompt,
        voice,
        author: me?.loginId ?? '',
      }),
    onSuccess: async (personaSeq) => {
      await qc.invalidateQueries({ queryKey: personaQueries.all() })
      onDone(personaSeq)
    },
  })

  return {
    name,
    setName,
    prompt,
    setPrompt,
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

    canSubmit: name.trim() !== '' && prompt.trim() !== '' && !mutation.isPending,
    submit: () => mutation.mutate(),
    isSubmitting: mutation.isPending,
    submitError: !mutation.error
      ? null
      : mutation.error instanceof ApiError && mutation.error.status === 409
        ? '이미 추가됐을 수 있습니다. 창을 닫고 목록을 확인해 주세요.' // 코드가 겹칠 일은 사실상 없음 → 첫 요청이 성공한 것
        : mutation.error.message,
  }
}
