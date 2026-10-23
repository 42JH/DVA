import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { DatabaseService } from './database.service';

@Injectable()
export class HealthService {
  constructor(private readonly database: DatabaseService) {}

  async checkDependencies(): Promise<{
    status: string;
    dependencies: { database: string; aiAgent: string };
  }> {
    const aiUrl = process.env.AI_AGENT_URL ?? 'http://ai-agent:8000';
    const [databaseOk, aiAgentOk] = await Promise.all([
      this.database.pool.query('SELECT 1').then(() => true).catch(() => false),
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
