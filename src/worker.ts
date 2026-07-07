import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppModule } from './app.module';
import { getInventoryPalProcessRole } from './config/process-role';

async function bootstrapWorker() {
  process.env.INVENTORYPAL_PROCESS_ROLE = process.env.INVENTORYPAL_PROCESS_ROLE || 'worker';

  const logger = new Logger('WorkerBootstrap');
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log', 'debug', 'verbose'],
  });

  app.enableShutdownHooks();

  const configService = app.get(ConfigService);
  const nodeEnv = configService.get<string>('NODE_ENV', 'development');
  const role = getInventoryPalProcessRole();

  logger.log(`Worker process started`);
  logger.log(`Environment: ${nodeEnv}`);
  logger.log(`Process role: ${role}`);
  logger.log('Queues active: gmail-scan, email-verification');
}

bootstrapWorker().catch((error) => {
  // eslint-disable-next-line no-console
  console.error('Worker failed to start:', error);
  process.exit(1);
});
