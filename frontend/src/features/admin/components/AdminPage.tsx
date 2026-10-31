import {
  Button,
  ConfirmDialog,
  CountTabs,
  MoreMenu,
  Pagination,
  Table,
  Tag,
  type Column,
  type MoreMenuItem,
} from '@/shared/ui'
import { RESET_PASSWORD } from '@/features/admin/labels'
import { useAdminList, type AdminAction, type AdminRow } from '@/features/admin/hooks/useAdminList'

// 10 관리자 권한 관리 (Figma 10, 11/01) — 건수 탭 → 표(이름 · 아이디 · 권한 · 가입 신청일 · 줄 끝) → 쪽 번호
// 디자인과 다른 점 (11/01 결정): 전화 · 이메일 → 아이디 · 권한(서버에 없음) · '슈퍼바이저만' 안내 뺌(화면 자체가 최고 관리자 전용)
// 비활성화 · 활성화는 API가 없어 ⋮ 메뉴에서 '준비 중'으로 꺼 둠 (backend-todo 9)

// ⋮ 메뉴 항목 모양 — 무엇을 할 수 있는지는 훅(actions), 모양 · 순서만 여기
const MENU: Record<AdminAction, Omit<MoreMenuItem, 'key' | 'onSelect'>> = {
  reset: { label: '비밀번호 초기화', icon: 'key' },
  deactivate: { label: '비활성화', icon: 'user', soon: true },
  activate: { label: '활성화', icon: 'user', soon: true },
  delete: { label: '삭제', icon: 'trash', danger: true },
}

// 확인 창 문구 — 거절 · 삭제는 디자인 그대로(이메일 → 아이디), 초기화는 디자인에 없어 추가
const CONFIRM = {
  reject: {
    title: '가입 신청을 거절하시겠습니까?',
    note: '신청이 지워지며, 같은 아이디로 다시 신청할 수 있습니다.',
    okLabel: '거절',
    okKind: 'danger',
  },
  delete: {
    title: '관리자 계정을 삭제하시겠습니까?',
    warn: '삭제하면 이 계정으로 더 이상 로그인할 수 없습니다.',
    okLabel: '삭제',
    okKind: 'danger',
  },
  reset: {
    title: '비밀번호를 초기화할까요?',
    note: `초기 비밀번호는 ${RESET_PASSWORD}입니다. 본인에게 알려 주세요.`,
    okLabel: '초기화',
    okKind: 'primary',
  },
} as const

const EMPTY = {
  PENDING: '승인 대기 중인 신청이 없습니다.',
  ACTIVE: '관리자가 없습니다.',
  INACTIVE: '비활성화된 관리자가 없습니다.',
} as const

export function AdminPage() {
  const vm = useAdminList()

  const columns: Column<AdminRow>[] = [
    {
      key: 'name',
      header: '이름',
      width: 220,
      cell: (r) => (
        <span className="flex items-center gap-2 text-body font-semibold">
          {r.name}
          {r.isMe && <Tag>본인</Tag>}
        </span>
      ),
    },
    { key: 'loginId', header: '아이디', width: 240, cell: (r) => r.loginId },
    { key: 'role', header: '권한', width: 180, cell: (r) => r.role },
    {
      key: 'date',
      header: '가입 신청일',
      cell: (r) => <span className="text-sub tabular-nums">{r.date}</span>,
    },
    {
      key: 'actions',
      header: '',
      width: 160,
      align: 'right',
      cell: (r) =>
        r.pending ? (
          <span className="flex justify-end gap-2">
            <Button
              small
              kind="primary"
              disabled={vm.busyId === r.id}
              onClick={() => vm.approve(r.id)}
            >
              승인
            </Button>
            <Button small onClick={() => vm.ask('reject', r.id)}>
              거절
            </Button>
          </span>
        ) : r.actions.length > 0 ? (
          <span className="flex justify-end">
            <MoreMenu
              label={`${r.name} 더 보기`}
              items={r.actions.map((a) => ({
                key: a,
                ...MENU[a],
                onSelect: () => (a === 'reset' || a === 'delete') && vm.ask(a, r.id),
              }))}
            />
          </span>
        ) : null,
    },
  ]

  const c = vm.confirming && CONFIRM[vm.confirming.kind]

  return (
    <div className="flex flex-col gap-6">
      <CountTabs items={vm.tabs} value={vm.tab} onChange={vm.setTab} />

      {(vm.jobError ?? vm.loadError) && (
        <p role="alert" className="text-label text-danger">
          {vm.jobError ?? vm.loadError}
        </p>
      )}

      <Table
        columns={columns}
        rows={vm.rows}
        rowKey={(r) => r.id}
        loading={vm.isLoading}
        empty={EMPTY[vm.tab]}
        footer={<Pagination page={vm.page} pages={vm.pages} onChange={vm.setPage} />}
      />

      {vm.confirming && c && (
        <ConfirmDialog
          title={c.title}
          target={`${vm.confirming.admin.name} · ${vm.confirming.admin.loginId}`}
          note={'note' in c ? c.note : undefined}
          warn={'warn' in c ? c.warn : undefined}
          okLabel={c.okLabel}
          okKind={c.okKind}
          pending={vm.confirmPending}
          onOk={vm.confirm}
          onClose={vm.cancel}
        />
      )}
    </div>
  )
}
