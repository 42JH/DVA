// 주문의 화면 모양 타입 — orderApi(받아 오기) · orderDto(서버 응답 변환) · draftApi · labels가 같이 씀
// 타입만 둠: 이 파일은 주문 폴더의 다른 파일을 import하지 않음 (서로 물고 도는 import를 막으려고 따로 둠)
import type { KindCounts } from '@/shared/lib/callKind'

/** 주문 상태 (서버). COLLECTING 수집 중 · notPaid 결제 대기 · PAID 결제 완료 · SUBMITTING 디버 접수 중
 * · SUBMITTING_FAILED 디버 접수 실패(자동 재시도 중, 11/03) · ACCEPTED 디버 접수 완료 · SUBMISSION_FAILED 디버 접수 최종 실패 · CANCELLED 취소 */
export type OrderStatusDto =
  | 'COLLECTING'
  | 'notPaid'
  | 'PAID'
  | 'SUBMITTING'
  | 'SUBMITTING_FAILED'
  | 'ACCEPTED'
  | 'SUBMISSION_FAILED'
  | 'CANCELLED'

export interface Party {
  name: string
  phoneNumber: string // 숫자만
  roadAddress: string
  detailAddress: string | null
  // 서버 주소의 나머지 칸 (실서버 응답에만, 11/01) — 고객정보 저장은 주소 전체가 필요해서
  jibunAddress?: string
  dongName?: string
  postalCode?: string
}

// 월결제 · 그룹카드 · 개인카드 (디버 10/27) + 지점 방문(예전 주문 조회만 — 서버 cat, 새로 고를 수 없음)
export type PaymentMethod = 'MONTHLY' | 'GROUP_CARD' | 'PERSONAL_CARD' | 'BRANCH_VISIT'
export type PaymentState = 'PAID' | 'UNPAID' | 'CANCELLED_BEFORE_PAYMENT'

/** 주문 상세 (디자인 03_주문내역_주문상세 · _전화, 06 '주문 보기' 팝업과 같은 내용 · 읽기 전용) */
export interface OrderDetail {
  orderSeq: number
  route: 'PHONE' | 'MANUAL' // 전화 · 수기
  manualBy: string | null // 수기 접수한 관리자 이름 ('수기 접수 이재훈'). 전화 접수면 null
  acceptedAt: string
  cancelled: boolean
  sender: Party
  receiver: Party
  items: { document: number; small: number; medium: number; big: number; other: string | null }
  pickupRequestedAt: string | null // 수기 접수에서 비워 둘 수 있음 (10/31)
  itemPrice: number | null // 수기 접수에서 비워 둘 수 있음
  clientComment: string | null
  paymentMethod: PaymentMethod | null // null = 미정 — 접수 전에 골라야 함
  paymentState: PaymentState
  relatedCalls: {
    callSessionSeq: number
    startedAt: string
    kind: 'ACCEPT' | 'CANCEL'
    counts?: KindCounts // 그 통화의 상담 유형 횟수 — 04 줄과 같은 칩 (null = 분석 전, 없으면 kind로 한 칩)
  }[]
  /** 배송 상세마다 (03 목록 줄 = 상세 하나, 11/01). 위 sender · receiver · items는 첫 상세 · 합계(06 팝업 기본값)
   * 메모리 가짜 주문엔 없음 → 없으면 위 값 그대로 */
  parcels?: ParcelDetail[]
  /** 수정용 (03 주문 수정, 11/01) — 메모리 가짜 주문엔 없음 */
  version?: number // 다음 수정의 expectedVersion
  notifiedPrice?: number | null // 배송비 (첫 상세 · pickParcel이면 고른 상세) — 접수 중단 주문 접수에 필요
  customerSeq?: number | null // 주문 고객 — 보내는 분 수정을 고객정보에도 저장할 때 (미완료 주문은 null)
  status?: OrderStatusDto // 실제 상태 — 결제 방식은 COLLECTING에서만 바꿀 수 있음
  draft?: { draftSeq: number; label: string } // 미완료 = 배송 초안 (orderSeq는 -draftSeq, 055)
}

/** 배송 상세 하나 — 보내는 분 1 + 받는 분 1 */
interface ParcelDetail {
  orderParcelSeq: number
  cancelled: boolean
  sender: Party
  receiver: Party
  items: OrderDetail['items']
  itemPrice: number | null
  clientComment: string | null
  notifiedPrice: number | null
}
