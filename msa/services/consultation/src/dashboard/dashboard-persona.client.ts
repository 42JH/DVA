import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { requestPersonaComparison } from '@dva/events/call-read-references.cjs';
import type { Environment } from '../config/environment';
import { ApiException } from '../common/errors/api.exception';

@Injectable()
export class DashboardPersonaClient {
  constructor(private readonly config: ConfigService<Environment, true>) {}

  async read() {
    try {
      const url = this.config.get('OPERATIONS_URL', { infer: true });
      if (!url) throw new Error('Persona owner unavailable');
      return await requestPersonaComparison(
        url + '/internal/call-read-references/persona-comparison',
        this.config.get('CONSULTATION_AUTH_TOKEN', { infer: true }),
      );
    } catch {
      throw new ApiException(
        503,
        'DEPENDENCY_UNAVAILABLE',
        '통계 비교 페르소나를 확인할 수 없습니다.',
      );
    }
  }
}
