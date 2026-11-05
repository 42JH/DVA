import { Body, Controller, Header, HttpCode, Post } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { IsString, Matches } from 'class-validator';
import { AuthService } from './auth.service';
import { InternalSessionAuth } from './auth.guard';

class CurrentSessionDto {
  @IsString()
  @Matches(/^[0-9a-f]{64}$/)
  sessionToken!: string;
}

@ApiExcludeController()
@InternalSessionAuth()
@Controller('internal/auth')
export class InternalAuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('session')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  authenticate(@Body() input: CurrentSessionDto) {
    return this.auth.authenticate(input.sessionToken);
  }
}
