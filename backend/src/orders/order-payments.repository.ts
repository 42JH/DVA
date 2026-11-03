import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { PoolClient } from 'pg';
import { OrganizationBillingService } from '../organizations/organization-billing.service';

export interface PaymentRequest {
  paymentRequestId: string;
  orderSeq: number;
  amount: number;
  expiresAt: Date;
  approvalStartedAt: Date | null;
  invalidatedAt: Date | null;
  completedAt: Date | null;
  providerReference: string | null;
  providerPaymentKey: string | null;
  providerApprovedAt: Date | null;
  approvalClaimId: string | null;
  approvalClaimedUntil: Date | null;
  notificationStatus: string;
}

@Injectable()
export class OrderPaymentsRepository {
  async reserveApproval(client: PoolClient, id: string, key: string, claimId: string) {
    await client.query(
      `UPDATE order_payment_requests SET provider_payment_key=$2,
        approval_started_at=COALESCE(approval_started_at,clock_timestamp()),approval_claim_id=$3,
        approval_claimed_until=clock_timestamp()+interval '45 seconds' WHERE payment_request_id=$1`,
      [id, key, claimId],
    );
  }

  async queueNotification(client: PoolClient, id: string) {
    await client.query(
      "UPDATE order_payment_requests SET notification_status='PENDING',notification_attempted_at=NULL,notification_sent_at=NULL WHERE payment_request_id=$1",
      [id],
    );
  }

  async completionStatus(client: PoolClient, id: string): Promise<string> {
    return (
      await client.query<{ status: string }>(
        'SELECT completion_notification_status AS status FROM order_payment_requests WHERE payment_request_id=$1',
        [id],
      )
    ).rows[0].status;
  }

