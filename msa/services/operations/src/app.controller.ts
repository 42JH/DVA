import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { PublicAuth } from './auth/auth.guard';
import { DatabaseService } from './database/database.service';

@ApiTags('Health')
@PublicAuth()
@Controller('operations/health')
export class AppController {
  constructor(private readonly database: DatabaseService) {}

  @Get('ready')
  async readiness() {
    try {
      await this.database.pool.query('SELECT 1');
      return { status: 'ok', dependencies: { database: 'ok' } };
    } catch {
      throw new ServiceUnavailableException({
        status: 'unavailable',
        dependencies: { database: 'unavailable' },
      });
    }
  }

  @Get()
  @ApiOperation({ summary: '서버 실행 상태 확인' })
  @ApiOkResponse({
    schema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['ok'] },
      },
      required: ['status'],
    },
  })
  getHealth() {
    return { status: 'ok' };
  }
}
