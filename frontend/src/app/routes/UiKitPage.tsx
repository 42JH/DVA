import { useState } from 'react'
import {
  AppliedFilters,
  Button,
  CountTabs,
  Select,
  Pagination,
  PeriodFilter,
  RadioGroup,
  ChipGroup,
  SearchBox,
  Table,
  Tabs,
  Tag,
  TwoLines,
  type Column,
  type PeriodKey,
  Calendar,
  ConfirmDialog,
  FormModal,
  Switch,
  TextArea,
  TextField,
} from '@/shared/ui'
import { fmtDateTime, fmtDuration } from '@/shared/lib/format'

// 공통 부품 확인용 화면 (/ui-kit, 개발 중에만). 04 통화 내역 예시 데이터로 표 · 필터 · 페이지 번호를 한 번에 본다
type Call = {
  id: number
  at: string
  name: string
  phone: string
  status: '접수 성공' | '접수 실패' | '상담원 이관'
  complaint?: string
  why?: string
  sec: number
  order?: string
  parcel?: string
}
const CALLS: Call[] = [
  {
    id: 1,
    at: '2026-10-20T14:31:00+09:00',
    name: '이서연',
    phone: '010-2817-4405',
    status: '접수 성공',
    sec: 168,
    order: '10533',
    parcel: 'T5B8N2WE',
  },
  {
    id: 2,
    at: '2026-10-20T14:26:00+09:00',
    name: '(주)한빛상사',
    phone: '010-5521-9032',
    status: '접수 성공',
    sec: 185,
    order: '10532',
    parcel: 'Q4N7W2PL',
  },
  {
    id: 3,
    at: '2026-10-20T14:22:00+09:00',
    name: '박지호',
    phone: '010-4183-2290',
    status: '접수 성공',
    complaint: '되묻기 반복',
    why: '같은 주소를 세 번 물었다고 말함',
    sec: 252,
    order: '10531',
    parcel: 'H8C3V6ZR',
  },
  {
    id: 4,
    at: '2026-10-20T14:09:00+09:00',
    name: '연남베이커리',
    phone: '010-7724-1186',
    status: '접수 실패',
    sec: 97,
    order: '10529',
  },
  {
    id: 5,
    at: '2026-10-20T12:58:00+09:00',
    name: '최유나',
    phone: '010-2290-7714',
    status: '상담원 이관',
    sec: 72,
    order: '10515',
  },
]

const COLS: Column<Call>[] = [
  {
    key: 'at',
    header: '통화 시작 시각',
    width: 154,
    cell: (r) => <span className="text-sub">{fmtDateTime(r.at)}</span>,
  },
  {
    key: 'who',
    header: '고객 · 발신번호',
    width: 170,
    cell: (r) => <TwoLines top={r.name} bottom={r.phone} />,
  },
  {
    key: 'status',
    header: '상태',
    width: 147,
    cell: (r, { tinted }) => (
      <Tag
        kind={r.status === '접수 성공' ? 'blue' : r.status === '접수 실패' ? 'red' : 'gray'}
        onTinted={tinted}
      >
        {r.status}
      </Tag>
    ),
  },
  {
    key: 'complaint',
    header: '불만',
    width: 250,
    cell: (r) => (r.complaint ? <TwoLines top={r.complaint} bottom={r.why} /> : null),
  },
  { key: 'sec', header: '통화 시간', width: 121, align: 'right', cell: (r) => fmtDuration(r.sec) },
  {
    key: 'order',
    header: '주문 · 디버 접수번호',
    cell: (r) =>
      r.order ? (
        <TwoLines top={r.order} bottom={r.parcel ?? '—'} topMuted />
      ) : (
        <span className="text-muted">—</span>
      ),
  },
]

