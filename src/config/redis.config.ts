import { registerAs } from '@nestjs/config';

export const redisConfig = registerAs('redis', () => {
  const config = {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT, 10) || 6379,
    username: process.env.REDIS_USERNAME || undefined,
    password: process.env.REDIS_PASSWORD || undefined,
    db: parseInt(process.env.REDIS_DB, 10) || 0,
  };

  // Debug logging
  console.log('[REDIS CONFIG] Environment variables:');
  console.log('  REDIS_HOST:', process.env.REDIS_HOST);
  console.log('  REDIS_PORT:', process.env.REDIS_PORT);
  console.log('  REDIS_USERNAME:', process.env.REDIS_USERNAME);
  console.log('  REDIS_PASSWORD:', process.env.REDIS_PASSWORD ? '***SET***' : 'NOT SET');
  console.log('  REDIS_DB:', process.env.REDIS_DB);
  console.log('[REDIS CONFIG] Parsed configuration:');
  console.log('  host:', config.host);
  console.log('  port:', config.port);
  console.log('  username:', config.username);
  console.log('  password:', config.password ? '***SET***' : undefined);
  console.log('  db:', config.db);

  return config;
});
