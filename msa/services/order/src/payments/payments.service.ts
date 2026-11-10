import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Environment } from '../config/environment';
import { ApiException } from '../common/errors/api.exception';
import { PaymentsRepository } from './payments.repository';
@Injectable()
export class PaymentsService {
  constructor(
    private readonly config: ConfigService<Environment, true>,
    private readonly repository: PaymentsRepository,
  ) {}
  ensureEnabled() {
    if (!this.config.get('ORDER_PAYMENTS_ENABLED', { infer: true }))
      throw new ApiException(
        503,
        'DEPENDENCY_UNAVAILABLE',
        '주문 결제 연동이 설정되지 않았습니다.',
      );
  }
  async read(id: string) {
    this.ensureEnabled();
    return this.repository.read(id);
  }
}