  async queueCompletionNotification(client: PoolClient, id: string) {
    await client.query(
      `UPDATE order_payment_requests SET completion_notification_status='PENDING',
        completion_notification_attempted_at=NULL,completion_notification_sent_at=NULL WHERE payment_request_id=$1`,
      [id],
    );
  }
  constructor(
    private readonly billing: OrganizationBillingService,
    private readonly database: DatabaseService,
  ) {}
  async eligibility(client: PoolClient, customerId: number) {
    const customer = (
      await client.query<{ monthlyBillingEnabled: boolean }>(
        `SELECT monthly_billing_enabled AS "monthlyBillingEnabled" FROM customers WHERE customer_seq=$1 AND status='ACTIVE' AND deleted_at IS NULL FOR SHARE`,
        [customerId],
      )
    ).rows[0];
    const member = (
      await client.query<{
        organizationSeq: number;
        departmentSeq: number | null;
        membershipStatus: string;
        organizationStatus: string;
        monthlyBillingEnabled: boolean;
      }>(
        `SELECT m.organization_seq AS "organizationSeq",m.department_seq AS "departmentSeq",m.status AS "membershipStatus",o.status AS "organizationStatus",
       o.monthly_billing_enabled AS "monthlyBillingEnabled"
       FROM memberships m JOIN organizations o USING(organization_seq)
       WHERE m.customer_seq=$1 AND m.deleted_at IS NULL AND o.deleted_at IS NULL FOR SHARE OF m,o`,
        [customerId],
      )
    ).rows[0];
    const department =
      member?.departmentSeq != null
        ? (
            await client.query<{ groupBillingEnabled: boolean }>(
              'SELECT group_billing_enabled AS "groupBillingEnabled" FROM departments WHERE department_seq=$1 AND deleted_at IS NULL FOR SHARE',
              [member.departmentSeq],
            )
          ).rows[0]
        : undefined;
    const active = member?.membershipStatus === 'ACTIVE' && member.organizationStatus === 'ACTIVE';
    return {
      monthly:
        !!customer &&
        (member ? active && member.monthlyBillingEnabled : customer.monthlyBillingEnabled),
      group: !!customer && !!active && department?.groupBillingEnabled === true,
      organizationSeq: active ? member.organizationSeq : null,
      departmentSeq: active ? member.departmentSeq : null,
    };
  }
  async waitForPayment(client: PoolClient, id: number) {
    await client.query(
      "UPDATE orders SET status='notPaid',pickup_requested_at=NULL,payment_due_at=clock_timestamp()+interval '24 hours' WHERE order_seq=$1",
      [id],
    );
    await this.replaceRequest(client, id);
  }
  async replaceRequest(client: PoolClient, id: number) {
    await client.query(
      'UPDATE order_payment_requests SET invalidated_at=clock_timestamp() WHERE order_seq=$1 AND invalidated_at IS NULL AND completed_at IS NULL',
      [id],
    );
    await client.query(
      `INSERT INTO order_payment_requests(order_seq,amount,expires_at)
      SELECT order_seq,total_amount,payment_due_at FROM orders WHERE order_seq=$1 AND status='notPaid' AND total_amount>0`,
      [id],
    );
  }
  async isApproving(client: PoolClient, id: number) {
    return (
      (
        await client.query(
          `SELECT 1 FROM order_payment_requests WHERE order_seq=$1 AND invalidated_at IS NULL AND completed_at IS NULL AND approval_started_at IS NOT NULL`,
          [id],
        )
      ).rowCount !== 0
    );
  }
  async billed(
    client: PoolClient,
    id: number,
    organizationId: number | null,
    departmentId: number | null,
    requestId: string,
    approvedAt?: string,
  ) {
    await client.query(
      `WITH paid AS (SELECT COALESCE($4::timestamptz,clock_timestamp()) AS at)
       UPDATE orders SET status='PAID',paid_at=paid.at,pickup_requested_at=paid.at+interval '1 hour',
       billing_organization_seq=$2,billing_department_seq=$3,
       billing_organization_name=(SELECT name FROM organizations WHERE organization_seq=$2),
       billing_department_name=(SELECT name FROM departments WHERE department_seq=$3)
       FROM paid WHERE order_seq=$1`,
      [id, organizationId, departmentId, approvedAt ?? null],
    );
    await this.billing.recordCharge(client, id, requestId);
  }
  async request(client: PoolClient, id: string) {
    // All payment/cancellation paths lock the parent before its request.
    const parent = (
      await client.query<{ orderSeq: number }>(
        'SELECT order_seq AS "orderSeq" FROM order_payment_requests WHERE payment_request_id=$1',
        [id],
      )
    ).rows[0];
    if (!parent) return undefined;
    const order = (
      await client.query<{ status: string; totalAmount: number; paidAt: Date | null }>(
        'SELECT status,total_amount AS "totalAmount",paid_at AS "paidAt" FROM orders WHERE order_seq=$1 AND deleted_at IS NULL FOR UPDATE',
        [parent.orderSeq],
      )
    ).rows[0];
    if (!order) return undefined;
    const request = (
      await client.query<PaymentRequest>(
        `SELECT payment_request_id AS "paymentRequestId",order_seq AS "orderSeq",amount,expires_at AS "expiresAt",approval_started_at AS "approvalStartedAt",invalidated_at AS "invalidatedAt",completed_at AS "completedAt",provider_reference AS "providerReference",provider_payment_key AS "providerPaymentKey",provider_approved_at AS "providerApprovedAt",approval_claim_id AS "approvalClaimId",approval_claimed_until AS "approvalClaimedUntil",notification_status AS "notificationStatus" FROM order_payment_requests WHERE payment_request_id=$1 FOR UPDATE`,
        [id],
      )
    ).rows[0];
    return { ...request, order };
  }
  async begin(client: PoolClient, id: string) {
    await client.query(
      'UPDATE order_payment_requests SET approval_started_at=clock_timestamp() WHERE payment_request_id=$1',
      [id],
    );
  }
  async release(client: PoolClient, id: string) {
    await client.query(
      'UPDATE order_payment_requests SET approval_started_at=NULL WHERE payment_request_id=$1 AND completed_at IS NULL AND invalidated_at IS NULL',
      [id],
    );
  }
  async complete(client: PoolClient, id: string, reference: string) {
    await client.query(
      "UPDATE order_payment_requests SET completed_at=clock_timestamp(),provider_reference=$2,approval_claim_id=NULL,approval_claimed_until=NULL,completion_notification_status='PENDING' WHERE payment_request_id=$1",
      [id, reference],
    );
  }

