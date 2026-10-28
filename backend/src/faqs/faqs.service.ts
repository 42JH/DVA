import { Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { ApiException } from '../common/errors/api.exception';
import { ListResponse } from '../common/pagination';
import { DatabaseService } from '../database/database.service';
import { CreateFaqDto, FaqQueryDto, UpdateFaqDto } from './dto/faq-request.dto';
import { FaqsRepository } from './faqs.repository';

@Injectable()
export class FaqsService {
  constructor(
    private readonly repository: FaqsRepository,
    private readonly database: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  async list(query: FaqQueryDto, agent = false) {
    return new ListResponse(await this.repository.list(query, agent), query.limit);
  }

  async find(id: number, agent = false) {
    const row = await this.repository.find(id, agent);
    if (!row) throw new ApiException(404, 'NOT_FOUND', 'FAQ를 찾을 수 없습니다.');
    return row;
  }

  async create(input: CreateFaqDto, adminId: number, requestId: string) {
    return this.database.transaction(async (client) => {
      const id = await this.repository.insert(client, input, adminId);
      await this.audit.recordSuccess(
        {
          actorId: adminId,
          targetId: id,
          targetType: 'FAQ_ENTRY',
          action: 'FAQ_CREATED',
          requestId,
        },
        client,
      );
      return id;
    });
  }

  async update(id: number, input: UpdateFaqDto, adminId: number, requestId: string) {
    if (input.question === undefined && input.answer === undefined)
      throw new ApiException(400, 'INVALID_REQUEST', '변경할 질문 또는 답변을 입력해 주세요.');
    await this.database.transaction(async (client) => {
      if (!(await this.repository.update(client, id, input, adminId)))
        throw new ApiException(404, 'NOT_FOUND', 'FAQ를 찾을 수 없습니다.');
      await this.audit.recordSuccess(
        {
          actorId: adminId,
          targetId: id,
          targetType: 'FAQ_ENTRY',
          action: 'FAQ_UPDATED',
          requestId,
        },
        client,
      );
    });
  }
}
