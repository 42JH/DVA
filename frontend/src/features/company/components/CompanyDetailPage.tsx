import { Link, useParams } from 'react-router'
import { Button, ConfirmDialog, Pagination, Table, Tag, type Column } from '@/shared/ui'
import { INACTIVE_TAG, MEMBER_ROLE } from '@/features/company/labels'
import { useCompanyDetail, type MemberRow } from '@/features/company/hooks/useCompanyDetail'
import { MemberFormModal } from './MemberFormModal'

// 08 기업 상세 (Figma 08_기업관리_기업상세, 11/01) — ‹ 기업 목록 | 기업명 · '사원 12명 · 대표자 이서미 외 1명' + [CSV로 사원 추가] [사원 추가]
// → 표 '사원 목록 12명'(사번 · 사원명+태그 · 전화번호 · 발송/수신 주소 · 상세주소 · [수정][삭제]) → 쪽 번호
// 디자인과 다른 점 (11/01 결정): 등록일 뺌 · 대표자 이름 · 비활성 태그 · '기업 관리자' → '대표자' · 주소는 보기만
export function CompanyDetailPage() {
  const id = Number(useParams().companyId)
  const vm = useCompanyDetail(id)

  if (vm.notFound)
    return (
      <p className="py-16 text-center text-body text-muted">
        기업을 찾을 수 없습니다. 이미 삭제됐을 수 있어요.{' '}
        <Link to="/companies" className="text-action underline">
          기업 목록으로
        </Link>
      </p>
    )

  const columns: Column<MemberRow>[] = [
    {
      key: 'no',
      header: '사번',
      width: 100,
      cell: (r) => <span className="text-sub tabular-nums">{r.employeeNo}</span>,
    },
    {
      key: 'name',
      header: '사원명',
      width: 200,
      cell: (r) => (
        <span className="flex items-center gap-2 text-body font-semibold">
          {r.name}
          {r.leader && <Tag kind="blue">{MEMBER_ROLE.ORG_ADMIN}</Tag>}
          {r.inactive && <Tag>{INACTIVE_TAG}</Tag>}
        </span>
      ),
    },
    {
      key: 'phone',
      header: '전화번호',
      width: 160,
      cell: (r) => <span className="tabular-nums">{r.phone}</span>,
    },
    { key: 'address', header: '발송/수신 주소', cell: (r) => r.address },
    {
      key: 'detail',
      header: '상세주소',
      width: 160,
      cell: (r) => <span className={r.detail === '없음' ? 'text-muted' : ''}>{r.detail}</span>,
    },
    {
      key: 'actions',
      header: '',
      width: 140,
      align: 'right',
      cell: (r) => (
        <span className="flex justify-end gap-2">
          <Button small onClick={() => vm.openEdit(r.member)}>
            수정
          </Button>
          <Button small kind="dangerLine" onClick={() => vm.askDelete(r.member)}>
            삭제
          </Button>
        </span>
      ),
    },
  ]

  const target = vm.modal?.kind === 'delete' ? vm.modal.member : null

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center gap-4">
        <Link to="/companies" className="text-label font-semibold text-action">
          ‹ 기업 목록
        </Link>
        <span className="h-5 w-px bg-line" aria-hidden />
        <h2 className="flex items-center gap-2 text-card font-bold">
          {vm.name}
          {vm.inactive && <Tag>{INACTIVE_TAG}</Tag>}
        </h2>
        <span className="text-label text-sub">{vm.summary}</span>
        <span className="ml-auto flex gap-3">
          {/* CSV로 사원 추가는 다음 단계(미리 보기 B)에서 연결 */}
          <Button tall disabled title="준비 중">
            CSV로 사원 추가
          </Button>
          <Button kind="primary" tall onClick={vm.openAdd}>
            사원 추가
          </Button>
        </span>
      </div>

      {(vm.deleteError ?? vm.loadError) && (
        <p role="alert" className="text-label text-danger">
          {vm.deleteError ?? vm.loadError}
        </p>
      )}

      <Table
        head={
          <h2 className="flex items-baseline gap-3.5 text-card font-bold">
            사원 목록
            <span className="text-label font-normal text-sub">{vm.total}명</span>
          </h2>
        }
        columns={columns}
        rows={vm.rows}
        rowKey={(r) => r.id}
        loading={vm.isLoading}
        empty="등록된 사원이 없습니다. [사원 추가]로 넣어 주세요."
        footer={<Pagination page={vm.page} pages={vm.pages} onChange={vm.setPage} />}
      />

      {(vm.modal?.kind === 'add' || vm.modal?.kind === 'edit') && (
        <MemberFormModal
          companyId={id}
          companyName={vm.name}
          member={vm.modal.kind === 'edit' ? vm.modal.member : null}
          onClose={vm.close}
        />
      )}
      {target && (
        <ConfirmDialog
          title="사원을 삭제하시겠습니까?"
          target={`${target.customer.name} · 사번 ${target.membership.employeeNo}`}
          note="이 기업에서만 빠집니다. 고객 정보와 지난 주문 기록은 그대로 남습니다."
          okLabel="삭제"
          pending={vm.deleting}
          onOk={vm.confirmDelete}
          onClose={vm.close}
        />
      )}
    </div>
  )
}
