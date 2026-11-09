import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PaymentError } from './errors.mjs';
import { paymentPage } from './page.mjs';

export async function paymentServer(config, service) {
  const assets = new Map(
    await Promise.all(
      ['checkout.js', 'style.css'].map(async (name) => [
        name,
        await readFile(new URL('./public/' + name, import.meta.url)),
      ]),
    ),
  );
  const origin = new URL(config.publicUrl).origin;
  async function body(req) {
    if (!/^application\/json(?:\s*;.*)?$/i.test(req.headers['content-type'] || ''))
      throw new PaymentError(415, 'JSON_REQUIRED');
    let size = 0;
    const chunks = [];
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 8192) throw new PaymentError(413, 'PAYLOAD_TOO_LARGE');
      chunks.push(chunk);
    }
    try {
      const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!result || Array.isArray(result) || typeof result !== 'object') throw new Error();
      return result;
    } catch {
      throw new PaymentError(400, 'INVALID_REQUEST');
    }
  }
  function operator(req) {
    const actual = Buffer.from(req.headers.authorization || '');
    const expected = Buffer.from('Bearer ' + config.operatorToken);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
      throw new PaymentError(401, 'UNAUTHORIZED');
  }
  const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    // The official widget sizes its iframes with inline style attributes.
    // Inline scripts and inline style elements remain disallowed.
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self' https://js.tosspayments.com; style-src 'self'; style-src-attr 'unsafe-inline'; connect-src 'self' https://*.tosspayments.com https://*.toss.im; frame-src https:; img-src 'self' data: https:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    );
    const json = (status, value) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(value));
    };
    try {
      const url = new URL(req.url, origin);
      const path = url.pathname;
      if (req.method === 'GET' && path === '/health') return json(200, { status: 'ok' });
      const asset = path.match(/^\/payment-test\/assets\/(checkout\.js|style\.css)$/);
      if (req.method === 'GET' && asset) {
        res.writeHead(200, {
          'Content-Type': asset[1].endsWith('.js')
            ? 'text/javascript; charset=utf-8'
            : 'text/css; charset=utf-8',
        });
        return res.end(assets.get(asset[1]));
      }
      const control = path.match(
        /^\/internal\/payment-test\/requests(?:\/([a-f0-9]{64})\/notify)?$/,
      );
      if (req.method === 'POST' && control) {
        operator(req);
        if (Object.keys(await body(req)).length) throw new PaymentError(400, 'EMPTY_BODY_REQUIRED');
        return json(
          control[1] ? 200 : 201,
          control[1] ? await service.notify(control[1]) : await service.createSample(),
        );
      }
      const api = path.match(
        /^\/payment-test\/api\/requests\/([a-f0-9]{64})(?:\/(confirm|reconcile))?$/,
      );
      if (api) {
        if (req.method === 'GET' && !api[2]) return json(200, await service.read(api[1]));
        if (req.method === 'POST' && api[2]) {
          if (req.headers.origin !== origin) throw new PaymentError(403, 'ORIGIN_REQUIRED');
          const input = await body(req);
          if (api[2] === 'reconcile' && Object.keys(input).length)
            throw new PaymentError(400, 'EMPTY_BODY_REQUIRED');
          return json(
            200,
            api[2] === 'confirm'
              ? await service.confirm(api[1], input)
              : await service.reconcile(api[1]),
          );
        }
      }
      const page = path.match(/^\/payment-test\/(p|success|fail)\/([a-f0-9]{64})$/);
      if (req.method === 'GET' && page) {
        const record = await service.read(page[2]);
        const mode = { p: 'checkout', success: 'success', fail: 'failure' }[page[1]];
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(paymentPage(record, config, page[2], mode));
      }
      return json(404, { error: { code: 'NOT_FOUND' } });
    } catch (error) {
      if (!res.headersSent)
        json(error instanceof PaymentError ? error.status : 500, {
          error: { code: error instanceof PaymentError ? error.code : 'INTERNAL_ERROR' },
        });
      else res.end();
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.maxHeadersCount = 50;
  return server;
}
