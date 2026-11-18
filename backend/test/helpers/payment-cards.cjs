const assert = require('node:assert/strict');
const { randomUUID, randomBytes, createCipheriv } = require('node:crypto');
assert.equal(process.env.NODE_ENV, 'test');
process.env.TOSS_BILLING_SECRET_KEY ||= 'test_sk_card_fixture';
process.env.PAYMENT_CARD_ENCRYPTION_KEY ||= 'ab'.repeat(32);

async function seedTestCard(pool, kind, id) {
  const ownerColumn = kind === 'CUSTOMER' ? 'customer_seq' : 'organization_seq';
  const existing = await pool.query(
    `SELECT payment_card_seq FROM payment_cards WHERE ${ownerColumn}=$1 AND status='ACTIVE' AND deleted_at IS NULL`,
    [id],
  );
  if (existing.rowCount) return existing.rows[0].payment_card_seq;
  const card = (
    await pool.query(
      `INSERT INTO payment_cards(${ownerColumn},registration_key,request_hash,provider_customer_key,provider_environment,expiration_year,expiration_month)
    VALUES($1,$2,'fixture',$3,'test',$4,12) RETURNING payment_card_seq`,
      [id, randomUUID(), randomUUID(), new Date().getUTCFullYear() + 2],
    )
  ).rows[0].payment_card_seq;
  const iv = randomBytes(12);
  const cipher = createCipheriv(
    'aes-256-gcm',
    Buffer.from(process.env.PAYMENT_CARD_ENCRYPTION_KEY, 'hex'),
    iv,
  );
  cipher.setAAD(Buffer.from(String(card)));
  const encrypted = Buffer.concat([
    iv,
    cipher.update('fixture-billing-' + card),
    cipher.final(),
    cipher.getAuthTag(),
  ]).toString('base64');
  await pool.query(
    "UPDATE payment_cards SET status='ACTIVE',encrypted_billing_key=$2,masked_number='************1111',issuer_code='61' WHERE payment_card_seq=$1",
    [card, encrypted],
  );
  return card;
}

function configureTestCardPayments(app) {
  const { ConfigService } = require('@nestjs/config');
  const { CardProviderClient } = require('../../dist/payments/card-provider.client');
  const config = app.get(ConfigService);
  config.set('ORDER_PAYMENTS_ENABLED', true);
  config.set('TOSS_BILLING_SECRET_KEY', process.env.TOSS_BILLING_SECRET_KEY);
  config.set('PAYMENT_CARD_ENCRYPTION_KEY', process.env.PAYMENT_CARD_ENCRYPTION_KEY);
  const provider = app.get(CardProviderClient);
  provider.approve = async (orderId, amount) => ({
    status: 200,
    data: {
      orderId,
      totalAmount: amount,
      paymentKey: 'fixture-card-' + orderId,
      currency: 'KRW',
      status: 'DONE',
      approvedAt: new Date().toISOString(),
    },
  });
  provider.revoke = async () => ({ status: 200, data: {} });
}
module.exports = { seedTestCard, configureTestCardPayments };
