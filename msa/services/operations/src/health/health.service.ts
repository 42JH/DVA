import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DatabaseService } from '../database/database.service';
import { Environment } from '../config/environment';

@Injectable()
export class HealthService {
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
      fetch(`${aiUrl}/health`, { signal: AbortSignal.timeout(2000) })
        .then((response) => response.ok)
        .catch(() => false),
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
