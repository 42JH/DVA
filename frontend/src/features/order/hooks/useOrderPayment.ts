// 주문 폼의 결제 방식 — 보내는 분(= 주문 고객)이 쓸 수 있는 방식만 켜고, 개인 고객의 월결제은 물어보고 추가
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { PAYMENT_METHOD_LABEL } from '@/shared/order/labels'
import { orderQueries, type OrderDetail, type PaymentMethod } from '../api/orderApi'
import { paymentChoices, phoneOk } from './orderForm'

export function useOrderPayment(order: OrderDetail | undefined, senderPhone: string) {
  // 새 주문만 월결제 기본(와이어프레임). 수정은 서버 값 그대로 — 미정(null)을 월결제으로 채우면 안 바꿔도 credit이 나감
  const [payment, setPayment] = useState<PaymentMethod | null>(
    order ? order.paymentMethod : 'MONTHLY',
  )
  // 결제 방식은 접수 중단(COLLECTING)일 때만 바꿀 수 있음 (명세 4.3, 11/01). 가짜 주문(status 없음)은 그대로
  const locked = !!order?.status && order.status !== 'COLLECTING'
  // 번호를 다 넣기 전 · 불러오는 중엔 모두 켬 (접수 때 서버가 다시 확인)
  const payCtx = useQuery({
    ...orderQueries.payContext(senderPhone),
    enabled: phoneOk('sender', senderPhone) && !locked,
  }).data
  const { isCompany, canAddMonthly, options } = paymentChoices(payCtx)
  const [monthlyFor, setMonthlyFor] = useState<string | null>(null) // 월결제 추가에 동의한 번호 — 번호가 바뀌면 다시 물음
  const [asking, setAsking] = useState<{
    revertTo: PaymentMethod | null // [취소]면 돌아갈 결제 방식
    thenSubmit: boolean // [접수]를 눌러 물었으면 [추가] 뒤 이어서 접수
  } | null>(null)
  const agreed = monthlyFor === senderPhone
  const mustAsk = payment === 'MONTHLY' && canAddMonthly && !agreed
  const blocked = !locked && !!options.find((o) => o.value === payment)?.disabledHint

  return {
    value: payment,
    options,
    locked, // 잠겼으면 칩 대신 글자로
    text: payment ? PAYMENT_METHOD_LABEL[payment] : '미정', // 잠긴 칸 글자 (지점 방문 포함)
    blocked, // 고객이 쓸 수 없는 결제 방식 (기업 설정에서 꺼짐 등)
    error: blocked
      ? `이 고객은 ${PAYMENT_METHOD_LABEL[payment!]}을 쓸 수 없어요. 다른 결제 방식을 골라 주세요.`
      : undefined,
    hint:
      isCompany && options.some((o) => o.disabledHint)
        ? `${payCtx?.company || '소속 기업'}에서 꺼진 결제 수단은 기업 관리에서 켤 수 있어요.`
        : undefined,
    customerSeq: payCtx?.customerSeq ?? null,
    choose: (v: PaymentMethod) => {
      if (v === 'MONTHLY' && canAddMonthly && !agreed)
        setAsking({ revertTo: payment, thenSubmit: false })
      setPayment(v)
    },
    // 개인 고객이 등록 안 된 월결제을 고름 → '홍길동님에게 월결제을 추가할까요?'
    mustAsk, // 월결제이 기본으로 골라져 있어 아직 안 물었으면(새 주문) [접수]에서 물음
    adding: payment === 'MONTHLY' && canAddMonthly && agreed, // 보내기 전에 월결제을 켬
    asking: asking !== null,
    askThenSubmit: () => setAsking({ revertTo: null, thenSubmit: true }),
    /** [추가] — 이어서 접수할지 돌려줌 */
    agree: () => {
      const then = asking?.thenSubmit ?? false
      setMonthlyFor(senderPhone)
      setAsking(null)
      return then
    },
    decline: () => {
      setPayment(asking?.revertTo ?? null)
      setAsking(null)
    },
  }
}
