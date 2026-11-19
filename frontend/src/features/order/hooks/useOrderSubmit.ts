// 주문 폼 보내기 — 추가(POST) · 수정(PATCH, 접수 중단이면 이어서 접수) · 미완료 초안 접수, 그 뒤 고객정보 저장
// 주문은 저장됐는데 고객정보 저장만 실패하면 고객만 다시 보냄(주문 PATCH는 다시 안 함)
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useRef, useState } from 'react'
import { ApiError } from '@/shared/api/client'
import {
  addMonthly,
  createOrder,
  patchCustomer,
  submitOrder,
  orderQueries,
  saveOrder,
  type OrderDetail,
  type OrderInput,
  type Party,
  type PartyInput,
} from '../api/orderApi'
import { orderErrorText } from '../labels'
import { submitDraft } from '../api/draftApi'
import type { CustomerPatch, OrderPatch } from '../api/orderPatch'
import { customerQueries } from '@/shared/customer/customerApi'
import { submitResultText } from './orderForm'

/** 주소를 다시 안 골랐으면(수정 · 초안) 원래 주소의 나머지 칸으로 (새 고객 생성에 필요) */
const withOldAddress = (sender: PartyInput, was?: Party): PartyInput => ({
  ...sender,
  picked: sender.picked ?? {
    jibunAddress: was?.jibunAddress ?? '',
    dongName: was?.dongName ?? '',
    postalCode: was?.postalCode ?? '',
  },
})

