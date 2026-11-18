import { koreanTime } from './message.mjs';

const escape = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (c) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      })[c],
  );

export function paymentPage(record, config, token, mode) {
  const payload = JSON.stringify({
    ...record,
    token,
    mode,
    clientKey: config.clientKey,
    publicUrl: config.publicUrl,
  }).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>DVA 택배 결제</title>
<link rel="stylesheet" href="${config.publicUrl}/assets/style.css">
<script src="https://js.tosspayments.com/v2/standard" defer></script>
<script src="${config.publicUrl}/assets/checkout.js" defer></script></head>
<body><main><header><a class="brand" href="#">DVA</a><span class="badge">테스트 결제</span></header>
<h1>택배 결제 안내</h1><p class="intro">안녕하세요! 신청하신 택배 정보를 확인해 주세요.</p>
<section class="card" aria-label="택배 신청 내역"><dl>
<div><dt>주문번호</dt><dd class="order">${escape(record.orderId)}</dd></div>
<div><dt>보내는 분</dt><dd>${escape(record.senderName)}</dd></div>
<div><dt>받는 분</dt><dd>${escape(record.recipientSummary)}</dd></div>
<div><dt>배송 건수</dt><dd>${record.parcelCount}건</dd></div>
<div><dt>수거 요청일시</dt><dd>${escape(koreanTime(record.pickupRequestedAt))} KST</dd></div>
</dl><div class="total"><span>결제금액</span><strong>${record.amount.toLocaleString('ko-KR')}<small>원</small></strong></div></section>
<p class="test-note">토스페이먼츠 테스트 환경입니다. 실제 금액은 청구되지 않습니다.</p>
<section id="payment-method" aria-label="결제수단"></section><section id="agreement" aria-label="이용약관"></section>
<p id="status" role="status" aria-live="polite">결제 정보를 확인하고 있어요.</p>
<button id="pay" disabled>결제하기</button><button id="reconcile" hidden>결제 결과 다시 확인</button>
<a id="back" href="${config.publicUrl}/p/${token}" hidden>택배 정보로 돌아가기</a>
<p class="footer">DVA를 이용해 주셔서 감사합니다.</p></main>
<script id="payment-data" type="application/json">${payload}</script></body></html>`;
}
