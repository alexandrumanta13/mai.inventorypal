import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BullModule } from '@nestjs/bullmq';
import { ScheduleModule } from '@nestjs/schedule';
import { APP_GUARD } from '@nestjs/core';
import { databaseConfig } from './config/database.config';
import { redisConfig } from './config/redis.config';
import { validateEnv } from './config/env.validation';
import { EmailsModule } from './modules/emails/emails.module';
import { ImportModule } from './modules/import/import.module';
import { EmailVerificationModule } from './modules/email-verification/email-verification.module';
import { DomainsModule } from './modules/domains/domains.module';
import { CustomersModule } from './modules/customers/customers.module';
import { GmailModule } from './modules/gmail/gmail.module';
import { AuthModule } from './modules/auth/auth.module';
import { JwtAuthGuard } from './modules/auth/guards/jwt-auth.guard';

@Module({
  imports: [
    // Static files are served by Nginx in production

    // Config module (load .env)
    ConfigModule.forRoot({
      isGlobal: true,
      load: [databaseConfig, redisConfig],
      envFilePath: ['.env.local', '.env'],
      validate: validateEnv,
    }),

    // TypeORM (MySQL)
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService) =>
        configService.get('database'),
    }),

    // BullMQ (Redis-backed queues)
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => {
        const username = configService.get('redis.username');
        const password = configService.get('redis.password');
        const host = configService.get('redis.host');
        const port = configService.get('redis.port');
        const db = configService.get('redis.db');

        console.log('[BULL CONFIG] Creating Redis connection with:');
        console.log('  username:', username);
        console.log('  password:', password ? '***SET***' : 'NOT SET');
        console.log('  host:', host);
        console.log('  port:', port);
        console.log('  db:', db);

        return {
          connection: {
            host,
            port,
            // Redis ACL authentication - MUST use both username and password
            // The default user is disabled, so username is required
            username,
            password,
            db,
            // Connection settings
            lazyConnect: false,
            // Retry strategy for failed connections
            retryStrategy: (times) => {
              if (times > 3) {
                console.error('[BULL] Redis connection failed after 3 attempts');
                return null;
              }
              return Math.min(times * 200, 2000);
            },
          },
          prefix: username ? `${username}:bull` : 'bull',
        };
      },
    }),

    // Cron scheduler for scheduled jobs
    ScheduleModule.forRoot(),

    // Feature modules
    AuthModule,
    EmailsModule,
    ImportModule,
    EmailVerificationModule,
    DomainsModule,
    CustomersModule,
    GmailModule,
    // AnalyticsModule,
  ],
  controllers: [],
  providers: [
    // Global JWT Auth Guard - all endpoints are protected by default
    // Use @Public() decorator to make specific endpoints public
    {
      provide: APP_GUARD,
      useClass: JwtAuthGuard,
    },
  ],
})
export class AppModule {}
