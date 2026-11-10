import { PaymentView } from './payments.repository';
const time = (value: string | null) =>
  value
    ? new Intl.DateTimeFormat('ko-KR', {
        timeZone: 'Asia/Seoul',
        dateStyle: 'medium',
        timeStyle: 'short',
        hour12: false,
      }).format(new Date(value))
    : '주문 내역에서 확인';
export function pickupNotice(view: Pick<PaymentView, 'pickupRequestedAt' | 'approvedAt'>) {
  if (!view.pickupRequestedAt)
    return '결제 완료 후 1시간 뒤 (09:00 이전은 당일 09:00, 17:00 초과는 다음날 09:00)';
  return (
    time(view.pickupRequestedAt) +
    (view.approvedAt
      ? ''
      : ' (해당 시각 이후 결제 시 결제 완료 1시간 후로 변경, 09:00 이전은 당일 09:00, 17:00 초과는 다음날 09:00)')
  );
}
