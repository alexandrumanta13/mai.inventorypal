const Redis = require('ioredis');
require('dotenv').config({
  path: process.env.NODE_ENV === 'production' ? '.env.production' : '.env',
});

const config = {
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT || '6379', 10),
  username: process.env.REDIS_USERNAME || undefined,
  password: process.env.REDIS_PASSWORD || undefined,
  db: parseInt(process.env.REDIS_DB || '0', 10),
};

console.log('Testing Redis connection with ioredis...');
console.log('Credentials:');
console.log('  Host:', config.host);
console.log('  Port:', config.port);
console.log('  Username:', config.username);
console.log('  Password:', config.password ? '***' : 'none');
console.log('  DB:', config.db);

const redis = new Redis(config);

redis.on('connect', () => {
  console.log('✓ Successfully connected to Redis!');
});

redis.on('ready', async () => {
  console.log('✓ Redis client is ready!');
  try {
    const result = await redis.ping();
    console.log('✓ PING result:', result);

    // Test setting/getting a key with the prefix
    const testKey = `${config.username || 'local'}:test`;
    await redis.set(testKey, 'hello');
    const value = await redis.get(testKey);
    console.log('✓ SET/GET test:', value);

    await redis.del(testKey);
    console.log('✓ All tests passed!');
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
