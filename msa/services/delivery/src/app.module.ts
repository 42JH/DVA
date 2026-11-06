import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller';
import { DatabaseService } from './database.service';
import { validateEnvironment } from './environment';
import { OrderShipmentCheckController } from './order-shipment-check.controller';
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate: validateEnvironment,
      ignoreEnvFile: true,
    }),
  ],
  controllers: [AppController, OrderShipmentCheckController],
  providers: [DatabaseService],
})
export class AppModule {}
