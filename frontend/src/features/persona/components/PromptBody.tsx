import type { usePersonaPage } from '@/features/persona/hooks/usePersonaPage'
import type { usePromptEditor } from '@/features/persona/hooks/usePromptEditor'
import { TextAreaInput } from '@/shared/ui/Field'

type Vm = ReturnType<typeof usePersonaPage>
// 입력 칸에 필요한 것만 — 그 자리 수정(usePromptEditor) · 등록(useAddPersona)이 같은 모양
type Fields = Pick<ReturnType<typeof usePromptEditor>, 'sections' | 'setField'>
// ed가 없으면 p를 읽기 전용으로. locked = 시험 · 반영 중 — 회색 바탕 · 흐린 글 (피그마 2368:3212)
type Props = { p?: NonNullable<Vm['prompt']>; ed: Fields | null; locked?: boolean }

// 프롬프트 — 회색 제목 줄 + 본문(글 그대로)을 한 테두리 안에 (11/13 새 안: 입력 칸과 같은 모양이라 마크다운으로 꾸미지 않음)
// 글은 15 / 1.65, 칸 안 여백 10 · 12 (시안) — 보기와 입력 칸이 같아 고치기 시작해도 글이 안 움직임
export function PromptBody({ p, ed, locked }: Props) {
  return (
    <div className="min-h-0 flex-1 [scrollbar-width:thin] overflow-y-auto px-8 py-[18px]">
      <h3 className="mb-2 text-[17px] leading-5 font-bold">프롬프트</h3>
      {/* 고칠 수 있으면 칸 전체에 초점 테두리 (칸 하나하나엔 테두리 없음 — 한 칸처럼) */}
      <div
        className={`divide-y divide-ops-line overflow-hidden rounded-md border focus-within:border-ops-route focus-within:shadow-[0_0_0_3px_var(--color-ops-route-soft)] ${locked ? 'border-ops-line' : 'border-[#c5ccd6]'}`}
      >
        {ed
          ? ed.sections.map((s) => (
              <TextAreaInput
                key={s.key}
                label={s.title}
                labelClassName={STRIP}
                value={s.value}
                onChange={(v) => ed.setField(s.key, v)}
                placeholder="내용을 입력하세요"
                className={`[field-sizing:content] min-h-0! rounded-none! ring-0! ${TEXT}`}
              />
            ))
          : p?.sections.map((s) => (
              <section key={s.key}>
                <h4 className={STRIP}>{s.title}</h4>
                <p
                  className={`whitespace-pre-wrap ${TEXT} ${locked ? 'bg-ops-paper text-ops-sub' : ''}`}
                >
                  {s.text}
                </p>
              </section>
            ))}
      </div>
    </div>
  )
}

// 회색 제목 줄 — 고칠 수 없음 (보기 · 입력 칸 공용)
const STRIP =
  'border-b border-ops-line bg-ops-paper px-3 py-1.5 text-[14px] leading-[17px] font-bold text-ops-sub'
// 본문 글 — 공용 입력 칸(14 / 24, 여백 8 · 12)보다 우선하게 !를 붙임
const TEXT = 'px-3! py-2.5! text-[15px]! leading-[1.65]!'