export function UiKitPage() {
  const [tab, setTab] = useState<'all' | 'org' | 'person'>('all')
  const [ctab, setCtab] = useState<'all' | 'wait' | 'admin'>('all')
  const [q, setQ] = useState('')
  const [period, setPeriod] = useState<PeriodKey>('today')
  const [status, setStatus] = useState('all')
  const [kind, setKind] = useState('all')
  const [selected, setSelected] = useState<Set<string | number>>(new Set())
  const [page, setPage] = useState(1)
  const [aiOn, setAiOn] = useState(true)
  const [modal, setModal] = useState<'confirm' | 'warn' | 'form' | 'cal' | null>(null)
  const [range, setRange] = useState<{ from: string; to: string } | undefined>()

  const toggle = (k: string | number) =>
    setSelected((s) => {
      const n = new Set(s)
      if (n.has(k)) n.delete(k)
      else n.add(k)
      return n
    })

  return (
    <div className="flex flex-col gap-6">
      <Tabs
        items={[
          { key: 'all', label: '전체' },
          { key: 'org', label: '기업' },
          { key: 'person', label: '개인' },
        ]}
        value={tab}
        onChange={setTab}
        right={
          <>
            <Button>CSV 내보내기</Button>
            <Button kind="dangerLine" disabled={selected.size === 0}>
              삭제
            </Button>
          </>
        }
      />

      <div className="flex gap-6">
        <SearchBox
          value={q}
          onChange={setQ}
          placeholder="주문 · 디버 접수번호 · 고객 · 발신번호"
          className="flex-1"
        />
        <PeriodFilter value={period} onChange={setPeriod} />
        <Select
          name="상태"
          value={status}
          onChange={setStatus}
          options={[
            { value: 'all', label: '전체' },
            { value: 'ok', label: '접수 성공' },
            { value: 'fail', label: '접수 실패' },
            { value: 'handoff', label: '상담원 이관' },
          ]}
        />
      </div>

      <ChipGroup
        name="상태"
        value={kind}
        onChange={setKind}
        options={[
          { value: 'all', label: '전체' },
          { value: 'edit', label: '수정' },
          { value: 'ask', label: '문의' },
        ]}
      />

      <div className="flex items-center justify-between">
        <RadioGroup
          name="구분"
          value={kind}
          onChange={setKind}
          options={[
            { value: 'all', label: '전체' },
            { value: 'edit', label: '수정' },
            { value: 'ask', label: '문의' },
          ]}
        />
        <CountTabs
          items={[
            { key: 'all', label: '전체', count: 11 },
            { key: 'wait', label: '승인 대기', count: 3, countKind: 'red' },
            { key: 'admin', label: '관리자', count: 8 },
          ]}
          value={ctab}
          onChange={setCtab}
        />
      </div>

      <AppliedFilters
        chips={[
          ...(period !== 'today'
            ? [{ key: 'period', label: period === 'week' ? '1주일' : '기간 선택' }]
            : []),
          ...(status !== 'all' ? [{ key: 'status', label: '상태' }] : []),
        ]}
        count="8건"
        onRemove={(k) => (k === 'period' ? setPeriod('today') : setStatus('all'))}
        onClear={() => {
          setPeriod('today')
          setStatus('all')
        }}
      />

      <Table
        columns={COLS}
        rows={CALLS}
        rowKey={(r) => r.id}
        onRowClick={() => {}}
        selectable
        selected={selected}
        onSelect={toggle}
        onSelectAll={() =>
          setSelected((s) =>
            s.size === CALLS.length ? new Set() : new Set(CALLS.map((c) => c.id)),
          )
        }
        footer={<Pagination page={page} pages={13} onChange={setPage} />}
      />

      <div className="flex flex-wrap items-center gap-3">
        <Button kind="primary">저장</Button>
        <Button>취소</Button>
        <Button kind="danger">삭제</Button>
        <Button kind="dangerLine">거절</Button>
        <Button disabled>비활성</Button>
        <Button small>FAQ 추가</Button>
        <Tag kind="blue">접수 성공</Tag>
        <Tag kind="red">조치 필요</Tag>
        <Tag kind="gray">해결</Tag>
        <Tag kind="outline">지식 없음</Tag>
        <Tag kind="live">접수 중</Tag>
        <Pagination page={2} hasNext onChange={() => {}} />
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Switch on={aiOn} onChange={setAiOn} label="AI 동작 표시" />
        <Button onClick={() => setModal('confirm')}>삭제 확인 창</Button>
        <Button onClick={() => setModal('warn')}>경고 확인 창</Button>
        <Button onClick={() => setModal('form')}>폼 창</Button>
        <Button onClick={() => setModal('cal')}>달력</Button>
        {range && (
          <span className="text-label text-sub">
            고른 기간: {range.from} ~ {range.to}
          </span>
        )}
      </div>

      <div className="grid w-[576px] gap-11 rounded-xl border border-line p-8">
        <TextField label="이메일" value="jaehoon.lee@dver.co.kr" locked readOnly />
        <TextField label="신규 비밀번호" type="password" defaultValue="••••••••••" />
        <TextField
          label="전화번호"
          placeholder="숫자만 입력"
          error="숫자 문자열만 허용"
          defaultValue="010-1234"
        />
        <TextArea
          label="답변"
          defaultValue="수거 기사님이 방문하기 전이면 접수번호나 접수한 전화번호로 바로 취소할 수 있습니다."
        />
      </div>

      {modal === 'confirm' && (
        <ConfirmDialog
          title="정말로 삭제하시겠습니까?"
          target="선택한 통화 3건"
          okLabel="삭제"
          onOk={() => setModal(null)}
          onClose={() => setModal(null)}
        />
      )}
      {modal === 'warn' && (
        <ConfirmDialog
          title="관리자 계정을 삭제하시겠습니까?"
          target="김지훈 · jihoon.kim@dver.co.kr"
          warn="삭제하면 이 계정으로 더 이상 로그인할 수 없습니다."
          okLabel="삭제"
          onOk={() => setModal(null)}
          onClose={() => setModal(null)}
        />
      )}
      {modal === 'form' && (
        <FormModal
          title="질의 추가"
          onClose={() => setModal(null)}
          footer={
            <>
              <Button onClick={() => setModal(null)}>취소</Button>
              <Button kind="primary" onClick={() => setModal(null)}>
                추가
              </Button>
            </>
          }
        >
          <div className="grid gap-6">
            <TextField label="질문" placeholder="주말에도 방문 수거를 하나요?" />
            <TextArea
              label="답변"
              placeholder="토요일은 오전 9시부터 오후 1시까지 방문 수거를 합니다."
            />
          </div>
        </FormModal>
      )}
      {modal === 'cal' && (
        <div
          className="fixed inset-0 z-50 grid place-items-center bg-ink/40"
          onClick={() => setModal(null)}
        >
          <div onClick={(e) => e.stopPropagation()}>
            <Calendar
              value={range}
              onApply={(r) => {
                setRange(r)
                setModal(null)
              }}
              onCancel={() => setModal(null)}
            />
          </div>
        </div>
      )}
    </div>
  )
}
