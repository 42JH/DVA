import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { AdminsRepository } from './admins.repository';
import { AdminsService } from './admins.service';
@Module({
  imports: [DatabaseModule],
  providers: [AdminsRepository, AdminsService],
  exports: [AdminsService],
})
export class AdminsModule {}
