import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { ApplicationConfigModule } from './config/application-config.module';
import { DatabaseModule } from './database/database.module';
import { AuthModule } from './auth/auth.module';
import { OrdersModule } from './orders/orders.module';

@Module({
  imports: [ApplicationConfigModule, DatabaseModule, AuthModule, OrdersModule],
  controllers: [AppController],
})
export class AppModule {}
