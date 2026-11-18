export function koreanTime(value) {
  const parts = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(value));
  return parts;
}

// Data comes from the demo service today; a verified order adapter can supply it later.
export function paymentMessage(data, paymentUrl) {
  return [
    '[DVA] 택배 결제 안내',
    '',
    '안녕하세요! DVA입니다.',
    '택배 서비스를 이용해 주셔서 감사합니다.',
    '',
    '신청하신 택배 정보를 확인하신 후,',
    '아래 ‘결제하기’ 버튼을 눌러 결제를 진행해 주세요.',
    '',
    `• 주문번호: ${data.orderId}`,
    `• 보내는 분: ${data.senderName}`,
    `• 받는 분: ${data.recipientSummary}`,
    `• 배송 건수: ${data.parcelCount}건`,
    `• 수거 요청일시: ${koreanTime(data.pickupRequestedAt)}`,
    `• 결제금액: ${data.amount.toLocaleString('ko-KR')}원`,
    '',
    `[결제하기](${paymentUrl})`,
    '',
    '오늘도 좋은 하루 보내세요. 감사합니다!',
  ].join('\n');
}
