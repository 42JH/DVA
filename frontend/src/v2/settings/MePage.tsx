// v2 내 정보 (11/06) — 계정(아이디 · 이름 · 권한)과 비밀번호 변경. 규칙 · 저장은 기존 usePasswordChange 그대로
// 11/09: 가운데 좁은 기둥 → 다른 화면처럼 왼쪽부터 흰 상자 하나, 부분마다 왼쪽 제목 · 설명 | 오른쪽 내용 (구성 · 순서는 그대로)
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
      <div className="min-h-0 flex-1 overflow-y-auto px-6 pt-4 pb-4">
        <div className="divide-y divide-ops-line rounded-lg border border-ops-line bg-white">
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
              className="flex max-w-[400px] flex-col gap-4"
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
          <Part title="로그아웃" note="이 브라우저에서 로그아웃합니다.">
            <Btn kind="plain" onClick={logout}>
              로그아웃
            </Btn>
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

/** 한 부분 — 왼쪽 제목 · 설명, 오른쪽 내용 (좁으면 위아래로) */
function Part({ title, note, children }: { title: string; note: string; children: ReactNode }) {
  return (
    <section className="grid gap-x-10 gap-y-4 px-6 py-6 lg:grid-cols-[260px_minmax(0,1fr)]">
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
