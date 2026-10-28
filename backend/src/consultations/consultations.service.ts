import { Injectable } from '@nestjs/common';
import { ApiException } from '../common/errors/api.exception';
import { ListResponse } from '../common/pagination';
import { ConsultationsRepository } from './consultations.repository';
import { CallQueryDto } from './dto/call-query.dto';

@Injectable()
export class ConsultationsService {
  constructor(private readonly repository: ConsultationsRepository) {}

  async findMany(query: CallQueryDto) {
    const from = query.from === undefined ? undefined : Date.parse(query.from);
    const to = query.to === undefined ? undefined : Date.parse(query.to);
    if (
      (from !== undefined && !Number.isFinite(from)) ||
      (to !== undefined && !Number.isFinite(to)) ||
      (from !== undefined && to !== undefined && from >= to)
    )
      throw new ApiException(400, 'INVALID_REQUEST', '시작 시각은 종료 시각보다 빨라야 합니다.');
    return new ListResponse(await this.repository.findMany(query), query.limit);
  }
}
