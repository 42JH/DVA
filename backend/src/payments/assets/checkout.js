/* global TossPayments */
const data = JSON.parse(document.getElementById('payment-data').textContent);
const status = document.getElementById('status');
const pay = document.getElementById('pay');
const check = document.getElementById('reconcile');
const back = document.getElementById('back');
const query = new URLSearchParams(location.search);
// Provider identifiers must not remain in the address bar or outgoing referrers.
history.replaceState(null, '', location.pathname);
const api = data.apiUrl;

const descriptions = {
  PAID: '결제가 완료됐어요. 감사합니다!',
  PENDING: '결제수단을 선택하고 결제를 진행해 주세요.',
  CONFIRMING: '결제 승인을 확인하고 있어요. 잠시만 기다려 주세요.',
  REVIEW_REQUIRED:
    '결제 결과를 확인하고 있어요. 결제를 다시 진행하지 말고 결과 확인을 눌러 주세요.',
  FAILED: '결제가 승인되지 않았어요. 운영자에게 새 테스트 링크를 요청해 주세요.',
  EXPIRED: '결제 링크가 만료됐어요. 운영자에게 새 테스트 링크를 요청해 주세요.',
  CANCELLED: '취소되었거나 금액이 변경된 결제 링크예요. 새 안내 메시지를 확인해 주세요.',
};
function show(record) {
  status.textContent = descriptions[record.status] || '결제 상태를 확인할 수 없어요.';
  if (record.status === 'PAID' && record.pickupRequestedAt)
    document.getElementById('pickup-time').textContent = new Intl.DateTimeFormat('ko-KR', {
      timeZone: 'Asia/Seoul',
      dateStyle: 'medium',
      timeStyle: 'short',
      hour12: false,
    }).format(new Date(record.pickupRequestedAt));
  if (record.status === 'PAID')
    status.textContent =
      record.orderStatus === 'ACCEPTED'
        ? '결제와 택배 접수가 완료됐어요. 감사합니다!'
        : '결제는 완료됐어요. 택배 접수 결과를 확인하고 있어요.';
  pay.hidden = record.status !== 'PENDING' || data.mode !== 'checkout';
  check.hidden = !['REVIEW_REQUIRED', 'CONFIRMING'].includes(record.status);
  check.disabled = false;
}
async function request(suffix, body) {
  const response = await fetch(api + suffix, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    credentials: 'omit',
    signal: AbortSignal.timeout(15000),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error?.code || 'REQUEST_FAILED');
  return result.data;
}
async function state() {
  const response = await fetch(api, { credentials: 'omit', cache: 'no-store' });
  if (!response.ok) throw new Error('STATE_UNAVAILABLE');
  return (await response.json()).data;
}
check.addEventListener('click', async () => {
  check.disabled = true;
  try {
    let current;
    try {
      current = await request('/reconcile', {});
    } catch {
      current = await state();
    }
    show(current);
    if (current.status === 'PENDING') {
      // This page may have opened before the payment widgets could initialize.
      pay.hidden = true;
      back.hidden = false;
      status.textContent = '결제가 승인되지 않았어요. 택배 정보로 돌아가 다시 진행해 주세요.';
    }
  } catch {
    check.disabled = false;
    status.textContent = '아직 결과를 확인하지 못했어요. 잠시 후 결과 확인을 다시 눌러 주세요.';
  }
});

async function start() {
  let record = await state();
  show(record);
  if (record.status !== 'PENDING') return;
  if (data.mode === 'success') {
    status.textContent = '토스에서 결제 승인을 확인하고 있어요.';
    const rawAmount = query.get('amount');
    if (
      !rawAmount ||
      !/^\d+$/.test(rawAmount) ||
      !query.get('orderId') ||
      !query.get('paymentKey')
    ) {
      status.textContent = '결제 인증 정보를 확인할 수 없어요.';
      back.hidden = false;
      return;
    }
    try {
      record = await request('/confirm', {
        orderId: query.get('orderId'),
        paymentKey: query.get('paymentKey'),
        amount: Number(rawAmount),
      });
      show(record);
    } catch {
      const current = await state();
      show(current);
      if (['PENDING', 'FAILED'].includes(current.status)) {
        status.textContent = '결제를 완료하지 못했어요. 택배 정보와 결제 결과를 확인해 주세요.';
        back.hidden = false;
      }
    }
    return;
  }
  if (data.mode === 'failure') {
    status.textContent = ['PAY_PROCESS_CANCELED', 'USER_CANCEL'].includes(query.get('code'))
      ? '결제를 중단했어요. 원하실 때 다시 진행해 주세요.'
      : '결제를 진행하지 못했어요. 다시 시도하거나 운영자에게 문의해 주세요.';
    back.hidden = false;
    return;
  }
  const widgets = TossPayments(data.clientKey).widgets({ customerKey: TossPayments.ANONYMOUS });
  await widgets.setAmount({ currency: 'KRW', value: record.amount });
  await widgets.renderPaymentMethods({ selector: '#payment-method', variantKey: 'DEFAULT' });
  await widgets.renderAgreement({ selector: '#agreement', variantKey: 'AGREEMENT' });
  pay.disabled = false;
  pay.addEventListener('click', async () => {
    pay.disabled = true;
    try {
      const current = await state();
      if (current.status !== 'PENDING') {
        show(current);
        return;
      }
      await widgets.requestPayment({
        orderId: current.orderId,
        orderName: current.orderName,
        successUrl: `${data.publicUrl}/success/${data.token}`,
        failUrl: `${data.publicUrl}/fail/${data.token}`,
      });
    } catch {
      status.textContent = '결제를 완료하지 않았어요. 결제 정보를 확인하고 다시 진행해 주세요.';
      pay.disabled = false;
    }
  });
}
start().catch(() => {
  pay.disabled = true;
  status.textContent = '결제 화면을 불러오지 못했어요. 잠시 후 페이지를 새로 열어 주세요.';
  back.hidden = false;
});
