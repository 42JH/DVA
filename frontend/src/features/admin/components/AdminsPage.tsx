// 관리자 — 상태 탭(승인 대기 · 이용 중 · 비활성) · 이름/아이디 검색 · 승인 · 거절 · 비밀번호 초기화 · 비활성화 · 삭제
// 확인이 필요한 일은 그 줄 아래 한 줄에서 묻고, 데이터 · 권한 규칙은 기존 useAdminList 그대로
import { useRef } from 'react'
import { RESET_PASSWORD } from '@/features/admin/labels'
import { useAdminList, type AdminAction } from '@/features/admin/hooks/useAdminList'
import { PageHead } from '@/shared/ui'
import { Btn, Segments } from '@/shared/ui'
import { SearchBox, SkeletonRows } from '@/shared/ui/ListFrame'
import { useScrollable } from '@/shared/lib/useScrollable'
import { useKeepScroll } from '@/shared/lib/keepScroll'
import { Pagination } from '@/shared/ui/Pagination'
import { usePageSize } from '@/shared/lib/paging'
import { Confirm } from '@/shared/ui/Modal'

// 관리 칸 버튼 모양 — 활성화는 비활성화와 같은 자리 · 같은 배지 모양
const ACTION_KIND = {
  delete: 'dangerBadge',
  deactivate: 'plainBadge',
  reset: 'editBadge',
  activate: 'lineBadge',
} as const satisfies Record<AdminAction, string>
const ACTION_LABEL: Record<AdminAction, string> = {
  reset: '비밀번호 초기화',
  deactivate: '비활성화',
  activate: '활성화',
  delete: '삭제',
}
const ASK = {
  reject: {
    title: '가입 신청을 거절할까요?',
    body: '같은 아이디로 다시 신청할 수 있습니다.',
    ok: '거절',
    danger: true,
  },
  delete: {
    title: '관리자 계정을 삭제할까요?',
    body: '이 계정으로 더 이상 로그인할 수 없습니다.',
    ok: '삭제',
    danger: true,
  },
  deactivate: {
    title: '관리자를 비활성화할까요?',
    body: '바로 로그아웃되고, 다시 활성화할 때까지 로그인할 수 없습니다.',
    ok: '비활성화',
    danger: false,
  },
  reset: {
    title: '비밀번호를 초기화할까요?',
    body: `${RESET_PASSWORD}(으)로 바뀝니다. 본인에게 알려 주세요.`,
    ok: '초기화',
    danger: false,
  },
} as const

export function AdminsPage() {
  const [size, setSize] = usePageSize()
  const vm = useAdminList(size)
  const pendingTab = vm.tab === 'PENDING' // 승인 대기는 아직 계정이 아니라 신청일만
  const box = useRef<HTMLDivElement>(null)
  const scrollable = useScrollable(box, [vm.rows])
  useKeepScroll(box, 'list')
  return (
    <>
      <PageHead title="관리자">
        <SearchBox
          value={vm.q}
          onChange={vm.setQ}
          placeholder="이름, 아이디로 검색"
          label="관리자 검색"
        />
      </PageHead>
      <section
        aria-label="관리자 목록"
        className="flex min-h-0 flex-1 flex-col gap-3 px-6 pt-4 pb-4"
      >
        <div className="flex items-center gap-3">
          <Segments
            label="상태"
            value={vm.tab}
            items={vm.tabs.map((t) => ({ value: t.key, label: t.label, count: t.count ?? null }))}
            onPick={vm.setTab}
          />
          {vm.jobError && <span className="text-[13px] text-ops-stop">{vm.jobError}</span>}
        </div>
        <div
          ref={box}
          data-scrollable={scrollable || undefined}
          className="flex min-h-0 flex-1 [scrollbar-width:thin] flex-col overflow-auto rounded-lg border border-ops-line bg-white"
        >
          <table className="ops-table min-w-[1040px]">
            <thead>
              <tr>
                <th scope="col" className="w-[100px]">
                  이름
                </th>
                <th scope="col" className="w-[220px]">
                  아이디
                </th>
                <th scope="col" className="w-[130px]">
                  권한
                </th>
                <th scope="col" className="w-[130px]">
                  {pendingTab ? '신청일' : '생성일'}
                </th>
                {!pendingTab && (
                  <th scope="col" className="w-[160px]">
                    마지막 접속
                  </th>
                )}
                <th scope="col" className="text-right">
                  관리
                </th>
              </tr>
            </thead>
            <tbody>
              {vm.rows.map((r) => {
                const busy = vm.busyId === r.id
                return (
                  <tr key={r.id} className="h-11">
                    <td className="truncate font-medium">{r.name}</td>
                    <td className="truncate text-center text-[13px] text-ops-sub">{r.loginId}</td>
                    <td className="text-[13px]">{r.role}</td>
                    <td className="text-[13px] whitespace-nowrap text-ops-sub tabular-nums">
                      {r.date}
                    </td>
                    {!pendingTab && (
                      <td className="text-[13px] whitespace-nowrap text-ops-sub tabular-nums">
                        {r.lastLogin ?? <span className="text-ops-faint">접속 기록 없음</span>}
                      </td>
                    )}
                    <td>
                      <span className="flex items-center justify-center gap-1">
                        {r.pending ? (
                          <>
                            <Btn kind="lineBadge" disabled={busy} onClick={() => vm.approve(r.id)}>
                              승인
                            </Btn>
                            <Btn kind="dangerBadge" onClick={() => vm.ask('reject', r.id)}>
                              거절
                            </Btn>
                          </>
                        ) : (
                          r.actions.map((a) => (
                            <Btn
                              key={a}
                              kind={ACTION_KIND[a]}
                              disabled={busy}
                              onClick={() =>
                                a === 'activate' ? vm.activate(r.id) : vm.ask(a, r.id)
                              }
                            >
                              {ACTION_LABEL[a]}
                            </Btn>
                          ))
                        )}
                      </span>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          {vm.rows.length === 0 &&
            (vm.isLoading ? (
              <SkeletonRows rows={6} />
            ) : (
              <p className="flex flex-1 items-center justify-center py-16 text-center text-[14px] text-ops-sub">
                {vm.loadError ??
                  (vm.q ? '검색어에 맞는 관리자가 없습니다.' : '이 상태의 관리자가 없습니다.')}
              </p>
            ))}
        </div>
        <Pagination
          page={vm.page}
          size={size}
          total={vm.total}
          pages={vm.pages} // 활성화 탭 total은 나를 뺀 수 → 쪽 수는 서버 건수로 (마지막 쪽이 안 보이던 것)
          unit="명"
          onPage={vm.setPage}
          onSize={setSize}
        />
      </section>
      {vm.confirming && (
        <Confirm
          title={ASK[vm.confirming.kind].title}
          ok={ASK[vm.confirming.kind].ok}
          danger={ASK[vm.confirming.kind].danger}
          busy={vm.confirmPending}
          onOk={vm.confirm}
          onClose={vm.cancel}
        >
          <b className="font-semibold">{vm.confirming.admin.name}</b> ({vm.confirming.admin.loginId}
          ) {ASK[vm.confirming.kind].body}
        </Confirm>
      )}
    </>
  )
}
