const Redis = require('ioredis');
require('dotenv').config({
  path: process.env.NODE_ENV === 'production' ? '.env.production' : '.env',
});

console.log('Testing BullMQ-style Redis connection...');

const username = process.env.REDIS_USERNAME || undefined;
const password = process.env.REDIS_PASSWORD || undefined;
const host = process.env.REDIS_HOST || 'localhost';
const port = parseInt(process.env.REDIS_PORT, 10) || 6379;
const db = parseInt(process.env.REDIS_DB, 10) || 0;

console.log('Config:');
console.log('  host:', host);
console.log('  port:', port);
console.log('  username:', username);
console.log('  password:', password ? '***SET***' : 'NOT SET');
console.log('  db:', db);
console.log('');

// Test 1: With username and password (how BullMQ does it)
console.log('TEST 1: Connecting with username + password (BullMQ style)...');
const redis1 = new Redis({
  host,
  port,
  username,
  password,
  db,
  lazyConnect: false,
  retryStrategy: (times) => {
    if (times > 2) return null;
    return 500;
  },
});

redis1.on('connect', () => {
  console.log('✓ TEST 1: Connected!');
});

redis1.on('ready', async () => {
  console.log('✓ TEST 1: Ready!');
  try {
    await redis1.ping();
    console.log('✓ TEST 1: PING successful');
    redis1.disconnect();

    // Test 2: Without username (only password)
    console.log('');
    console.log('TEST 2: Connecting with only password (no username)...');
    const redis2 = new Redis({
      host,
      port,
      password,
      db,
      lazyConnect: false,
    });

    redis2.on('ready', async () => {
      console.log('✓ TEST 2: Ready!');
      await redis2.ping();
      console.log('✓ TEST 2: PING successful');
      redis2.disconnect();
      process.exit(0);
    });

    redis2.on('error', (err) => {
      console.error('✗ TEST 2 Error:', err.message);
      redis2.disconnect();
      process.exit(1);
    });

  } catch (error) {
    console.error('✗ TEST 1 Error:', error.message);
    redis1.disconnect();
    process.exit(1);
  }
});

redis1.on('error', (err) => {
  console.error('✗ TEST 1 Error:', err.message);

  // If TEST 1 fails, try TEST 2 directly
  console.log('');
  console.log('TEST 2: Trying without username...');
  const redis2 = new Redis({
    host,
    port,
    password,
    db,
  });

  redis2.on('ready', async () => {
    console.log('✓ TEST 2: Connected without username!');
    await redis2.ping();
    console.log('✓ TEST 2: PING successful');
    console.log('');
    console.log('SOLUTION: Remove username from Redis config, use only password!');
    redis2.disconnect();
    process.exit(0);
  });

  redis2.on('error', (err2) => {
    console.error('✗ TEST 2 also failed:', err2.message);
    process.exit(1);
  });
});

setTimeout(() => {
  console.error('✗ Connection timeout');
  process.exit(1);
}, 10000);
