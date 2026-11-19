import { useState } from 'react'
import type { usePersonaPage } from '../hooks/usePersonaPage'
import type { usePromptEditor } from '../hooks/usePromptEditor'
import { TextAreaInput } from '@/shared/ui/Field'
import { Markdown } from '@/shared/ui/Markdown'

type Vm = ReturnType<typeof usePersonaPage>
// 입력 칸에 필요한 것만 — 그 자리 수정(usePromptEditor) · 등록(useAddPersona)이 같은 모양
type Fields = Pick<ReturnType<typeof usePromptEditor>, 'sections' | 'setField'>
// ed가 없으면 p를 읽기 전용으로. locked = 시험 · 반영 중 — 회색 바탕 · 흐린 글 (피그마 2368:3212)
// plain = 늘 입력 칸 (상담가 등록 — 처음부터 쓰는 화면이라 보는 모양이 없음)
type Props = {
  p?: NonNullable<Vm['prompt']>
  ed: Fields | null
  locked?: boolean
  plain?: boolean
}

// 프롬프트 — 회색 제목 줄 + 본문을 한 테두리 안에
// 보는 동안은 꾸며서(굵게 · 목록), 그 칸을 누르면 글자 그대로인 입력 칸 ('**즉시**' 같은 기호가 그대로 보임 — 피그마 2409:2521)
// 글은 15 / 1.65, 칸 안 여백 10 · 12 (시안) — 보기와 입력 칸의 첫 줄 자리가 같아 누를 때 글이 덜 움직임
export function PromptBody({ p, ed, locked, plain }: Props) {
  const [editing, setEditing] = useState<string | null>(null) // 지금 고치는 칸
  return (
    <div className="min-h-0 flex-1 [scrollbar-width:thin] overflow-y-auto px-8 py-[18px]">
      <h3 className="mb-2 text-[17px] leading-5 font-bold">프롬프트</h3>
      {/* 고칠 수 있으면 칸 전체에 초점 테두리 (칸 하나하나엔 테두리 없음 — 한 칸처럼) */}
      <div
        className={`divide-y divide-ops-line overflow-hidden rounded-md border focus-within:border-ops-route focus-within:shadow-[0_0_0_3px_var(--color-ops-route-soft)] ${locked ? 'border-ops-line' : 'border-[#c5ccd6]'}`}
      >
        {ed
          ? ed.sections.map((s) =>
              plain || editing === s.key ? (
                <TextAreaInput
                  key={s.key}
                  label={s.title}
                  labelClassName={STRIP}
                  value={s.value}
                  onChange={(v) => ed.setField(s.key, v)}
                  placeholder="내용을 입력하세요"
                  className={`[field-sizing:content] min-h-0! rounded-none! ring-0! ${TEXT}`}
                  autoFocus={!plain}
                  // 다른 창을 보러 간 것(문서 전체가 초점을 잃음)은 그대로 두고, 칸 밖을 눌렀을 때만 보는 모양으로
                  onBlur={plain ? undefined : () => document.hasFocus() && setEditing(null)}
                />
              ) : (
                // 입력 칸과 같은 틀(제목 줄 아래 4) — Tab으로 와도 눌러도 바로 입력 칸
                <section key={s.key} className="flex min-w-0 flex-col gap-1">
                  <h4 className={STRIP}>{s.title}</h4>
                  <div
                    tabIndex={0}
                    onFocus={() => setEditing(s.key)}
                    onClick={() => setEditing(s.key)}
                    className={`cursor-text bg-white outline-none ${TEXT}`}
                  >
                    {s.value.trim() ? (
                      <Markdown text={s.value} className={MARK} />
                    ) : (
                      <span className="text-ops-faint">내용을 입력하세요</span>
                    )}
                  </div>
                </section>
              ),
            )
          : p?.sections.map((s) => (
              <section key={s.key}>
                <h4 className={STRIP}>{s.title}</h4>
                <Markdown
                  text={s.text}
                  className={`${MARK} ${TEXT} ${locked ? 'bg-ops-paper text-ops-sub' : ''}`}
                />
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
// 꾸민 글 — 작성자가 쓴 제목(#)은 굵게만, 인용(>)은 들여서 흐리게 (기호가 사라져도 구분되게)
const MARK = '[&_:is(h1,h2,h3,h4,h5,h6)]:font-bold [&_blockquote]:pl-3 [&_blockquote]:text-ops-sub'
