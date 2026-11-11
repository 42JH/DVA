// 주문 칸 — 주문 추가 창 · 상세 패널 수정이 같이 씀. 칸 구성은 상세와 같음: 보내는 분 · 받는 분 · 물품 · 물품 가액 · 배송비 · 결제 방식 · 수거 희망 · 요청 사항
// 주소 칸을 누르면 칸 자리에 주소 검색이 펼쳐짐 (고르면 돌아옴). 규칙은 기존 useOrderForm 그대로
import type { ReactNode } from 'react'
import type { useOrderForm } from '@/features/order/hooks/useOrderForm'
import { fmtPhone } from '@/shared/lib/format'
import { PRICE_BANDS, priceBand } from '@/shared/order/labels'
import { AddressPicker } from '@/shared/ui/AddressPicker'
import { AddressButton, Choice, Err, Label, SuggestInput, TextInput } from '@/shared/ui/Field'
import type { Suggestion } from '@/features/order/hooks/useCustomerSuggest'
import { Confirm } from '@/shared/ui/Modal'

type OrderForm = ReturnType<typeof useOrderForm>

export function OrderFields({
  f,
  fee = '',
  showEmpty,
  wide = false,
}: {
  f: OrderForm
  fee?: string // 수정에서 못 바꾸는 배송비 — 상세와 같은 값
  showEmpty: boolean // 빈 필수 칸도 빨갛게 (수정은 처음부터, 추가는 [접수]를 한 번 누른 뒤부터)
  wide?: boolean // 주문 추가 창: 보내는 분 | 받는 분 나란히, 한 화면에 (배송비는 창 아래 줄에)
}) {
  if (f.searching)
    return (
      <AddressPicker
        title={f.searchTitle}
        query={f.searchQuery}
        onPick={f.pickAddress}
        onClose={f.closeSearch}
      />
    )
  const noItem = f.items.every((i) => i.count === 0) && !f.etcItem.trim()
  const itemsErr = f.itemsError ?? (showEmpty && noItem ? '물품을 1개 이상 넣어 주세요.' : null)
  const priceErr =
    f.priceError ?? (showEmpty && f.declaredValue === '' ? '물품 가액을 골라 주세요.' : undefined)
  if (wide)
    return (
      <div className="flex flex-col gap-5">
        {/* 송장처럼 한 상자 안에서 보내는 분 | 받는 분 */}
        <div className="grid grid-cols-2 rounded-md border border-ops-line">
          <PartyFields title="보내는 분" p={f.sender} showEmpty={showEmpty} boxed />
          <div className="border-l border-ops-line">
            <PartyFields title="받는 분" p={f.receiver} showEmpty={showEmpty} boxed />
          </div>
        </div>

        <Group title="물품">
          <div className="flex flex-wrap items-center gap-2">
            {f.items.map((it) => (
              <ItemStepper key={it.key} it={it} bad={!!itemsErr} />
            ))}
            <span className="min-w-[200px] flex-1">
              <PlainInput
                value={f.etcItem}
                onChange={f.setEtcItem}
                placeholder="기타 물품 (예: 화분)"
                label="기타 물품"
                error={f.etcError ?? itemsErr ?? undefined}
              />
            </span>
          </div>
          {itemsErr && <Err>{itemsErr}</Err>}
          {f.etcError && <Err>{f.etcError}</Err>}
        </Group>

        <div className="grid grid-cols-[200px_240px_minmax(0,1fr)] items-start gap-4">
          <PriceBand f={f} error={priceErr} />
          <Pickup f={f} />
          <Payment f={f} />
        </div>

        <TextInput
          label="요청 사항 (선택)"
          value={f.request}
          onChange={f.setRequest}
          error={f.requestError}
          placeholder="예: 경비실에 맡겨 주세요"
        />
      </div>
    )
  return (
    <div className="flex flex-col gap-4">
      <PartyFields title="보내는 분" p={f.sender} showEmpty={showEmpty} />
      <PartyFields title="받는 분" p={f.receiver} showEmpty={showEmpty} />

      <Group title="물품">
        <div className="grid grid-cols-2 gap-2">
          {f.items.map((it) => (
            <ItemStepper key={it.key} it={it} bad={!!itemsErr} />
          ))}
        </div>
        <TextInput
          label="기타 물품"
          value={f.etcItem}
          onChange={f.setEtcItem}
          error={f.etcError}
          invalid={!!itemsErr}
          placeholder="예: 화분"
        />
        {itemsErr && <Err>{itemsErr}</Err>}
      </Group>

      <div className="grid grid-cols-2 gap-3">
        <PriceBand f={f} error={priceErr} />
        {/* 배송비: 추가 · 미완료 주문은 물품으로 자동 계산, 그 밖엔 상세 값 그대로 (바꿀 수 없음) */}
        <Read
          label="배송비"
          value={f.showFee ? f.shippingFee || '물품을 넣으면 계산' : fee || '없음'}
        />
      </div>

      <Payment f={f} />
      <div className="grid grid-cols-2 gap-3">
        <Pickup f={f} />
      </div>
      <label className="flex flex-col gap-1">
        <Label>요청 사항 (선택)</Label>
        <textarea
          value={f.request}
          onChange={(e) => f.setRequest(e.target.value)}
          rows={2}
          placeholder="예: 경비실에 맡겨 주세요"
          className="resize-none rounded-md px-3 py-2 text-[14px] ring-1 ring-ops-line outline-none ring-inset placeholder:text-ops-faint focus:ring-ops-route"
        />
        {f.requestError && <Err>{f.requestError}</Err>}
      </label>
    </div>
  )
}

