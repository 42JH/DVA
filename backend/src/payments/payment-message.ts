import { PaymentNoticeView } from './payments.repository';
// User data cannot introduce extra lines, links, mentions or Markdown formatting.
const plain = (s: string) =>
  s
    .replace(/[\r\n\t]/g, ' ')
    .replace(/@/g, '＠')
    .replace(/https?:/gi, (value) => value.replace(':', '：'))
    .replace(/www\./gi, 'www．')
    .replace(/([\\`*_[\]<>!])/g, '\\$1');
const deliveryDetails = (view: PaymentNoticeView) =>
  view.parcels
    .map(
      (parcel, index) =>
        `${view.parcels.length > 1 ? `[배송 ${index + 1}]\n` : ''}• 보내는 분: ${plain(parcel.senderName || '발송인')}
• 출발지 주소: ${plain(parcel.originAddress || '주문 내역에서 확인')}
• 받는 분: ${plain(parcel.recipientName || '수령인')}
• 도착지 주소: ${plain(parcel.destinationAddress || '주문 내역에서 확인')}`,
    )
    .join('\n\n');
export function paymentMessage(view: PaymentNoticeView, base: string) {
  return `[DVA] 택배 결제 안내

안녕하세요! DVA입니다.
택배 서비스를 이용해 주셔서 감사합니다.

신청하신 택배 정보를 확인하신 후,
아래 ‘결제하기’ 버튼을 눌러 결제를 진행해 주세요.

• 주문번호: ${view.orderSeq}
${deliveryDetails(view)}
• 수거 요청일시: 결제 완료 후 1시간 뒤
• 결제금액: ${view.amount.toLocaleString('ko-KR')}원

[결제하기](${base}/p/${view.token})

오늘도 좋은 하루 보내세요. 감사합니다!`;
}

export function paymentCompletionMessage(view: PaymentNoticeView, base: string) {
  const time = (value: string | null) =>
    value
      ? new Intl.DateTimeFormat('ko-KR', {
          timeZone: 'Asia/Seoul',
          dateStyle: 'medium',
          timeStyle: 'short',
          hour12: false,
        }).format(new Date(value))
      : '주문 내역에서 확인';
  return `[DVA] 택배 결제 완료 안내

안녕하세요! DVA입니다.
신청하신 택배 요금의 결제가 완료되었습니다.

• 주문번호: ${view.orderSeq}
${deliveryDetails(view)}
• 결제금액: ${view.amount.toLocaleString('ko-KR')}원
• 결제 완료일시: ${time(view.approvedAt)}
• 수거 요청일시: ${time(view.pickupRequestedAt)}

결제 내역과 택배 접수 상태는 아래에서 확인해 주세요.
[주문 확인](${base}/p/${view.token})

이용해 주셔서 감사합니다. 오늘도 좋은 하루 보내세요!`;
}
