import { readPage } from '../common/pagination-query';
import { Injectable } from '@nestjs/common';
import { PoolClient } from 'pg';
import { CreatePinDto, ListPinsQueryDto, UpdatePinDto } from './dto/pin-request.dto';
import { CreatedPersonalPinDto, PersonalPinDto, PinVersionDto } from './dto/pin-response.dto';

@Injectable()
export class PinsRepository {
  async call(client: PoolClient, id: number, lock: boolean) {
    return (
      await client.query<{ phone: string | null; endedAt: Date | null }>(
        `SELECT caller_phone_number AS phone,ended_at AS "endedAt" FROM call_sessions
       WHERE call_session_seq=$1${lock ? ' FOR SHARE' : ''}`,
        [id],
      )
    ).rows[0];
  }
  async customer(client: PoolClient, id: number, lock: boolean) {
    return (
      await client.query<{ phone: string; status: string }>(
        `SELECT phone_number AS phone,status FROM customers WHERE customer_seq=$1${lock ? ' FOR SHARE' : ''}`,
        [id],
      )
    ).rows[0];
  }
  async owner(client: PoolClient, id: number): Promise<number | undefined> {
    return (
      await client.query<{ owner: number }>(
        'SELECT customer_seq AS owner FROM personal_pins WHERE personal_pin_seq=$1',
        [id],
      )
    ).rows[0]?.owner;
  }
  async personal(client: PoolClient, customerId: number, query: ListPinsQueryDto) {
    return await readPage<PersonalPinDto>(
      client,
      `SELECT personal_pin_seq AS "personalPinSeq",customer_seq AS "customerSeq",label,
        address_data AS "addressData",version FROM personal_pins
       WHERE customer_seq=$1 AND ($2::text IS NULL OR strpos(search_text,lower(normalize($2,NFC)))>0)`,
      [customerId, query.q || null],
      query,
      '"personalPinSeq"',
    );
  }
  async createPersonal(client: PoolClient, customerId: number, input: CreatePinDto) {
    return (
      await client.query<CreatedPersonalPinDto>(
        `INSERT INTO personal_pins(customer_seq,label,address_data) VALUES($1,$2,$3)
       RETURNING personal_pin_seq AS "personalPinSeq",version`,
        [customerId, input.label ?? null, input.addressData],
      )
    ).rows[0];
  }
  async updatePersonal(client: PoolClient, id: number, input: UpdatePinDto) {
    // 생략한 필드는 UPDATE 시점의 값을 유지한다. 이전 조회값으로 전체 행을 덮어쓰지 않는다.
    return (
      await client.query<PinVersionDto>(
        `UPDATE personal_pins SET label=CASE WHEN $2 THEN $3 ELSE label END,
        address_data=CASE WHEN $4 THEN $5::jsonb ELSE address_data END
       WHERE personal_pin_seq=$1 RETURNING version`,
        [
          id,
          input.label !== undefined,
          input.label ?? null,
          input.addressData !== undefined,
          input.addressData ?? null,
        ],
      )
    ).rows[0];
  }
}
