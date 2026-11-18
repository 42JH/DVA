import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DatabaseService } from '../database/database.service';
import { Environment } from '../config/environment';

@Injectable()
export class HealthService {
  private pendingAi?: { url: string; promise: Promise<boolean> };

  private checkAi(url: string): Promise<boolean> {
    if (!this.pendingAi || this.pendingAi.url !== url) {
      const promise = fetch(url + '/health', { signal: AbortSignal.timeout(2000) })
        .then((response) => response.ok)
        .catch(() => false)
        .finally(() => {
          if (this.pendingAi?.promise === promise) this.pendingAi = undefined;
        });
      this.pendingAi = { url, promise };
    }
    return this.pendingAi.promise;
  }
  constructor(
    private readonly database: DatabaseService,
    private readonly config: ConfigService<Environment, true>,
  ) {}

  async checkDependencies(): Promise<{
    status: string;
    dependencies: { database: string; aiAgent: string };
  }> {
    const aiUrl = this.config.get('AI_AGENT_URL', { infer: true });
    const [databaseOk, aiAgentOk] = await Promise.all([
      this.database.pool
        .query('SELECT 1')
        .then(() => true)
        .catch(() => false),
      this.checkAi(aiUrl),
    ]);

    const body = {
      status: databaseOk && aiAgentOk ? 'ok' : 'unhealthy',
      dependencies: {
        database: databaseOk ? 'up' : 'down',
        aiAgent: aiAgentOk ? 'up' : 'down',
      },
    };

    if (!databaseOk || !aiAgentOk) {
      throw new ServiceUnavailableException(body);
    }
    return body;
  }
}
