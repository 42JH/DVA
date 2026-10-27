import { Injectable } from '@nestjs/common';
import { PoolClient } from 'pg';
import { ListPinsQueryDto } from './dto/pin-request.dto';
import { CompanyPinDto, PersonalPinDto } from './dto/pin-response.dto';

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
  async company(client: PoolClient, id: number, lock: boolean) {
    return (
      await client.query<{ status: string }>(
        `SELECT status FROM organizations WHERE organization_seq=$1${lock ? ' FOR SHARE' : ''}`,
        [id],
      )
    ).rows[0];
  }
  async callerCompany(client: PoolClient, phone: string) {
    return (
      await client.query<{ organizationSeq: number }>(
        `SELECT m.organization_seq AS "organizationSeq" FROM customers c
       JOIN memberships m ON m.customer_seq=c.customer_seq
       JOIN organizations o ON o.organization_seq=m.organization_seq
       WHERE c.phone_number=$1 AND c.status='ACTIVE' AND m.status='ACTIVE' AND o.status='ACTIVE'`,
        [phone],
      )
    ).rows[0];
  }
  async owner(client: PoolClient, id: number, company: boolean): Promise<number | undefined> {
    // 식별자는 코드 상수로만 선택한다. 소유자는 DB 트리거로 변경이 금지되어 있다.
    const table = company ? 'company_pins' : 'personal_pins';
    const key = company ? 'company_pin_seq' : 'personal_pin_seq';
    const owner = company ? 'organization_seq' : 'customer_seq';
    return (
      await client.query<{ owner: number }>(
        `SELECT ${owner} AS owner FROM ${table} WHERE ${key}=$1`,
        [id],
      )
    ).rows[0]?.owner;
  }
  async personal(client: PoolClient, customerId: number, query: ListPinsQueryDto) {
    return (
      await client.query<PersonalPinDto>(
        `SELECT personal_pin_seq AS "personalPinSeq",customer_seq AS "customerSeq",label,
        address_data AS "addressData",version FROM personal_pins
       WHERE customer_seq=$1 AND ($2::text IS NULL OR strpos(search_text,lower(normalize($2,NFC)))>0)
       ORDER BY personal_pin_seq LIMIT $3 OFFSET $4`,
        [customerId, query.q || null, query.limit + 1, query.offset],
      )
    ).rows;
  }
  async shared(client: PoolClient, companyId: number, query: ListPinsQueryDto) {
    return (
      await client.query<CompanyPinDto>(
        `SELECT company_pin_seq AS "companyPinSeq",organization_seq AS "organizationSeq",label,
        department_name AS "departmentName",address_data AS "addressData",version FROM company_pins
       WHERE organization_seq=$1 AND ($2::text IS NULL OR strpos(search_text,lower(normalize($2,NFC)))>0)
       ORDER BY company_pin_seq LIMIT $3 OFFSET $4`,
        [companyId, query.q || null, query.limit + 1, query.offset],
      )
    ).rows;
  }
}
