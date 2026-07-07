import { NestFactory } from '@nestjs/core';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { ValidationPipe, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppModule } from './app.module';
import { getInventoryPalProcessRole, shouldRunHttpApi } from './config/process-role';

async function bootstrap() {
  const logger = new Logger('Bootstrap');
  const processRole = getInventoryPalProcessRole();

  if (!shouldRunHttpApi()) {
    logger.error(
      `Refusing to start HTTP API because INVENTORYPAL_PROCESS_ROLE=${processRole}. Use dist/src/worker.js for worker processes.`,
    );
    process.exit(1);
  }

  // Use Fastify for better performance
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter(),
    {
      logger: ['error', 'warn', 'log', 'debug', 'verbose'],
    },
  );

  const configService = app.get(ConfigService);
  const port = configService.get<number>('PORT', 3000);
  const nodeEnv = configService.get<string>('NODE_ENV', 'development');

  // Global validation pipe
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: {
        enableImplicitConversion: true,
      },
    }),
  );

  // Enable CORS
  app.enableCors({
    origin: true,
    credentials: true,
  });

  // Global prefix
  app.setGlobalPrefix('api');

  await app.listen(port, '0.0.0.0');

  logger.log(`🚀 Application running on: http://localhost:${port}/api`);
  logger.log(`📊 Environment: ${nodeEnv}`);
  logger.log(`⚙️ Process role: ${processRole}`);
  logger.log(`📧 Email verification: Self-hosted (4 straturi, NO sending)`);
}

bootstrap();
