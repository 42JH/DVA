import { Injectable } from '@nestjs/common';
import { OrderInputDto } from './dto/order-input.dto';
import { orderSnapshot } from './order-snapshot';
import { assertOrderSubmissionReady } from './order-submission.validation';

@Injectable()
export class OrdersService {
  validate(input: OrderInputDto): { valid: true } {
    assertOrderSubmissionReady(orderSnapshot(input));
    return { valid: true };
  }
}
