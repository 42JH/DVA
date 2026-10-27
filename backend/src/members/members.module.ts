import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { DatabaseModule } from '../database/database.module';
import { MembersController } from './members.controller';
import { MembersRepository } from './members.repository';
import { MembersService } from './members.service';

@Module({
  imports: [DatabaseModule, AuditModule],
  controllers: [MembersController],
  providers: [MembersRepository, MembersService],
})
export class MembersModule {}
