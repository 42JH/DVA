import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';

import { DatabaseService } from '../database/database.service';

@Controller('health')
export class HealthController {
  constructor(private readonly databaseService: DatabaseService) {}

  @Get()
  async check(): Promise<{ status: 'ok' }> {
    try {
      await this.databaseService.checkConnection();
    } catch {
      throw new ServiceUnavailableException('PostgreSQL unavailable');
    }

    return { status: 'ok' };
  }
}
