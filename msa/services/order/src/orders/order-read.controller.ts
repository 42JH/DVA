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
import {
  validateOrderRead,
  validateAdminOrderRead,
  validateOrderIntakeResultRead,
} from '@dva/events/order-read.cjs';
import { AdminParcelDraftsService } from './admin-parcel-drafts.service';
import { validateDraftRead, validateDraftDeletion } from '@dva/events/parcel-drafts.cjs';
import { ApiException } from '../common/errors/api.exception';
import { ParcelDraftReadsService } from './parcel-draft-reads.service';
import { OrdersService } from './orders.service';

@ApiExcludeController()
@SetMetadata('auth:internal-customer', true)
@Controller('internal')
export class OrderReadController {
  constructor(
    private readonly orders: OrdersService,
    private readonly drafts: ParcelDraftReadsService,
    private readonly adminDrafts: AdminParcelDraftsService,
  ) {}

  @Post('order-intake-result')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async intakeResult(@Body() event: unknown) {
    try {
      validateOrderIntakeResultRead(event);
    } catch {
      throw new HttpException({ error: 'INVALID_ORDER_INTAKE_RESULT_READ' }, 422);
    }
    try {
      const { orderSeq, callSessionSeq } = event.payload;
      const payload = (await this.orders.intakeResult(orderSeq, callSessionSeq)) ?? null;
      return { eventId: event.eventId, status: 'processed', payload };
    } catch {
      throw new HttpException(
        { error: { code: 'INTERNAL_ERROR', message: '서버 오류가 발생했습니다.', details: [] } },
        500,
      );
    }
  }

  @Post('parcel-draft-delete')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async draftDelete(@Body() event: unknown) {
    try {
      validateDraftDeletion(event, 'consultation');
    } catch {
      throw new HttpException({ error: 'INVALID_DRAFT_DELETION' }, 422);
    }
    try {
      const payload = await this.adminDrafts.execute(event);
      return { eventId: event.eventId, status: 'processed', payload };
    } catch (error) {
      if (error instanceof ApiException)
        throw new HttpException({ error: error.getResponse() }, error.getStatus());
      if (error instanceof HttpException) throw error;
      throw new HttpException(
        { error: { code: 'INTERNAL_ERROR', message: '서버 오류가 발생했습니다.', details: [] } },
        500,
      );
    }
  }
  @Post('parcel-draft-read')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async draftRead(@Body() event: unknown) {
    try {
      validateDraftRead(event, 'customer');
    } catch {
      throw new HttpException({ error: 'INVALID_DRAFT_READ' }, 422);
    }
    try {
      const payload = await this.drafts.execute(event);
      return { eventId: event.eventId, status: 'processed', payload };
    } catch (error) {
      if (error instanceof ApiException)
        throw new HttpException({ error: error.getResponse() }, error.getStatus());
      if (error instanceof HttpException) throw error;
      throw new HttpException(
        { error: { code: 'INTERNAL_ERROR', message: '서버 오류가 발생했습니다.', details: [] } },
        500,
      );
    }
  }
  @Post('admin-order-read')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async admin(@Body() event: unknown) {
    try {
      validateAdminOrderRead(event, 'customer');
    } catch {
      throw new HttpException({ error: 'INVALID_ADMIN_ORDER_READ' }, 422);
    }
    const payload = await this.orders.executeAdmin(event);
    return { eventId: event.eventId, status: 'processed', payload };
  }
  @Post('order-read')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async query(@Body() event: unknown) {
    try {
      validateOrderRead(event, 'customer');
    } catch {
      throw new HttpException({ error: 'INVALID_ORDER_READ' }, 422);
    }
    const payload = await this.orders.execute(event.payload.command, event.payload.customerSeq!);
    return { eventId: event.eventId, status: 'processed', payload };
  }
}
