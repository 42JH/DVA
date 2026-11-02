import {
  FilterBar,
  ListPage,
  Button,
  DateField,
  Pagination,
  SearchBox,
  Select,
  Table,
  Tabs,
  Tag,
  TwoLines,
  type Column,
} from '@/shared/ui'
import { slideClass, useSlideDir } from '@/shared/lib/useSlideDir'
import { useCallList, type CallListRow, type CallTab } from '@/features/call/hooks/useCallList'

// 04 통화 내역 (와이어프레임 04_통화내역 · _불만 · _기간선택, 10/30)
// 1줄 탭 [전체 | 불만 통화] → 2줄 검색(이름 · 전화번호) + 날짜 칸 + 통화 결과 ▾ + [CSV 내보내기] → 카드 '통화 목록 n건'
// 줄 = 통화 시작 시각 | 고객 · 발신번호 | 통화 결과 | 불만(유형 · 사유) | 통화 시간. 줄을 누르면 06 (줄 끝 꺽쇠 · 체크박스 · [삭제] · 주문번호 열 없음)
const TABS: { key: CallTab; label: string }[] = [
  { key: 'all', label: '전체' },
  { key: 'complaint', label: '불만 통화' },
]

export function CallListPage() {
  const vm = useCallList()
  const slide = slideClass(useSlideDir(TABS.findIndex((t) => t.key === vm.tab))) // 탭을 바꾸면 목록이 그 방향에서 미끄러져 들어옴 (11/01)

  const columns: Column<CallListRow>[] = [
    {
      key: 'time',
      header: '통화 시작 시각',
      width: 154,
      cell: (r) => (
        <div className="text-body text-sub">
          {r.time.map((line) => (
            <p key={line}>{line}</p>
          ))}
        </div>
      ),
    },
    {
      key: 'outcome',
      header: '통화 결과',
      width: 146,
      align: 'center',
      cell: (r, { tinted }) => (
        <Tag kind={r.outcomeTag} onTinted={tinted}>
          {r.outcomeLabel}
        </Tag>
      ),
    },
    {
      key: 'customer',
      header: '고객 · 발신번호',
      width: 170,
      cell: (r) => <TwoLines top={r.name} bottom={r.phone} />,
    },
    {
      key: 'complaint',
      header: '불만',
      cell: (r) =>
        r.complaintView && (
          <div className="min-w-0">
            <p className="truncate text-body font-semibold">{r.complaintView.label}</p>
            <p className="truncate text-label text-sub">{r.complaintView.reason}</p>
          </div>
        ),
    },
    {
      key: 'duration',
      header: '통화 시간',
      width: 120,
      align: 'right',
      cell: (r) => <span className="text-body">{r.duration}</span>,
    },
  ]

  return (
    <ListPage>
      <Tabs items={TABS} value={vm.tab} onChange={vm.setTab} />

      {/* 목록 맨 윗줄: 검색 + 날짜 칸 + 통화 결과 + [CSV 내보내기] — 여백은 FilterBar 한 곳 */}
      <FilterBar>
        <SearchBox
          value={vm.q}
          onChange={vm.setQ}
          recentKey="calls" // 11/02 사용자: 09와 같은 모양 (최근 검색어 · 추천 · 초성)
          suggestions={vm.suggestions}
          placeholder="이름 · 전화번호"
          className="min-w-0 flex-1"
        />
        <DateField value={vm.range} onChange={vm.setRange} />
        <Select
          name="통화 결과"
          options={vm.outcomeOptions}
          value={vm.outcome}
          onChange={vm.setOutcome}
          className="w-[220px]"
        />
        <Button tall disabled={!vm.canExport || vm.exporting} onClick={vm.exportCsv}>
          {vm.exporting ? '내보내는 중…' : 'CSV 내보내기'}
        </Button>
      </FilterBar>

      <div key={vm.tab} className={slide}>
        <Table
          head={
            <h2 className="flex items-baseline gap-3.5 text-card font-bold">
              통화 목록
              {!vm.isLoading && ( // 첫 로딩 중엔 '0건'을 보이지 않음
                <span className="text-label font-normal text-sub">
                  {vm.count.toLocaleString('ko-KR')}건
                </span>
              )}
              {vm.listNote && (
                <span className="text-caption font-normal text-muted">{vm.listNote}</span>
              )}
            </h2>
          }
          columns={columns}
          rows={vm.rows}
          rowKey={(r) => r.callSessionSeq}
          onRowClick={vm.openCall}
          loading={vm.isLoading}
          empty={
            vm.listError ??
            (vm.q.trim() || vm.outcome !== 'ALL' || vm.range
              ? '조건에 맞는 통화가 없습니다.'
              : vm.tab === 'complaint'
                ? '불만이 감지된 통화가 없습니다.'
                : '통화 내역이 없습니다.')
          }
          footer={<Pagination page={vm.page} pages={vm.pages} onChange={vm.goPage} />}
        />
      </div>
    </ListPage>
  )
}
