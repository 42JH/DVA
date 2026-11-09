import { Injectable } from '@nestjs/common';
import { PoolClient } from 'pg';

@Injectable()
export class DeliveriesRepository {
  async createForOrder(client: PoolClient, id: number): Promise<void> {
    await client.query(
      `WITH created AS (
         INSERT INTO shipments(order_parcel_seq,tracking_number,status)
         SELECT order_parcel_seq,'DVA-'||gen_random_uuid()::text,'paid' FROM order_parcels
         WHERE order_seq=$1 AND status='ACTIVE' RETURNING shipment_seq
       ) INSERT INTO shipment_status_history(shipment_seq,request_id,to_status,actor_type)
         SELECT shipment_seq,gen_random_uuid(),'paid','SYSTEM' FROM created`,
      [id],
    );
  }

  async lockShipments(client: PoolClient, parcelIds: number[]) {
    return (
      await client.query<{ orderParcelSeq: number; status: string }>(
        `SELECT order_parcel_seq AS "orderParcelSeq",status FROM shipments
         WHERE order_parcel_seq=ANY($1::int[]) ORDER BY shipment_seq FOR UPDATE`,
        [parcelIds],
      )
    ).rows;
  }

  async cancelShipments(client: PoolClient, parcelIds: number[], adminId: number | null) {
    await client.query(
      `WITH cancelled AS (
         UPDATE shipments SET status='canceled',version=version+1,status_changed_at=clock_timestamp()
         WHERE order_parcel_seq=ANY($1::int[]) AND status='notPaid' RETURNING shipment_seq
       ) INSERT INTO shipment_status_history(shipment_seq,request_id,from_status,to_status,actor_type,actor_admin_user_seq)
         SELECT shipment_seq,gen_random_uuid(),'notPaid','canceled',
           CASE WHEN $2::int IS NULL THEN 'AI' ELSE 'ADMIN' END,$2 FROM cancelled`,
      [parcelIds, adminId],
    );
  }
}
