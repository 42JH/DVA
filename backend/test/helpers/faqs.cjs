const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { applicationFixture } = require('./application.cjs');

module.exports = function faqFixture() {
  const f = applicationFixture('FAQ 관리자');
  f.marker = () => 'faq' + randomUUID().replaceAll('-', '');
  f.create = (body, actor = 0, headers = {}) => f.write('POST', '/api/faqs', body, actor, headers);
  f.patch = (id, body, actor = 0, headers = {}) =>
    f.write('PATCH', `/api/faqs/${id}`, body, actor, headers);
  f.ai = (suffix = '', headers = {}) =>
    f.get('/api/ai/faqs' + suffix, 0, { Cookie: undefined, ...headers });
  f.createdId = async (input, actor = 0) => {
    const response = await f.create({ items: [input] }, actor);
    assert.equal(response.status, 204, await response.clone().text());
    assert.equal(await response.text(), '');
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const id = Number(response.headers.get('location').split('/').at(-1));
    assert.ok(id > 0);
    return id;
  };
  f.counts = async () =>
    (
      await f.pool.query(
        "SELECT (SELECT count(*)::int FROM faq_entries) AS faqs,(SELECT count(*)::int FROM audit_logs WHERE target_type='FAQ_ENTRY' AND result='SUCCESS') AS audits,(SELECT count(*)::int FROM faq_change_notifications) AS notifications",
      )
    ).rows[0];
  return f;
};
