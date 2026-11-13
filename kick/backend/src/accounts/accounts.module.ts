import { Module } from '@nestjs/common';

import { DatabaseModule } from '../database/database.module';
import { AccountsController } from './accounts.controller';
import { TestAccountGuard } from './test-account.guard';

@Module({
  imports: [DatabaseModule],
  controllers: [AccountsController],
  providers: [TestAccountGuard],
  exports: [TestAccountGuard],
})
export class AccountsModule {}
