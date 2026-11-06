import { Injectable } from '@nestjs/common';
import { ApiException } from '../common/errors/api.exception';
import { ListResponse } from '../common/pagination';
import type { PaginationQueryDto } from '../common/dto/pagination-query.dto';
import { CallEventsRepository } from './call-events.repository';

@Injectable()
export class CallEventsService {
  constructor(private readonly repository: CallEventsRepository) {}

  async findActions(id: number, query: PaginationQueryDto) {
    if (!(await this.repository.callExists(id)))
      throw new ApiException(404, 'NOT_FOUND', '통화 기록을 찾을 수 없습니다.');
    return new ListResponse(
      await this.repository.findActions(id, query),
      query.limit,
    );
  }

  async findProcessingResults(id: number, query: PaginationQueryDto) {
    if (!(await this.repository.callExists(id)))
      throw new ApiException(404, 'NOT_FOUND', '통화 기록을 찾을 수 없습니다.');
    return new ListResponse(
      await this.repository.findProcessingResults(id, query),
      query.limit,
    );
  }
}
