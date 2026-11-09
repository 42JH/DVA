// Run inside the dedicated container. Tokens and webhook URLs are never CLI arguments.
try {
  const origin = 'http://127.0.0.1:' + (process.env.PORT || '3000');
  const headers = {
    'Content-Type': 'application/json',
    Authorization: 'Bearer ' + process.env.PAYMENT_TEST_OPERATOR_TOKEN,
  };
  const response = await fetch(origin + '/internal/payment-test/requests', {
    method: 'POST',
    headers,
    body: '{}',
    signal: AbortSignal.timeout(15000),
  });
  if (response.status !== 201) throw new Error();
  const request = await response.json();
  const sent = await fetch(
    origin + '/internal/payment-test/requests/' + request.token + '/notify',
    {
      method: 'POST',
      headers,
      body: '{}',
      signal: AbortSignal.timeout(15000),
    },
  );
  if (!sent.ok) throw new Error();
  const result = await sent.json();
  // The payment link itself is a bearer capability, so do not print it to shared CI logs.
  console.log(
    JSON.stringify({ orderId: request.orderId, notificationStatus: result.notificationStatus }),
  );
  if (result.notificationStatus !== 'SENT') process.exitCode = 1;
} catch {
  console.error(
    'Payment test request was not acknowledged. Check the dedicated request store; do not blindly repeat.',
  );
  process.exitCode = 1;
}