export function useOrderSubmit(p: {
  order: OrderDetail | undefined
  onDone: (notice?: string, newOrderSeq?: number) => void // notice = 접수 중단 주문 접수 결과 · newOrderSeq = 초안을 접수해 생긴 주문
  onConflict?: () => void
  input: () => OrderInput // 보내는 순간의 폼 값
  shippingFee: number
  collecting: boolean // 접수 중단 주문 — 저장하면서 접수
  patch: OrderPatch | null // 수정에서 바뀐 칸 (없으면 PATCH 안 함)
  customerDraft: CustomerPatch | null // 보내는 분 이름 · 주소가 바뀌었으면 고객정보에 저장할 내용
  payCustomerSeq: number | null // 보내는 분 번호로 찾은 고객
}) {
  const qc = useQueryClient()
  const { order } = p
  const [finished, setFinished] = useState(false) // 저장 · 접수 성공 — 창이 닫힐 때까지 다시 못 보냄
  const [customerFail, setCustomerFail] = useState<{ body: CustomerPatch; error: unknown } | null>(
    null,
  )
  const submitNotice = useRef<string | undefined>(undefined) // 접수 결과 — 고객정보 재시도 뒤 닫을 때도 전달
  const madeOrder = useRef<number | undefined>(undefined) // 초안을 접수해 새로 생긴 주문
  const finish = async () => {
    if (order?.draft) {
      // 초안은 접수되면 사라짐 → 먼저 새 주문으로 넘어간 뒤 목록 · 건수를 새로 받음 (사라진 초안을 다시 묻지 않게)
      p.onDone(submitNotice.current, madeOrder.current)
      void qc.invalidateQueries({ queryKey: ['screen'] })
      void qc.invalidateQueries({ queryKey: orderQueries.all() })
      return
    }
    await qc.invalidateQueries({ queryKey: orderQueries.all() }) // 다 끝난 뒤에 — 먼저 하면 새 버전으로 창이 다시 채워짐
    void qc.invalidateQueries({ queryKey: ['screen'] }) // 목록 줄 · 탭 건수도 (수정해도 목록이 옛 값)
    p.onDone(submitNotice.current, madeOrder.current)
  }

  // 멱등키: 같은 본문을 다시 보내면(실패 후 재시도) 같은 키, 본문이 바뀌면 새 키 (명세서 1.2)
  const sent = useRef<{ body: string; key: string } | null>(null)
  const keyFor = (json: string) => {
    if (sent.current?.body !== json) sent.current = { body: json, key: crypto.randomUUID() }
    return sent.current.key
  }
  /** 배송 초안(미완료, 055): 채운 내용으로 새 초안을 만들어 바로 접수. 같은 본문을 다시 보내면 같은 키 → 서버가 같은 초안을 돌려줌
   * 키는 초안 본문(수거 · 결제 빼고)으로만 — 접수만 실패해 수거 시각 · 결제만 고쳐 다시 눌러도 같은 초안으로 접수 */
  const sendDraft = async (draft: OrderDetail, body: OrderInput) => {
    const key = keyFor(
      JSON.stringify([{ ...body, pickupAt: null, paymentMethod: null }, p.shippingFee]),
    )
    const r = await submitDraft(draft, body, p.shippingFee, key)
    madeOrder.current = r.orderSeq
    submitNotice.current = submitResultText(r.status)
  }
  /** 수정 저장. 접수 중단이면 저장한 새 버전으로 최종 접수 — 실패해도 저장은 유지, 이유를 들고 상세로 */
  const saveEdit = async (o: OrderDetail) => {
    let version = o.version ?? 0
    if (p.patch) version = (await saveOrder(o.orderSeq, p.patch)).data.version
    if (!p.collecting) return
    try {
      const r = await submitOrder(o.orderSeq, version)
      submitNotice.current = submitResultText(r.data.status)
    } catch (e) {
      submitNotice.current = `저장은 됐지만 접수하지 못했어요. ${orderErrorText(e, '접수')}`
    }
  }
  /** 주문 저장이 성공한 뒤에만 고객 PATCH — 별도 트랜잭션 */
  const saveCustomer = async (o: OrderDetail): Promise<'ok' | 'customerFailed'> => {
    if (!p.customerDraft || !o.customerSeq) return 'ok'
    try {
      await patchCustomer(o.customerSeq, p.customerDraft)
    } catch (error) {
      setCustomerFail({ body: p.customerDraft, error })
      return 'customerFailed'
    }
    return 'ok'
  }

  const mutation = useMutation({
    // alsoCustomer = '고객정보에도 저장'을 골랐는지
    // monthly = 보내기 전에 보내는 분에게 월결제을 켤지 — 상태가 아니라 인자로 ([추가] 직후 이어서 접수하면 상태가 아직 옛 값)
    mutationFn: async ({
      alsoCustomer,
      monthly,
    }: {
      alsoCustomer: boolean
      monthly: boolean
    }): Promise<'ok' | 'customerFailed'> => {
      const body = p.input()
      // 월결제 먼저 — 서버가 접수 순간 자격을 확인
      const newCustomer = monthly
        ? await addMonthly(
            order?.customerSeq ?? p.payCustomerSeq,
            withOldAddress(body.sender, order?.sender),
          )
        : undefined
      if (!order) {
        const key = keyFor(JSON.stringify([body, p.shippingFee]))
        await createOrder(body, p.shippingFee, key, newCustomer) // 초안 · 수정은 고객이 이미 있거나 customerFor가 방금 만든 고객을 찾음
        // 서버가 받는 분을 주문 고객 주소록에 자동 등록 (백엔드) → 다음 주문 추천에 바로 뜨게
        void qc.invalidateQueries({ queryKey: customerQueries.all() })
        return 'ok'
      }
      if (order.draft) await sendDraft(order, body)
      else await saveEdit(order)
      return alsoCustomer ? saveCustomer(order) : 'ok'
    },
    onSuccess: (result) => {
      if (result === 'ok') {
        setFinished(true) // 목록을 새로 받는 동안 [저장]을 또 누르면 옛 버전으로 다시 보내 409가 남
        void finish()
      }
    },
    onError: (e) => {
      if (e instanceof ApiError && e.code === 'VERSION_CONFLICT') p.onConflict?.()
      // 채우던 미완료가 그새 사라졌으면(24시간 · 더 최신 통화) 목록 · 건수를 다시 읽음 (백엔드 후속 명세 11/09)
      if (order?.draft && e instanceof ApiError && e.status === 404)
        void qc.invalidateQueries({ queryKey: ['screen'] })
    },
  })

  const retry = useMutation({
    mutationFn: (body: CustomerPatch) => patchCustomer(order!.customerSeq!, body),
    onSuccess: () => void finish(),
  })

  return { mutation, retry, finish, finished, customerFail }
}