/** 추천 한 줄 — 이름 · 번호, 아래에 주소 */
function SuggestRow(s: Suggestion) {
  return (
    <span className="flex min-w-0 flex-col">
      <span className="flex min-w-0 items-baseline gap-2 whitespace-nowrap">
        <span className="shrink-0 font-medium">{s.name}</span>
        <span className="shrink-0 text-ops-sub tabular-nums">{fmtPhone(s.phoneNumber)}</span>
        {s.company && (
          <span className="min-w-0 truncate text-[12px] text-ops-sub" title={s.company}>
            {s.company}
          </span>
        )}
      </span>
      <span className="truncate text-[12px] text-ops-faint">
        {s.address ? `${s.address.roadAddress} ${s.address.detailAddress ?? ''}` : '주소 없음'}
      </span>
    </span>
  )
}

/** 이름 · 전화번호 · 주소(검색으로만) · 상세주소 */
function PartyFields({
  title,
  p,
  showEmpty,
  boxed = false,
}: {
  title: string
  p: OrderForm['sender']
  showEmpty: boolean
  boxed?: boolean // 주문 추가 창의 보내는 분 | 받는 분 상자 안
}) {
  const noAddress = showEmpty && !p.roadAddress
  const fields = (
    <Group title={title}>
      <div className="grid grid-cols-2 gap-2">
        <SuggestInput
          label="이름"
          value={p.name}
          onChange={p.setName}
          placeholder="홍길동"
          error={p.nameError ?? (showEmpty && !p.name.trim() ? '이름을 입력해 주세요.' : undefined)}
          items={p.suggest.byName}
          itemKey={(s) => s.key}
          renderItem={SuggestRow}
          onPick={p.fill}
        />
        <SuggestInput
          label="전화번호"
          value={p.phone}
          onChange={p.setPhone}
          inputMode="numeric"
          placeholder="01012345678" // setPhone이 숫자만 남겨서 예시도 하이픈 없이
          error={p.phoneError ?? (showEmpty && !p.phone ? '전화번호를 입력해 주세요.' : undefined)}
          items={p.suggest.byPhone}
          itemKey={(s) => s.key}
          renderItem={SuggestRow}
          onPick={p.fill}
        />
      </div>
      <AddressButton
        value={p.roadAddress}
        onClick={p.openSearch}
        error={p.addressError ?? (noAddress ? '주소를 검색해서 골라 주세요.' : undefined)}
      />
      <TextInput
        label="상세주소 (선택)"
        value={p.detailAddress}
        onChange={p.setDetailAddress}
        error={p.detailError}
        placeholder="동, 호수"
      />
    </Group>
  )
  // 상자 안이면 여백 (fieldset에 여백을 주면 제목이 테두리에 걸림)
  return boxed ? <div className="p-4">{fields}</div> : fields
}

function Group({
  title,
  className = '',
  children,
}: {
  title: string
  className?: string
  children: ReactNode
}) {
  return (
    <fieldset className={`flex flex-col gap-2 ${className}`}>
      <legend className="mb-1 text-[13px] font-semibold">{title}</legend>
      {children}
    </fieldset>
  )
}

function Read({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[12px] font-medium text-ops-sub">{label}</span>
      <span className="flex h-9 items-center rounded-md bg-ops-paper px-3 text-[14px] text-ops-sub">
        {value}
      </span>
    </div>
  )
}

function Step({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string
  onClick: () => void
  disabled: boolean
  children: ReactNode
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      disabled={disabled}
      className="grid size-6 place-items-center rounded text-[15px] text-ops-sub hover:bg-ops-paper hover:text-ops-ink disabled:opacity-30"
    >
      {children}
    </button>
  )
}

type Item = OrderForm['items'][number]

