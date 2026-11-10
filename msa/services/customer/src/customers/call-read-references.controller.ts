import {
  Body,
  Controller,
  Header,
  HttpCode,
  HttpException,
  Post,
  SetMetadata,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { validateReferenceQuery, type ReferenceRows } from '@dva/events/call-read-references.cjs';
import { DatabaseService } from '../database/database.service';

@ApiExcludeController()
@SetMetadata('auth:internal-consultation', true)
@Controller('internal/call-read-references')
export class CallReadReferencesController {
  constructor(private readonly database: DatabaseService) {}
  @Post()
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  query(@Body() input: unknown) {
    return this.read(input, 'consultation');
  }

  @Post('for-orders')
  @SetMetadata('auth:internal-operations', true)
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  forOrders(@Body() input: unknown) {
    return this.read(input, 'order');
  }

  private async read(input: unknown, source: 'consultation' | 'order') {
    try {
      validateReferenceQuery(input, source);
    } catch {
      throw new HttpException({ error: 'INVALID_CALL_REFERENCE_QUERY' }, 422);
    }
    const result = await this.database.pool.query<ReferenceRows['customer']>(
      `SELECT c.customer_seq,c.name,o.organization_seq,o.name AS organization_name FROM customers c
       LEFT JOIN memberships m ON m.customer_seq=c.customer_seq AND m.deleted_at IS NULL
       LEFT JOIN organizations o ON o.organization_seq=m.organization_seq AND o.deleted_at IS NULL
       WHERE c.customer_seq=ANY($1::int[]) AND c.deleted_at IS NULL ORDER BY c.customer_seq`,
      [input.payload.ids],
    );
    return { eventId: input.eventId, status: 'processed', payload: result.rows };
  }
}
