import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { PoolClient } from 'pg';
import { OrganizationBillingService } from '../organizations/organization-billing.service';
import { AuditService } from '../audit/audit.service';
import { randomUUID } from 'node:crypto';

export interface PaymentRequest {
  paymentCardSeq: number | null;
  cardPaymentOrderId: string;
  cardPaymentFailed: boolean;
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
    const result = await client.query(
      `UPDATE order_payment_requests SET provider_payment_key=$2,
        approval_started_at=COALESCE(approval_started_at,clock_timestamp()),approval_claim_id=$3,
        approval_claimed_until=clock_timestamp()+interval '45 seconds' WHERE payment_request_id=$1
        AND EXISTS(SELECT 1 FROM orders o WHERE o.order_seq=order_payment_requests.order_seq
          AND o.deleted_at IS NULL AND COALESCE(o.closed_at,o.created_at)>clock_timestamp()-interval '5 years')`,
      [id, key, claimId],
    );
    return result.rowCount === 1;
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
    private readonly audit: AuditService,
  ) {}

  async paymentOrderId(id: string): Promise<number | null> {
    return (
      (
        await this.database.pool.query<{ id: number }>(
          'SELECT order_seq AS id FROM order_payment_requests WHERE payment_request_id=$1',
          [id],
        )
      ).rows[0]?.id ?? null
    );
  }

  private async notificationAudit(
    client: PoolClient,
    rows: Array<{ orderSeq: number }>,
    completion: boolean,
    status: string,
  ) {
    for (const row of rows)
      await this.audit.recordResult(
        {
          actorId: null,
          actorType: 'SYSTEM',
          targetType: 'ORDER',
          targetId: row.orderSeq,
          action: `ORDER_PAYMENT_${completion ? 'COMPLETION_' : ''}NOTIFICATION_${status === 'SENDING' ? 'ATTEMPTED' : status}`,
          requestId: randomUUID(),
        },
        ['SENT', 'SENDING'].includes(status) ? 'SUCCESS' : 'FAILED',
        client,
      );
  }
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
        memberMonthlyEnabled: boolean;
        groupBillingEnabled: boolean;
        organizationStatus: string;
        monthlyBillingEnabled: boolean;
      }>(
        `SELECT m.organization_seq AS "organizationSeq",m.department_seq AS "departmentSeq",m.status AS "membershipStatus",o.status AS "organizationStatus",
       o.monthly_billing_enabled AS "monthlyBillingEnabled",m.monthly_billing_enabled AS "memberMonthlyEnabled",m.group_billing_enabled AS "groupBillingEnabled"
       FROM memberships m JOIN organizations o USING(organization_seq)
       WHERE m.customer_seq=$1 AND m.deleted_at IS NULL AND o.deleted_at IS NULL FOR SHARE OF m,o`,
        [customerId],
      )
    ).rows[0];
    const active = member?.membershipStatus === 'ACTIVE' && member.organizationStatus === 'ACTIVE';
    const registeredGroup = active
      ? await this.card(client, null, member.organizationSeq)
      : undefined;
    return {
      monthly:
        !!customer &&
        (member
          ? active && member.monthlyBillingEnabled && member.memberMonthlyEnabled
          : customer.monthlyBillingEnabled),
      group: !!customer && !!active && member?.groupBillingEnabled === true && !!registeredGroup,
      organizationSeq: active ? member.organizationSeq : null,
      departmentSeq: active ? member.departmentSeq : null,
    };
  }
  async waitForPayment(client: PoolClient, id: number) {
    await client.query(
      "UPDATE orders SET status='notPaid',payment_due_at=clock_timestamp()+interval '24 hours' WHERE order_seq=$1",
      [id],
    );
    await this.replaceRequest(client, id);
  }

  async card(client: PoolClient, customerId: number | null, organizationId: number | null) {
    return (
      await client.query<import('../payments/payment-cards.repository').StoredPaymentCard>(
        `SELECT payment_card_seq AS "paymentCardSeq",encrypted_billing_key AS "encryptedBillingKey",
       provider_customer_key AS "providerCustomerKey",provider_environment AS "providerEnvironment"
       FROM payment_cards WHERE status='ACTIVE' AND deleted_at IS NULL
        AND ((customer_seq=$1 AND $2::int IS NULL) OR (organization_seq=$2 AND $1::int IS NULL))
        AND expiration_year*12+expiration_month>=extract(year FROM clock_timestamp() AT TIME ZONE 'Asia/Seoul')*12+extract(month FROM clock_timestamp() AT TIME ZONE 'Asia/Seoul')
       FOR SHARE`,
        [customerId, organizationId],
      )
    ).rows[0];
  }

  async reserveCardApproval(client: PoolClient, id: string, claimId: string) {
    await client.query(
      `UPDATE order_payment_requests SET approval_started_at=COALESCE(approval_started_at,clock_timestamp()),
      approval_claim_id=$2,approval_claimed_until=clock_timestamp()+interval '90 seconds',approval_next_check_at=clock_timestamp()+interval '1 minute',card_payment_failed=false
      WHERE payment_request_id=$1`,
      [id, claimId],
    );
  }

  async recordCardApproval(id: string, key: string, approvedAt: string) {
    await this.database.pool.query(
      `UPDATE order_payment_requests SET provider_payment_key=$2,provider_approved_at=$3
      WHERE payment_request_id=$1 AND payment_card_seq IS NOT NULL AND (provider_payment_key IS NULL OR provider_payment_key=$2)`,
      [id, key, approvedAt],
    );
  }

  async retryCard(client: PoolClient, id: string, card: number, orderId: string) {
    await client.query(
      `UPDATE order_payment_requests SET payment_card_seq=$2,card_payment_order_id=$3,
      card_payment_failed=false,provider_payment_key=NULL,provider_approved_at=NULL,approval_next_check_at=NULL
      WHERE payment_request_id=$1 AND approval_started_at IS NULL AND completed_at IS NULL`,
      [id, card, orderId],
    );
  }

  async pendingCardForOrder(id: number) {
    return (
      await this.database.pool.query<{ id: string }>(
        `SELECT payment_request_id AS id FROM order_payment_requests WHERE order_seq=$1 AND payment_card_seq IS NOT NULL
       AND NOT card_payment_failed AND completed_at IS NULL AND invalidated_at IS NULL
       AND (approval_started_at IS NOT NULL OR expires_at>clock_timestamp())`,
        [id],
      )
    ).rows[0];
  }

  async failCardApproval(id: string, claimId: string) {
    return !!(
      await this.database.pool.query(
        `UPDATE order_payment_requests SET card_payment_failed=true,
      approval_started_at=NULL,approval_claim_id=NULL,approval_claimed_until=NULL
      WHERE payment_request_id=$1 AND approval_claim_id=$2 AND completed_at IS NULL AND provider_approved_at IS NULL`,
        [id, claimId],
      )
    ).rowCount;
  }

  async defaultMonthly(client: PoolClient, id: number) {
    await client.query(
      "UPDATE orders SET payment_method_type='credit' WHERE order_seq=$1 AND payment_method_type IS NULL",
      [id],
    );
  }

  async prepareCompanyCard(
    client: PoolClient,
    id: number,
    company: number,
    department: number | null,
  ) {
    await client.query(
      `UPDATE orders SET billing_organization_seq=$2,billing_department_seq=$3,
      billing_organization_name=(SELECT name FROM organizations WHERE organization_seq=$2),
      billing_department_name=(SELECT name FROM departments WHERE department_seq=$3)
      WHERE order_seq=$1`,
      [id, company, department],
    );
  }
  async replaceRequest(client: PoolClient, id: number) {
    await client.query(
      'UPDATE order_payment_requests SET invalidated_at=clock_timestamp() WHERE order_seq=$1 AND invalidated_at IS NULL AND completed_at IS NULL',
      [id],
    );
    await client.query(
      `INSERT INTO order_payment_requests(order_seq,amount,expires_at,payment_card_seq,card_payment_failed)
      SELECT o.order_seq,o.total_amount,o.payment_due_at,c.payment_card_seq,o.payment_method_type='groupBilling' AND c.payment_card_seq IS NULL
      FROM orders o LEFT JOIN LATERAL (
       SELECT payment_card_seq FROM payment_cards c WHERE c.deleted_at IS NULL AND c.status='ACTIVE'
        AND ((o.payment_method_type='billing' AND c.customer_seq=o.customer_seq)
          OR (o.payment_method_type='groupBilling' AND c.organization_seq=o.billing_organization_seq))
        AND c.expiration_year*12+c.expiration_month>=extract(year FROM clock_timestamp() AT TIME ZONE 'Asia/Seoul')*12+extract(month FROM clock_timestamp() AT TIME ZONE 'Asia/Seoul')
       LIMIT 1
      ) c ON true WHERE o.order_seq=$1 AND o.status='notPaid' AND o.total_amount>0`,
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
      `WITH paid AS (SELECT COALESCE($4::timestamptz,clock_timestamp()) AS at),
       pickup AS (SELECT at,date_trunc('day',at AT TIME ZONE 'Asia/Seoul') AS local_day FROM paid)
       UPDATE orders SET status='PAID',paid_at=pickup.at,pickup_requested_at=CASE
         WHEN pickup_requested_at>=pickup.at THEN pickup_requested_at
         WHEN pickup.at+interval '1 hour'>(pickup.local_day+interval '17 hours') AT TIME ZONE 'Asia/Seoul'
           THEN (pickup.local_day+interval '1 day 9 hours') AT TIME ZONE 'Asia/Seoul'
         ELSE GREATEST(pickup.at+interval '1 hour',(pickup.local_day+interval '9 hours') AT TIME ZONE 'Asia/Seoul') END,
       billing_organization_seq=$2,billing_department_seq=$3,
       billing_organization_name=(SELECT name FROM organizations WHERE organization_seq=$2),
       billing_department_name=(SELECT name FROM departments WHERE department_seq=$3)
       FROM pickup WHERE order_seq=$1`,
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
      await client.query<{
        status: string;
        totalAmount: number;
        paidAt: Date | null;
        retentionExpired: boolean;
        customerSeq: number;
        paymentMethodType: string;
        billingOrganizationSeq: number | null;
        billingDepartmentSeq: number | null;
      }>(
        `SELECT status,total_amount AS "totalAmount",paid_at AS "paidAt",customer_seq AS "customerSeq",
         payment_method_type AS "paymentMethodType",billing_organization_seq AS "billingOrganizationSeq",billing_department_seq AS "billingDepartmentSeq",
         COALESCE(closed_at,created_at)<=clock_timestamp()-interval '5 years' AS "retentionExpired"
         FROM orders WHERE order_seq=$1 AND deleted_at IS NULL FOR UPDATE`,
        [parent.orderSeq],
      )
    ).rows[0];
    if (!order) return undefined;
    const request = (
      await client.query<PaymentRequest>(
        `SELECT payment_card_seq AS "paymentCardSeq",card_payment_order_id AS "cardPaymentOrderId",card_payment_failed AS "cardPaymentFailed",
         payment_request_id AS "paymentRequestId",order_seq AS "orderSeq",amount,expires_at AS "expiresAt",approval_started_at AS "approvalStartedAt",invalidated_at AS "invalidatedAt",completed_at AS "completedAt",provider_reference AS "providerReference",provider_payment_key AS "providerPaymentKey",provider_approved_at AS "providerApprovedAt",approval_claim_id AS "approvalClaimId",approval_claimed_until AS "approvalClaimedUntil",notification_status AS "notificationStatus" FROM order_payment_requests WHERE payment_request_id=$1 FOR UPDATE`,
        [id],
      )
    ).rows[0];
    return { ...request, order };
  }
  async complete(client: PoolClient, id: string, reference: string) {
    await client.query(
      "UPDATE order_payment_requests SET completed_at=clock_timestamp(),provider_reference=$2,approval_claim_id=NULL,approval_claimed_until=NULL,completion_notification_status='PENDING' WHERE payment_request_id=$1",
      [id, reference],
    );
  }

  async releaseClaim(id: string, claimId: string, declined = false) {
    const result = await this.database.pool.query(
      `UPDATE order_payment_requests SET approval_claim_id=NULL,approval_claimed_until=NULL,
      approval_started_at=CASE WHEN $3 THEN NULL ELSE approval_started_at END,
      provider_payment_key=CASE WHEN $3 THEN NULL ELSE provider_payment_key END,
      approval_next_check_at=CASE WHEN $3 THEN NULL ELSE approval_next_check_at END
      WHERE payment_request_id=$1 AND approval_claim_id=$2 AND completed_at IS NULL
      AND (NOT $3 OR (provider_approved_at IS NULL AND invalidated_at IS NULL
        AND approval_claimed_until>clock_timestamp()))`,
      [id, claimId, declined],
    );
    return result.rowCount === 1;
  }

  async recordApproval(id: string, key: string, approvedAt: string) {
    await this.database.pool.query(
      'UPDATE order_payment_requests SET provider_approved_at=$3 WHERE payment_request_id=$1 AND provider_payment_key=$2',
      [id, key, approvedAt],
    );
  }

  async claimNotification() {
    return this.database.transaction(async (client) => {
      const stale = await client.query<{
        orderSeq: number;
      }>(`UPDATE order_payment_requests SET notification_status='UNKNOWN'
        WHERE notification_status='SENDING' AND notification_attempted_at<clock_timestamp()-interval '45 seconds'
        RETURNING order_seq AS "orderSeq"`);
      await this.notificationAudit(client, stale.rows, false, 'UNKNOWN');
      const row = (
        await client.query<{
          id: string;
        }>(`SELECT r.payment_request_id AS id FROM order_payment_requests r
        JOIN orders o USING(order_seq) WHERE r.notification_status='PENDING' AND r.invalidated_at IS NULL AND r.payment_card_seq IS NULL AND o.payment_method_type='billing'
        AND r.completed_at IS NULL AND r.approval_started_at IS NULL AND r.expires_at>clock_timestamp() AND o.status='notPaid' AND o.deleted_at IS NULL
        ORDER BY r.created_at LIMIT 1 FOR UPDATE OF r SKIP LOCKED`)
      ).rows[0];
      if (!row) return;
      const sending = await client.query<{ orderSeq: number }>(
        `UPDATE order_payment_requests SET notification_status='SENDING',notification_attempted_at=clock_timestamp() WHERE payment_request_id=$1 RETURNING order_seq AS "orderSeq"`,
        [row.id],
      );
      await this.notificationAudit(client, sending.rows, false, 'SENDING');
      return row.id;
    });
  }

  async finishNotification(id: string, status: string) {
    await this.database.transaction(async (client) => {
      const result = await client.query<{ orderSeq: number }>(
        `UPDATE order_payment_requests SET notification_status=$2,
      notification_sent_at=CASE WHEN $2='SENT' THEN clock_timestamp() ELSE NULL END
      WHERE payment_request_id=$1 AND notification_status='SENDING' RETURNING order_seq AS "orderSeq"`,
        [id, status],
      );
      await this.notificationAudit(client, result.rows, false, status);
    });
  }

  async claimCompletionNotification() {
    return this.database.transaction(async (client) => {
      const stale = await client.query<{
        orderSeq: number;
      }>(`UPDATE order_payment_requests SET completion_notification_status='UNKNOWN'
        WHERE completion_notification_status='SENDING'
        AND completion_notification_attempted_at<clock_timestamp()-interval '45 seconds' RETURNING order_seq AS "orderSeq"`);
      await this.notificationAudit(client, stale.rows, true, 'UNKNOWN');
      const row = (
        await client.query<{
          id: string;
        }>(`SELECT payment_request_id AS id FROM order_payment_requests
        WHERE completion_notification_status IN ('WAITING','PENDING') AND completed_at IS NOT NULL
        ORDER BY completed_at LIMIT 1 FOR UPDATE SKIP LOCKED`)
      ).rows[0];
      if (!row) return;
      const sending = await client.query<{ orderSeq: number }>(
        `UPDATE order_payment_requests SET completion_notification_status='SENDING',
        completion_notification_attempted_at=clock_timestamp() WHERE payment_request_id=$1 RETURNING order_seq AS "orderSeq"`,
        [row.id],
      );
      await this.notificationAudit(client, sending.rows, true, 'SENDING');
      return row.id;
    });
  }

  async finishCompletionNotification(id: string, status: string) {
    await this.database.transaction(async (client) => {
      const result = await client.query<{ orderSeq: number }>(
        `UPDATE order_payment_requests SET completion_notification_status=$2,
      completion_notification_sent_at=CASE WHEN $2='SENT' THEN clock_timestamp() ELSE NULL END
      WHERE payment_request_id=$1 AND completion_notification_status='SENDING' RETURNING order_seq AS "orderSeq"`,
        [id, status],
      );
      await this.notificationAudit(client, result.rows, true, status);
    });
  }
}
