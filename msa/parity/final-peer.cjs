// Disposable AI/Dver responses using the same contracts as the original integration fixtures.
const assert = require('node:assert/strict');
const { createServer } = require('node:http');
assert.equal(process.env.NODE_ENV, 'test');
const token = process.env.FINAL_SERVICE_TOKEN;
assert.ok(token?.length >= 32);
const requests = [];
const json = (response, value) => {
  response.setHeader('Content-Type', 'application/json');
  response.end(JSON.stringify(value));
};
createServer(async (request, response) => {
  try {
    if (request.method === 'GET' && request.url === '/health') return json(response, { status: 'ok' });
    const authorized = request.url === '/parcel' ? request.headers['x-api-key'] === token
      : request.headers.authorization === 'Bearer ' + token;
    if (!authorized) return response.writeHead(401).end();
    if (request.method === 'GET' && request.url === '/__requests') return json(response, requests);
    let text = '';
    for await (const chunk of request) { text += chunk; assert.ok(text.length <= 65536); }
    const body = text ? JSON.parse(text) : null;
    requests.push({ method: request.method, path: request.url, body });
    if (request.method === 'GET' && request.url === '/internal/persona/options')
      return json(response, { voices: [{ id: 'test-voice', label: '검증 음성' }],
        speakingRate: { min: 0.8, max: 1.2 }, turnWaitLevels: ['SHORT', 'NORMAL', 'LONG'] });
    if (request.method === 'POST' && request.url === '/parcel') {
      assert.ok(Array.isArray(body.outboundParcels) && body.outboundParcels.length > 0);
      return json(response, { ok: true, parcelNo: 'TEST0052', receivedAt: new Date().toISOString() });
    }
    if (request.method === 'POST' && ['/internal/persona/refresh', '/internal/faqs/refresh'].includes(request.url))
      return response.writeHead(202).end();
    response.writeHead(404).end();
  } catch {
    response.writeHead(500).end();
    process.exitCode = 1;
  }
}).listen(8000, '0.0.0.0');
