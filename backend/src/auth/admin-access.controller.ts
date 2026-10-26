import { Controller } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiCookieAuth, ApiHeader, ApiResponse, ApiTags } from '@nestjs/swagger';
import { AdminsService } from '../admins/admins.service';
import { ErrorResponseDto } from '../common/dto/api-response.dto';
import { Environment } from '../config/environment';
import { AuthService } from './auth.service';
import { Roles } from './auth.guard';
@ApiTags('Admins')
@ApiCookieAuth('adminSession')
@ApiHeader({
  name: 'X-CSRF-Protection',
  description: '변경 요청에 1 전달. 허용 Origin 필수.',
  required: false,
})
@ApiResponse({ status: 400, type: ErrorResponseDto })
@ApiResponse({ status: 401, type: ErrorResponseDto })
@ApiResponse({ status: 403, type: ErrorResponseDto })
@ApiResponse({ status: 404, type: ErrorResponseDto })
@ApiResponse({ status: 409, type: ErrorResponseDto })
@Roles('SYSTEM_ADMIN')
@Controller('admins')
export class AdminAccessController {
  constructor(
    private readonly admins: AdminsService,
    private readonly auth: AuthService,
    private readonly config: ConfigService<Environment, true>,
  ) {}
}
