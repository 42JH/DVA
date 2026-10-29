import { Controller, Get, Res } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { Response } from 'express';
import { PublicAuth } from '../auth/auth.guard';
import { ObservabilityService } from './observability.service';

@ApiExcludeController()
@Controller('internal')
export class ObservabilityController {
  constructor(private readonly observability: ObservabilityService) {}
  // Docker 내부망 전용. 호스트와 컨테이너 Nginx에서 외부 경로를 거부한다.
  @PublicAuth()
  @Get('metrics')
  async metrics(@Res() response: Response): Promise<void> {
    response.setHeader('Cache-Control', 'no-store');
    response
      .type('text/plain; version=0.0.4; charset=utf-8')
      .send(await this.observability.snapshot());
  }
}
