import { Injectable } from '@nestjs/common';
import { PoolClient } from 'pg';
import { DatabaseService } from '../database/database.service';

export type CardOwner = 'CUSTOMER' | 'ORGANIZATION';
export interface StoredPaymentCard {
  paymentCardSeq: number;
  customerSeq: number | null;
  organizationSeq: number | null;
  requestHash: string;
  providerCustomerKey: string;
  providerEnvironment: 'test' | 'live';
  encryptedBillingKey: string | null;
  issuerCode: string | null;
  maskedNumber: string | null;
  expirationYear: number;
  expirationMonth: number;
  status: 'REGISTERING' | 'ACTIVE' | 'FAILED';
  claimedUntil: Date | null;
  deletedAt: Date | null;
}
const columns = `payment_card_seq AS "paymentCardSeq",customer_seq AS "customerSeq",organization_seq AS "organizationSeq",
 request_hash AS "requestHash",provider_customer_key AS "providerCustomerKey",provider_environment AS "providerEnvironment",
 encrypted_billing_key AS "encryptedBillingKey",issuer_code AS "issuerCode",masked_number AS "maskedNumber",
 expiration_year AS "expirationYear",expiration_month AS "expirationMonth",status,claimed_until AS "claimedUntil",deleted_at AS "deletedAt"`;

@Injectable()
export class PaymentCardsRepository {
  constructor(private readonly database: DatabaseService) {}

  async owner(client: PoolClient, kind: CardOwner, id: number) {
    return (
      await client.query<{ status: string; phoneNumber: string | null }>(
        kind === 'CUSTOMER'
          ? 'SELECT status,phone_number AS "phoneNumber" FROM customers WHERE customer_seq=$1 AND deleted_at IS NULL FOR UPDATE'
          : 'SELECT status,NULL::text AS "phoneNumber" FROM organizations WHERE organization_seq=$1 AND deleted_at IS NULL FOR UPDATE',
        [id],
      )
    ).rows[0];
  }

  async callerBelongs(client: PoolClient, id: number, phone: string, customerId: number | null) {
    return !!(
      await client.query(
        `SELECT 1 FROM memberships m JOIN customers c USING(customer_seq)
       WHERE m.organization_seq=$1 AND c.phone_number=$2 AND ($3::int IS NULL OR c.customer_seq=$3)
       AND m.deleted_at IS NULL AND m.status='ACTIVE' AND c.deleted_at IS NULL AND c.status='ACTIVE'`,
        [id, phone, customerId],
      )
    ).rowCount;
  }

  async registration(client: PoolClient, key: string) {
    return (
      await client.query<StoredPaymentCard>(
        `SELECT ${columns} FROM payment_cards WHERE registration_key=$1 FOR UPDATE`,
        [key],
      )
    ).rows[0];
  }

  async create(
    client: PoolClient,
    kind: CardOwner,
    id: number,
    key: string,
    hash: string,
    environment: string,
    year: number,
    month: number,
  ) {
    return (
      await client.query<StoredPaymentCard>(
        `INSERT INTO payment_cards(customer_seq,organization_seq,registration_key,request_hash,provider_customer_key,
        provider_environment,expiration_year,expiration_month,claimed_until)
       VALUES($1,$2,$3,$4,gen_random_uuid(),$5,$6,$7,clock_timestamp()+interval '90 seconds') RETURNING ${columns}`,
        [
          kind === 'CUSTOMER' ? id : null,
          kind === 'ORGANIZATION' ? id : null,
          key,
          hash,
          environment,
          year,
          month,
        ],
      )
    ).rows[0];
  }

  async renew(client: PoolClient, id: number) {
    await client.query(
      "UPDATE payment_cards SET claimed_until=clock_timestamp()+interval '90 seconds' WHERE payment_card_seq=$1",
      [id],
    );
  }

  async active(kind: CardOwner, id: number, client?: PoolClient) {
    return (
      await (client ?? this.database.pool).query<StoredPaymentCard>(
        `SELECT ${columns} FROM payment_cards WHERE ${kind === 'CUSTOMER' ? 'customer_seq' : 'organization_seq'}=$1 AND status='ACTIVE' AND deleted_at IS NULL`,
        [id],
      )
    ).rows[0];
  }

  async remove(client: PoolClient, kind: CardOwner, ids: number[], except?: number) {
    return (
      await client.query<{ id: number }>(
        `UPDATE payment_cards SET deleted_at=clock_timestamp(),updated_at=clock_timestamp()
       WHERE ${kind === 'CUSTOMER' ? 'customer_seq' : 'organization_seq'}=ANY($1::int[]) AND deleted_at IS NULL AND payment_card_seq<>$2 RETURNING payment_card_seq AS id`,
        [ids, except ?? 0],
      )
    ).rows;
  }

  async activate(
    client: PoolClient,
    id: number,
    encrypted: string,
    issuer: string | null,
    masked: string,
  ) {
    await client.query(
      `UPDATE payment_cards SET status='ACTIVE',encrypted_billing_key=$2,issuer_code=$3,masked_number=$4,
        claimed_until=NULL,updated_at=clock_timestamp() WHERE payment_card_seq=$1`,
      [id, encrypted, issuer, masked],
    );
    return (
      await client.query<StoredPaymentCard>(
        `SELECT ${columns} FROM payment_cards WHERE payment_card_seq=$1`,
        [id],
      )
    ).rows[0];
  }

  async fail(id: number) {
    await this.database.pool.query(
      "UPDATE payment_cards SET status='FAILED',deleted_at=clock_timestamp(),claimed_until=NULL WHERE payment_card_seq=$1 AND status='REGISTERING'",
      [id],
    );
  }

  async claimRevocation(environment: string) {
    return this.database.transaction(async (client) => {
      const row = (
        await client.query<StoredPaymentCard>(
          `SELECT ${columns} FROM payment_cards c WHERE deleted_at IS NOT NULL AND encrypted_billing_key IS NOT NULL
         AND provider_environment=$1 AND (claimed_until IS NULL OR claimed_until<=clock_timestamp())
         AND NOT EXISTS(SELECT 1 FROM order_payment_requests r WHERE r.payment_card_seq=c.payment_card_seq
           AND r.completed_at IS NULL AND r.approval_started_at IS NOT NULL AND NOT r.card_payment_failed)
         ORDER BY deleted_at,payment_card_seq LIMIT 1 FOR UPDATE SKIP LOCKED`,
          [environment],
        )
      ).rows[0];
      if (row) await this.renew(client, row.paymentCardSeq);
      return row;
    });
  }

  async revoked(client: PoolClient, id: number) {
    await client.query(
      'UPDATE payment_cards SET encrypted_billing_key=NULL,claimed_until=NULL WHERE payment_card_seq=$1 AND deleted_at IS NOT NULL',
      [id],
    );
  }
}
