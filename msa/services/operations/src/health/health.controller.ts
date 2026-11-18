import { Controller, Get } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { HealthService } from './health.service';
import { PublicAuth } from '../auth/auth.guard';

@ApiExcludeController()
@PublicAuth()
@Controller('health')
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  @Get()
  liveness(): { status: string; service: string } {
    return { status: 'ok', service: 'backend' };
  }

  @Get('ready')
  readiness() {
    return this.healthService.checkDependencies();
  }
}
