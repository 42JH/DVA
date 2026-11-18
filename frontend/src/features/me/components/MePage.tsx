// 내 정보 (11/06) — 계정(아이디 · 이름 · 권한)과 비밀번호 변경. 규칙 · 저장은 기존 usePasswordChange 그대로
// 11/09: 가운데 좁은 기둥 → 화면 폭을 채우는 카드 두 장 (1280 이상 나란히, 아래는 위아래). 로그아웃은 사이드바 아래 버튼으로만
import type { ReactNode } from 'react'
import { useSession } from '@/shared/auth/useSession'
import { usePasswordChange } from '@/features/me/hooks/usePasswordChange'
import { PageHead } from '@/shared/ui'
import { Btn } from '@/shared/ui'
import { Confirm } from '@/shared/ui/Modal'

export function MePage() {
  const { me, isSystemAdmin } = useSession()
  const vm = usePasswordChange()
  return (
    <>
      <PageHead title="내 정보" />
      <div className="min-h-0 flex-1 overflow-y-auto px-6 pt-4 pb-4">
        <div className="grid items-stretch gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
          <Part title="계정" note="지금 로그인한 계정입니다.">
            <dl className="grid grid-cols-[100px_1fr] gap-y-3 text-[14px]">
              <dt className="text-ops-sub">아이디</dt>
              <dd className="font-medium">{me?.loginId}</dd>
              <dt className="text-ops-sub">이름</dt>
              <dd className="font-medium">{me?.name}</dd>
              <dt className="text-ops-sub">권한</dt>
              <dd>{isSystemAdmin ? '최고 관리자' : '관리자'}</dd>
            </dl>
          </Part>
          <Part title="비밀번호 변경" note="바꾸면 다른 기기에서는 다시 로그인해야 할 수 있습니다.">
            <form
              className="flex flex-col gap-4"
              onSubmit={(e) => {
                e.preventDefault()
                if (vm.canSubmit) vm.askConfirm()
              }}
            >
              <input
                hidden
                readOnly
                type="text"
                autoComplete="username"
                value={me?.loginId ?? ''}
              />
              <Pw
                label="지금 비밀번호"
                auto="current-password"
                value={vm.form.currentPassword}
                onChange={vm.setCurrent}
                error={vm.errors.current}
              />
              <Pw
                label="새 비밀번호"
                auto="new-password"
                value={vm.form.newPassword}
                onChange={vm.setNew}
                error={vm.errors.new}
              />
              <Pw
                label="새 비밀번호 확인"
                auto="new-password"
                value={vm.form.newPasswordConfirm}
                onChange={vm.setConfirm}
                error={vm.errors.confirm}
              />
              <div className="flex items-center gap-3">
                <Btn kind="primary" type="submit" disabled={!vm.canSubmit}>
                  비밀번호 바꾸기
                </Btn>
                {vm.errorMessage && (
                  <p role="alert" className="text-[13px] text-ops-stop">
                    {vm.errorMessage}
                  </p>
                )}
              </div>
            </form>
          </Part>
        </div>
      </div>
      {vm.confirming && (
        <Confirm
          title="비밀번호를 바꿀까요?"
          ok="바꾸기"
          busy={vm.isSubmitting}
          error={vm.errorMessage}
          onOk={vm.submit}
          onClose={vm.cancelConfirm}
        >
          다른 기기에서는 다시 로그인해야 할 수 있습니다.
        </Confirm>
      )}
    </>
  )
}

/** 카드 한 장 — 제목 · 한 줄 설명, 아래 내용 */
function Part({ title, note, children }: { title: string; note: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-5 rounded-lg border border-ops-line bg-white px-6 py-6">
      <div>
        <h2 className="text-[15px] font-bold">{title}</h2>
        <p className="mt-1 text-[13px] break-keep text-ops-sub">{note}</p>
      </div>
      <div className="min-w-0">{children}</div>
    </section>
  )
}

function Pw({
  label,
  auto,
  value,
  onChange,
  error,
}: {
  label: string
  auto: string
  value: string
  onChange: (v: string) => void
  error?: string
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[13px] font-medium text-ops-sub">{label}</span>
      <input
        type="password"
        autoComplete={auto}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={!!error}
        className={`h-9 rounded-md px-3 text-[14px] ring-1 outline-none ring-inset focus:ring-ops-route ${error ? 'ring-ops-stop' : 'ring-ops-line'}`}
      />
      {error && <span className="text-[12px] text-ops-stop">{error}</span>}
    </label>
  )
}
