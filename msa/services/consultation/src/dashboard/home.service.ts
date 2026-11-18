import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { requestHomeOrders } from '@dva/events/call-read-references.cjs';
import { ApiException } from '../common/errors/api.exception';
import type { Environment } from '../config/environment';
import { DatabaseService } from '../database/database.service';
import { OrderReferenceScopes } from '../customers/order-reference-scopes.service';
import { ConsultationsRepository } from '../consultations/consultations.repository';
import { CallQueryDto } from '../consultations/dto/call-query.dto';
import { UnansweredQuestionsRepository } from '../unanswered-questions/unanswered-questions.repository';
import { UnansweredQuestionQueryDto } from '../unanswered-questions/dto/unanswered-question-query.dto';
import { DashboardRepository } from './dashboard.repository';

@Injectable()
export class HomeService {
  constructor(
    private readonly database: DatabaseService,
    private readonly config: ConfigService<Environment, true>,
    private readonly scopes: OrderReferenceScopes,
    private readonly calls: ConsultationsRepository,
    private readonly questions: UnansweredQuestionsRepository,
    private readonly dashboard: DashboardRepository,
  ) {}

  home() {
    return this.database.transaction(async (client) => {
      await client.query(
        'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY',
      );
      const { observedAt } = (
        await client.query<{ observedAt: Date }>(
          'SELECT transaction_timestamp() AS "observedAt"',
        )
      ).rows[0];
      const scopeId = randomUUID();
      return this.scopes.run(scopeId, client, async () => {
        const orders = await this.orderSnapshot(observedAt, scopeId);
        const questions = await this.questions.findMany(
          Object.assign(new UnansweredQuestionQueryDto(), { limit: 11 }),
          client,
        );
        const calls = await this.calls.findMany(
          Object.assign(new CallQueryDto(), { limit: 11 }),
          client,
        );
        return {
          observedAt,
          todayOrderCount: orders.todayOrderCount,
          todayCallCount: await this.dashboard.todayCallCount(
            observedAt,
            client,
          ),
          pendingWork: {
            incomplete: orders.drafts.total_count,
            notPaid: orders.notPaid,
            submissionFailed: orders.submissionFailed,
            unansweredQuestions: questions.total_count,
          },
          recentCalls: calls.rows.slice(0, 11),
          incompleteDrafts: orders.drafts.data,
          unansweredQuestions: questions.rows.slice(0, 11),
          aiPerformance: await this.dashboard.performance('ALL', client),
        };
      });
    });
  }

  private async orderSnapshot(observedAt: Date, scopeId: string) {
    try {
      return await requestHomeOrders(
        this.config.get('ORDER_URL', { infer: true }) + '/internal/home-orders',
        this.config.get('CUSTOMER_AUTH_TOKEN', { infer: true }),
        observedAt.toISOString(),
        this.config.get('MSA_INSTANCE_IP', { infer: true }) ?? null,
        scopeId,
      );
    } catch {
      throw new ApiException(
        503,
        'DEPENDENCY_UNAVAILABLE',
        '서비스를 일시적으로 사용할 수 없습니다.',
      );
    }
  }
}
