import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { ApplicationConfigModule } from './config/application-config.module';
import { DatabaseModule } from './database/database.module';
import { AuthModule } from './auth/auth.module';

@Module({
  imports: [ApplicationConfigModule, DatabaseModule, AuthModule],
  controllers: [AppController],
})
export class AppModule {}
