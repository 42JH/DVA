import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { MembersController } from './members.controller';
import { MembersService } from './members.service';
import { MembersRepository } from './members.repository';
import { CustomersModule } from '../customers/customers.module';

@Module({
  imports: [DatabaseModule, CustomersModule],
  controllers: [MembersController],
  providers: [MembersService, MembersRepository],
  exports: [MembersService],
})
export class MembersModule {}
