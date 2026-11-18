import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { validateEnvironment } from './environment';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      ignoreEnvFile: ['production', 'test'].includes(
        process.env.NODE_ENV ?? '',
      ),
      envFilePath: [`.env.${process.env.NODE_ENV ?? 'development'}`, '.env'],
      validate: validateEnvironment,
    }),
  ],
  exports: [ConfigModule],
})
export class ApplicationConfigModule {}
