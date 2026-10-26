import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';

@ApiTags('Health')
@Controller('health')
export class AppController {
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