/** 물품 수량 — '소박스  − 2 +' */
function ItemStepper({ it, bad = false }: { it: Item; bad?: boolean }) {
  return (
    // bad = 물품이 하나도 없을 때 다른 빈 칸처럼 빨간 테두리
    <div
      className={`flex h-9 items-center justify-between gap-2 rounded-md pr-1 pl-3 ring-1 ring-inset ${bad ? 'ring-ops-stop' : 'ring-ops-line'}`}
    >
      <span className="text-[13px]">{it.label}</span>
      <span className="flex items-center gap-0.5">
        <Step
          label={`${it.label} 빼기`}
          onClick={() => it.setCount(Math.max(0, it.count - 1))}
          disabled={it.count <= 0}
        >
          −
        </Step>
        {/* 숫자를 바로 쳐도 됨 (11/09 사용자) — 0 ~ 최대로 맞춤, ↑ ↓도 한 개씩 */}
        <input
          inputMode="numeric"
          aria-label={`${it.label} 개수`}
          value={it.count}
          onFocus={(e) => e.currentTarget.select()}
          onChange={(e) => {
            const n = Number(e.target.value.replace(/\D/g, '') || 0)
            it.setCount(Math.min(it.max, n))
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
              e.preventDefault()
              const n = it.count + (e.key === 'ArrowUp' ? 1 : -1)
              it.setCount(Math.min(it.max, Math.max(0, n)))
            }
          }}
          className="h-7 w-9 rounded text-center text-[14px] font-semibold tabular-nums outline-none focus:bg-ops-route-soft focus:ring-1 focus:ring-ops-route"
        />
        <Step
          label={`${it.label} 더하기`}
          onClick={() => it.setCount(it.count + 1)}
          disabled={it.count >= it.max}
        >
          +
        </Step>
      </span>
    </div>
  )
}

/** 수거 희망 일시 (선택) */
function Pickup({ f }: { f: OrderForm }) {
  return (
    <label className="flex flex-col gap-1">
      <Label>수거 희망 (선택)</Label>
      <input
        type="datetime-local"
        value={f.pickupAt}
        min={f.pickupMin}
        max={f.pickupMax}
        onChange={(e) => f.setPickupAt(e.target.value)}
        className={`h-9 rounded-md px-3 text-[14px] ring-1 outline-none ring-inset focus:ring-ops-route ${f.pickupError ? 'ring-ops-stop' : 'ring-ops-line'}`}
      />
      {f.pickupError && <Err>{f.pickupError}</Err>}
    </label>
  )
}

/** 결제 방식 — 미완료 주문이 아니면 잠김. 고객이 못 쓰는 칩은 꺼짐 · 개인 고객 월결제은 물어보고 추가 (11/10) */
function Payment({ f }: { f: OrderForm }) {
  if (f.paymentLocked)
    return <TextInput label="결제 방식" value={f.paymentText} onChange={() => {}} readOnly />
  return (
    <div className="flex flex-col gap-1">
      <Choice
        label="결제 방식"
        value={f.payment}
        options={f.paymentOptions}
        onChange={f.setPayment}
      />
      {!f.payment && <Err>결제 방식을 골라 주세요.</Err>}
      {f.paymentError && <Err>{f.paymentError}</Err>}
      {f.paymentHint && <p className="text-[12px] text-ops-sub">{f.paymentHint}</p>}
      {f.askingMonthly && (
        <Confirm
          title={`${f.monthlyName}님에게 월결제을 추가할까요?`}
          ok="추가"
          onOk={f.agreeMonthly}
          onClose={f.declineMonthly}
        >
          접수할 때 고객 정보의 결제 수단에도 추가됩니다.
        </Confirm>
      )}
    </div>
  )
}

/** 물품 가액 — 구간 고르기. 고르면 그 구간의 가장 큰 금액이 들어감. 이미 있는 금액(AI 접수)은 그 구간으로 보이고, 안 고치면 그대로 */
function PriceBand({ f, error }: { f: OrderForm; error?: string }) {
  // 범위 밖 금액(0 · 1억 초과)은 '구간 선택'으로 — 보이는 구간을 다시 골라도 안 바뀌어 고칠 수 없던 것 (11/09 검수)
  const n = Number(f.declaredValue)
  const v = f.priceInRange ? String(priceBand(n).max) : ''
  return (
    <label className="flex min-w-0 flex-col gap-1">
      <Label>물품 가액</Label>
      <select
        value={v}
        onChange={(e) => f.setDeclaredValue(e.target.value)}
        aria-invalid={!!error}
        className={`h-9 rounded-md bg-white px-2 text-[14px] ring-1 outline-none ring-inset focus:ring-ops-route ${error ? 'ring-ops-stop' : 'ring-ops-line'} ${v ? '' : 'text-ops-faint'}`}
      >
        <option value="" disabled>
          구간 선택
        </option>
        {PRICE_BANDS.map((b) => (
          <option key={b.max} value={b.max} className="text-ops-ink">
            {b.label}
          </option>
        ))}
      </select>
      {error && <Err>{error}</Err>}
    </label>
  )
}

/** 이름 칸 없이 쓰는 한 줄 입력 (화면 낭독엔 label) */
function PlainInput({
  value,
  onChange,
  placeholder,
  label,
  error,
}: {
  value: string
  onChange: (v: string) => void
  placeholder: string
  label: string
  error?: string
}) {
  return (
    <input
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      aria-label={label}
      aria-invalid={!!error}
      className={`h-9 w-full rounded-md px-3 text-[14px] ring-1 outline-none ring-inset placeholder:text-ops-faint focus:ring-ops-route ${error ? 'ring-ops-stop' : 'ring-ops-line'}`}
    />
  )
}