  async releaseClaim(id: string, claimId: string, declined = false) {
    await this.database.pool.query(
      `UPDATE order_payment_requests SET approval_claim_id=NULL,approval_claimed_until=NULL,
      approval_started_at=CASE WHEN $3 THEN NULL ELSE approval_started_at END,
      provider_payment_key=CASE WHEN $3 THEN NULL ELSE provider_payment_key END
      WHERE payment_request_id=$1 AND approval_claim_id=$2 AND completed_at IS NULL`,
      [id, claimId, declined],
    );
  }

  async recordApproval(id: string, key: string, approvedAt: string) {
    await this.database.pool.query(
      'UPDATE order_payment_requests SET provider_approved_at=$3 WHERE payment_request_id=$1 AND provider_payment_key=$2',
      [id, key, approvedAt],
    );
  }

  async claimNotification() {
    return this.database.transaction(async (client) => {
      await client.query(`UPDATE order_payment_requests SET notification_status='UNKNOWN'
        WHERE notification_status='SENDING' AND notification_attempted_at<clock_timestamp()-interval '45 seconds'`);
      const row = (
        await client.query<{
          id: string;
        }>(`SELECT r.payment_request_id AS id FROM order_payment_requests r
        JOIN orders o USING(order_seq) WHERE r.notification_status='PENDING' AND r.invalidated_at IS NULL
        AND r.completed_at IS NULL AND r.approval_started_at IS NULL AND r.expires_at>clock_timestamp() AND o.status='notPaid' AND o.deleted_at IS NULL
        ORDER BY r.created_at LIMIT 1 FOR UPDATE OF r SKIP LOCKED`)
      ).rows[0];
      if (!row) return;
      await client.query(
        `UPDATE order_payment_requests SET notification_status='SENDING',notification_attempted_at=clock_timestamp() WHERE payment_request_id=$1`,
        [row.id],
      );
      return row.id;
    });
  }

  async finishNotification(id: string, status: string) {
    await this.database.pool.query(
      `UPDATE order_payment_requests SET notification_status=$2,
      notification_sent_at=CASE WHEN $2='SENT' THEN clock_timestamp() ELSE NULL END
      WHERE payment_request_id=$1 AND notification_status='SENDING'`,
      [id, status],
    );
  }

  async claimCompletionNotification() {
    return this.database.transaction(async (client) => {
      await client.query(`UPDATE order_payment_requests SET completion_notification_status='UNKNOWN'
        WHERE completion_notification_status='SENDING'
        AND completion_notification_attempted_at<clock_timestamp()-interval '45 seconds'`);
      const row = (
        await client.query<{
          id: string;
        }>(`SELECT payment_request_id AS id FROM order_payment_requests
        WHERE completion_notification_status IN ('WAITING','PENDING') AND completed_at IS NOT NULL
        ORDER BY completed_at LIMIT 1 FOR UPDATE SKIP LOCKED`)
      ).rows[0];
      if (!row) return;
      await client.query(
        `UPDATE order_payment_requests SET completion_notification_status='SENDING',
        completion_notification_attempted_at=clock_timestamp() WHERE payment_request_id=$1`,
        [row.id],
      );
      return row.id;
    });
  }

  async finishCompletionNotification(id: string, status: string) {
    await this.database.pool.query(
      `UPDATE order_payment_requests SET completion_notification_status=$2,
      completion_notification_sent_at=CASE WHEN $2='SENT' THEN clock_timestamp() ELSE NULL END
      WHERE payment_request_id=$1 AND completion_notification_status='SENDING'`,
      [id, status],
    );
  }
}
