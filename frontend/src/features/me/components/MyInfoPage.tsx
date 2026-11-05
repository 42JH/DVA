import { Button, ConfirmDialog, TextField, TopBar } from '@/shared/ui'
import { NewLook } from '@/shared/ui/newLook'
import { useSession } from '@/shared/auth/useSession'
import { usePasswordChange } from '@/features/me/hooks/usePasswordChange'

// 11 내 정보 (Figma 11_내정보, 11/01) — 가운데 카드 하나
// 계정 정보(아이디 · 이름, 자물쇠 = 고칠 수 없음) → 구분선 → 비밀번호 변경(기존 · 신규 · 신규 확인) → [저장]
// 디자인과 다른 점 (11/01 결정): '이메일' → 아이디(서버가 loginId만 줌) · 저장 전 확인 창 → 성공하면 바로 로그인 화면(서버가 세션을 끊음)
// 11/05 새 디자인: 구성은 그대로 두고 모양만 (사용자) — 새 상단바(04 · 03처럼 상태 · 알림) · 칸 새 모양(NewLook) · 제목 20/600 · [저장] 파랑 · 새 확인 창
export function MyInfoPage() {
  const { me } = useSession()
  const vm = usePasswordChange()

  return (
    <div className="flex flex-col">
      {/* 설정 화면은 검색칸 없음 (11/05 사용자) */}
      <TopBar search={false} />
      <NewLook.Provider value>
        <div className="mt-v24 flex justify-center">
          <section className="flex w-[640px] flex-col gap-v24 rounded-xl bg-surface px-8 py-v32 ring-1 ring-line [--field-label:150px] ring-inset">
            <div className="flex flex-col gap-6">
              <h2 className="text-card font-semibold">계정 정보</h2>
              <TextField label="아이디" inline locked value={me?.loginId ?? ''} />
              <TextField label="이름" inline locked value={me?.name ?? ''} />
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
              <h2 className="text-card font-semibold">비밀번호 변경</h2>
              {/* 숨은 아이디: 비밀번호 관리자가 '어느 계정'의 비밀번호를 바꾸는지 알게 (위 아이디 칸은 form 밖) */}
              <input
                hidden
                readOnly
                type="text"
                autoComplete="username"
                value={me?.loginId ?? ''}
              />
              <TextField
                inline
                label="기존 비밀번호"
                type="password"
                autoComplete="current-password"
                placeholder="기존 비밀번호"
                value={vm.form.currentPassword}
                onChange={(e) => vm.setCurrent(e.target.value)}
                error={vm.errors.current}
              />
              <TextField
                inline
                label="신규 비밀번호"
                type="password"
                autoComplete="new-password"
                placeholder="신규 비밀번호"
                value={vm.form.newPassword}
                onChange={(e) => vm.setNew(e.target.value)}
                error={vm.errors.new}
              />
              <TextField
                inline
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
                  <p role="alert" className="mr-auto text-body text-danger">
                    {vm.errorMessage}
                  </p>
                )}
                <Button big kind="brand" type="submit" disabled={!vm.canSubmit}>
                  저장
                </Button>
              </div>
            </form>
          </section>
        </div>
      </NewLook.Provider>

      {vm.confirming && (
        <ConfirmDialog
          big
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
