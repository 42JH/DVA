import { Injectable, OnModuleDestroy, ServiceUnavailableException } from '@nestjs/common';
import { Pool } from 'pg';

@Injectable()
export class HealthService implements OnModuleDestroy {
  private readonly db = new Pool({
    host: process.env.DB_HOST ?? 'db',
    port: Number(process.env.DB_PORT ?? 5432),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    connectionTimeoutMillis: 2000,
    max: 5,
  });

  async checkDependencies(): Promise<{
    status: string;
    dependencies: { database: string; aiAgent: string };
  }> {
    const aiUrl = process.env.AI_AGENT_URL ?? 'http://ai-agent:8000';
    const [databaseOk, aiAgentOk] = await Promise.all([
      this.db.query('SELECT 1').then(() => true).catch(() => false),
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

  async onModuleDestroy(): Promise<void> {
    await this.db.end();
  }
}
