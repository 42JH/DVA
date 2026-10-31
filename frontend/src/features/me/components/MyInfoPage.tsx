import { Button, ConfirmDialog, TextField } from '@/shared/ui'
import { useSession } from '@/shared/auth/useSession'
import { usePasswordChange } from '@/features/me/hooks/usePasswordChange'

// 11 내 정보 (Figma 11_내정보, 11/01) — 가운데 카드 하나
// 계정 정보(아이디 · 이름, 자물쇠 = 고칠 수 없음) → 구분선 → 비밀번호 변경(기존 · 신규 · 신규 확인) → [저장]
// 디자인과 다른 점 (11/01 결정): '이메일' → 아이디(서버가 loginId만 줌) · 저장 전 확인 창 → 성공하면 바로 로그인 화면(서버가 세션을 끊음)
export function MyInfoPage() {
  const { me } = useSession()
  const vm = usePasswordChange()

  return (
    <div className="flex justify-center">
      <section className="flex w-[640px] flex-col gap-8 rounded-xl bg-surface p-8 ring-1 ring-line ring-inset">
        <div className="flex flex-col gap-6">
          <h2 className="text-card font-bold">계정 정보</h2>
          <TextField label="아이디" locked value={me?.loginId ?? ''} />
          <TextField label="이름" locked value={me?.name ?? ''} />
        </div>

        <hr className="border-line" />

        {/* form: Enter로도 [저장]과 같게 확인 창을 엶. 비밀번호 관리자가 칸을 알아보게 autoComplete */}
        <form
          className="flex flex-col gap-6"
          onSubmit={(e) => {
            e.preventDefault()
            if (vm.canSubmit) vm.askConfirm()
          }}
        >
          <h2 className="text-card font-bold">비밀번호 변경</h2>
          {/* 숨은 아이디: 비밀번호 관리자가 '어느 계정'의 비밀번호를 바꾸는지 알게 (위 아이디 칸은 form 밖) */}
          <input hidden readOnly type="text" autoComplete="username" value={me?.loginId ?? ''} />
          <TextField
            label="기존 비밀번호"
            type="password"
            autoComplete="current-password"
            placeholder="기존 비밀번호"
            value={vm.form.currentPassword}
            onChange={(e) => vm.setCurrent(e.target.value)}
            error={vm.errors.current}
          />
          <TextField
            label="신규 비밀번호"
            type="password"
            autoComplete="new-password"
            placeholder="신규 비밀번호"
            value={vm.form.newPassword}
            onChange={(e) => vm.setNew(e.target.value)}
            error={vm.errors.new}
          />
          <TextField
            label="신규 비밀번호 확인"
            type="password"
            autoComplete="new-password"
            placeholder="신규 비밀번호 확인"
            value={vm.form.newPasswordConfirm}
            onChange={(e) => vm.setConfirm(e.target.value)}
            error={vm.errors.confirm}
          />
          <div className="flex items-center justify-end gap-3">
            {vm.errorMessage && (
              <p role="alert" className="mr-auto text-label text-danger">
                {vm.errorMessage}
              </p>
            )}
            <Button kind="primary" type="submit" disabled={!vm.canSubmit}>
              저장
            </Button>
          </div>
        </form>
      </section>

      {vm.confirming && (
        <ConfirmDialog
          title="비밀번호를 바꿀까요?"
          note="바꾸면 모든 기기에서 로그아웃되고, 새 비밀번호로 다시 로그인해야 합니다."
          okLabel="바꾸기"
          okKind="primary"
          pending={vm.isSubmitting}
          onOk={vm.submit}
          onClose={vm.cancelConfirm}
        />
      )}
    </div>
  )
}
