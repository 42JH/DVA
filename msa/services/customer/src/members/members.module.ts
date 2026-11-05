import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { MembersController } from './members.controller';
import { MembersService } from './members.service';
import { MembersRepository } from './members.repository';

@Module({
  imports: [DatabaseModule],
  controllers: [MembersController],
  providers: [MembersService, MembersRepository],
})
export class MembersModule {}
