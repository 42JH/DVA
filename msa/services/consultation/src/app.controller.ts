import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { PublicAuth } from './auth/auth.guard';
import { AuthService } from './auth/auth.service';
import { DatabaseService } from './database/database.service';
import { CustomerContextClient } from './customers/customer-context.client';

@ApiTags('Health')
@PublicAuth()
@Controller('consultation/health')
export class AppController {
  constructor(
    private readonly database: DatabaseService,
    private readonly auth: AuthService,
    private readonly customers: CustomerContextClient,
  ) {}

  @Get('ready')
  async readiness() {
    try {
      await Promise.all([
        this.database.pool.query('SELECT 1'),
        this.auth.readiness(),
        this.customers.callCustomer('0'),
      ]);
      return {
        status: 'ok',
        dependencies: { database: 'ok', authentication: 'ok', customer: 'ok' },
      };
    } catch {
      throw new ServiceUnavailableException({ status: 'unavailable' });
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
