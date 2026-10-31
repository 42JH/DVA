import { Injectable } from '@nestjs/common';
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
  constructor(private readonly billing: OrganizationBillingService) {}
  async eligibility(client: PoolClient, customerId: number) {
    const customer = (
      await client.query<{ monthlyBillingEnabled: boolean }>(
        `SELECT monthly_billing_enabled AS "monthlyBillingEnabled" FROM customers WHERE customer_seq=$1 AND status='ACTIVE' FOR SHARE`,
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
       WHERE m.customer_seq=$1 FOR SHARE OF m,o`,
        [customerId],
      )
    ).rows[0];
    const department =
      member?.departmentSeq != null
        ? (
            await client.query<{ groupBillingEnabled: boolean }>(
              'SELECT group_billing_enabled AS "groupBillingEnabled" FROM departments WHERE department_seq=$1 FOR SHARE',
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
        'SELECT status,total_amount AS "totalAmount",paid_at AS "paidAt" FROM orders WHERE order_seq=$1 FOR UPDATE',
        [parent.orderSeq],
      )
    ).rows[0];
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
}
