import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { DatabaseModule } from '../database/database.module';
import { MembersController } from './members.controller';
import { MembersRepository } from './members.repository';
import { MembersService } from './members.service';
import { CustomersModule } from '../customers/customers.module';

@Module({
  imports: [DatabaseModule, AuditModule, CustomersModule],
  controllers: [MembersController],
  providers: [MembersRepository, MembersService],
  exports: [MembersService],
})
export class MembersModule {}
