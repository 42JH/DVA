import { Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { restoreLegacyDraftBindings } from '@dva/events/parcel-drafts.cjs';
import { DatabaseService } from '../database/database.service';
import type { Environment } from '../config/environment';
import { OrderRetentionWorker } from './order-retention.worker';

@Injectable()
export class ParcelDraftMigrationService implements OnApplicationBootstrap {
  constructor(
    private readonly database: DatabaseService,
    private readonly config: ConfigService<Environment, true>,
    private readonly retention: OrderRetentionWorker,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    try {
      await restoreLegacyDraftBindings(
        this.database,
        this.config.get('CONSULTATION_URL', { infer: true }),
        this.config.get('CUSTOMER_AUTH_TOKEN', { infer: true }),
      );
      this.retention.start();
    } catch {
      throw new Error(
        'Legacy parcel draft migration unavailable; startup stopped before accepting traffic',
      );
    }
  }
}
