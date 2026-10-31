import { Injectable } from '@nestjs/common';
import { PoolClient } from 'pg';
import { AuditService } from '../audit/audit.service';
import { ApiException } from '../common/errors/api.exception';
import { ListResponse } from '../common/pagination';
import { DatabaseService } from '../database/database.service';
import { AdminFaqQueryDto, AiFaqQueryDto, CreateFaqDto, UpdateFaqDto } from './dto/faq-request.dto';
import { FaqsRepository } from './faqs.repository';
import { queueFaqChange } from './faq-change';

@Injectable()
export class FaqsService {
  constructor(
    private readonly repository: FaqsRepository,
    private readonly database: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  async list(query: AiFaqQueryDto | AdminFaqQueryDto, agent = false) {
    return new ListResponse(await this.repository.list(query, agent), query.limit);
  }

  async find(id: number, agent = false) {
    const row = await this.repository.find(id, agent);
    if (!row) throw new ApiException(404, 'NOT_FOUND', 'FAQ를 찾을 수 없습니다.');
    return row;
  }

  async create(items: CreateFaqDto[], adminId: number, requestId: string) {
    return this.database.transaction((client) =>
      this.createInTransaction(client, items, adminId, requestId),
    );
  }

  async createInTransaction(
    client: PoolClient,
    items: CreateFaqDto[],
    adminId: number,
    requestId: string,
  ) {
    const ids: number[] = [];
    for (const item of items) {
      const id = await this.repository.insert(client, item, adminId);
      ids.push(id);
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
    }
    await queueFaqChange(client, 'INSERT', ids, requestId);
    return ids;
  }

  async delete(ids: number[], adminId: number, requestId: string) {
    await this.database.transaction(async (client) => {
      const deleted = await this.repository.delete(client, ids);
      if (deleted.length !== ids.length)
        throw new ApiException(404, 'NOT_FOUND', '삭제할 FAQ를 찾을 수 없습니다.');
      for (const id of ids)
        await this.audit.recordSuccess(
          {
            actorId: adminId,
            targetId: id,
            targetType: 'FAQ_ENTRY',
            action: 'FAQ_DELETED',
            requestId,
          },
          client,
        );
      await queueFaqChange(client, 'DELETE', ids, requestId);
    });
  }

  async update(id: number, input: UpdateFaqDto, adminId: number, requestId: string) {
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
      await queueFaqChange(client, 'UPDATE', [id], requestId);
    });
  }
}
