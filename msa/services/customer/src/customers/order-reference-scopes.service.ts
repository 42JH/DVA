import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { ReadScopes } from '@dva/events/read-scope.cjs';
import { ApiException } from '../common/errors/api.exception';

@Injectable()
export class OrderReferenceScopes extends ReadScopes<PoolClient> {
  constructor() {
    super(
      () =>
        new ApiException(503, 'DEPENDENCY_UNAVAILABLE', '서비스를 일시적으로 사용할 수 없습니다.'),
    );
  }
}
