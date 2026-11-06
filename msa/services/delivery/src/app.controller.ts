import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { DatabaseService } from './database.service';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';

@ApiTags('Health')
@Controller('health')
export class AppController {
  constructor(private readonly database: DatabaseService) {}
  @Get('ready')
  async ready() {
    try {
      await this.database.pool.query('SELECT 1 FROM shipments LIMIT 0');
      return { status: 'ok' };
    } catch {
      throw new ServiceUnavailableException();
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
