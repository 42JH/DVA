// v2 내 정보 (11/06) — 계정(아이디 · 이름 · 권한)과 비밀번호 변경. 규칙 · 저장은 기존 usePasswordChange 그대로
import type { ReactNode } from 'react'
import { useSession } from '@/shared/auth/useSession'
import { usePasswordChange } from '@/features/me/hooks/usePasswordChange'
import { PageHead } from '@/v2/V2Layout'
import { Btn } from '@/v2/ui'
import { Confirm } from '@/v2/ui/Modal'

export function MePage() {
  const { me, isSystemAdmin, logout } = useSession()
  const vm = usePasswordChange()
  return (
    <>
      <PageHead title="내 정보" />
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-6">
        <div className="mx-auto flex max-w-2xl flex-col gap-5">
          <Card title="계정">
            <dl className="grid grid-cols-[120px_1fr] gap-y-3 text-[14px]">
              <dt className="text-ops-sub">아이디</dt>
              <dd className="font-medium">{me?.loginId}</dd>
              <dt className="text-ops-sub">이름</dt>
              <dd className="font-medium">{me?.name}</dd>
              <dt className="text-ops-sub">권한</dt>
              <dd>{isSystemAdmin ? '최고 관리자' : '관리자'}</dd>
            </dl>
          </Card>
          <Card title="비밀번호 변경">
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
              <div className="flex items-center justify-end gap-3">
                {vm.errorMessage && (
                  <p role="alert" className="mr-auto text-[13px] text-ops-stop">
                    {vm.errorMessage}
                  </p>
                )}
                <Btn kind="primary" type="submit" disabled={!vm.canSubmit}>
                  비밀번호 바꾸기
                </Btn>
              </div>
            </form>
          </Card>
          <div className="flex justify-end">
            <Btn kind="ghost" onClick={logout}>
              로그아웃
            </Btn>
          </div>
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

function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-lg border border-ops-line bg-white px-6 py-5">
      <h2 className="mb-4 text-[15px] font-bold">{title}</h2>
      {children}
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
    <label className="grid grid-cols-[120px_1fr] items-start gap-x-3 gap-y-1">
      <span className="pt-2 text-[14px] text-ops-sub">{label}</span>
      <input
        type="password"
        autoComplete={auto}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={!!error}
        className={`h-9 rounded-md px-3 text-[14px] ring-1 outline-none ring-inset focus:ring-ops-route ${error ? 'ring-ops-stop' : 'ring-ops-line'}`}
      />
      {error && <span className="col-start-2 text-[12px] text-ops-stop">{error}</span>}
    </label>
  )
}
