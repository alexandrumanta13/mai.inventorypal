const Redis = require('ioredis');

console.log('Testing Redis connection with environment variables...');
console.log('Environment variables:');
console.log('  REDIS_HOST:', process.env.REDIS_HOST || '(not set)');
console.log('  REDIS_PORT:', process.env.REDIS_PORT || '(not set)');
console.log('  REDIS_USERNAME:', process.env.REDIS_USERNAME || '(not set)');
console.log('  REDIS_PASSWORD:', process.env.REDIS_PASSWORD ? '***' : '(not set)');
console.log('  REDIS_DB:', process.env.REDIS_DB || '(not set)');
console.log('  NODE_ENV:', process.env.NODE_ENV || '(not set)');
console.log('');

const config = {
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT, 10) || 6379,
  username: process.env.REDIS_USERNAME || undefined,
  password: process.env.REDIS_PASSWORD || undefined,
  db: parseInt(process.env.REDIS_DB, 10) || 0,
};

console.log('Parsed configuration:');
console.log('  host:', config.host);
console.log('  port:', config.port);
console.log('  username:', config.username);
console.log('  password:', config.password ? '***' : undefined);
console.log('  db:', config.db);
console.log('');

const redis = new Redis(config);

redis.on('connect', () => {
  console.log('✓ Successfully connected to Redis!');
});

redis.on('ready', async () => {
  console.log('✓ Redis client is ready!');
  try {
    const result = await redis.ping();
    console.log('✓ PING result:', result);
    redis.disconnect();
    process.exit(0);
  } catch (error) {
    console.error('✗ Error during Redis operations:', error.message);
    redis.disconnect();
    process.exit(1);
  }
});

redis.on('error', (error) => {
  console.error('✗ Redis connection error:', error.message);
  process.exit(1);
});

setTimeout(() => {
  console.error('✗ Connection timeout');
  redis.disconnect();
  process.exit(1);
}, 5000);
