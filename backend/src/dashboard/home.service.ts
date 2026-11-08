import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { OrdersRepository } from '../orders/orders.repository';
import { AdminOrderListQueryDto } from '../orders/dto/admin-order-list.dto';
import { ParcelDraftsRepository } from '../orders/parcel-drafts.repository';
import { ParcelDraftQueryDto } from '../orders/dto/parcel-draft.dto';
import { ConsultationsRepository } from '../consultations/consultations.repository';
import { CallQueryDto } from '../consultations/dto/call-query.dto';
import { UnansweredQuestionsRepository } from '../unanswered-questions/unanswered-questions.repository';
import { UnansweredQuestionQueryDto } from '../unanswered-questions/dto/unanswered-question-query.dto';
import { DashboardRepository } from './dashboard.repository';
import { HomeDto } from './dto/home-response.dto';

@Injectable()
export class HomeService {
  constructor(
    private readonly database: DatabaseService,
    private readonly orders: OrdersRepository,
    private readonly drafts: ParcelDraftsRepository,
    private readonly calls: ConsultationsRepository,
    private readonly questions: UnansweredQuestionsRepository,
    private readonly dashboard: DashboardRepository,
  ) {}

  home(): Promise<HomeDto> {
    return this.database.transaction(async (client) => {
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const { observedAt } = (
        await client.query<{ observedAt: Date }>('SELECT transaction_timestamp() AS "observedAt"')
      ).rows[0];
      const counts = await this.orders.adminStatusCounts(client, new AdminOrderListQueryDto());
      const drafts = await this.drafts.list(
        client,
        Object.assign(new ParcelDraftQueryDto(), { limit: 5 }),
        null,
        null,
        null,
      );
      const questions = await this.questions.findMany(
        Object.assign(new UnansweredQuestionQueryDto(), { limit: 5 }),
        client,
      );
      const calls = await this.calls.findMany(
        Object.assign(new CallQueryDto(), { limit: 5 }),
        client,
      );
      return {
        observedAt,
        pendingWork: {
          incomplete: drafts.total_count,
          notPaid: counts.notPaid,
          submissionFailed: counts.submissionFailed,
          unansweredQuestions: questions.total_count,
        },
        recentCalls: calls.rows.slice(0, 5),
        incompleteDrafts: drafts.rows.slice(0, 5),
        unansweredQuestions: questions.rows.slice(0, 5),
        aiPerformance: {
          stageDropoffs: await this.dashboard.stageDropoffs('ALL', client),
          registrationTime: await this.dashboard.registrationTime('ALL', client),
          complaintCalls: await this.dashboard.complaintCalls('ALL', client),
          responseWait: await this.dashboard.responseWait('ALL', client),
        },
      };
    });
  }
}
