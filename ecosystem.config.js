/**
 * PM2 Production Configuration for InventoryPal Email Platform
 *
 * Server Requirements (Cloudways):
 * - Plan: General Purpose 4GB / 2 vCPU
 * - RAM: 4GB (2.5GB MariaDB + 1GB Redis + 0.5GB App)
 * - Storage: 80GB SSD
 * - Database: MariaDB 10.11+ (NOT MySQL)
 *
 * MariaDB Tuning Required (via Cloudways SSH or MySQL Manager):
 * Add to /etc/my.cnf or via Server Settings & Packages:
 *
 * [mysqld]
 * innodb_buffer_pool_size = 2G              # 50% of RAM - critical for 7M rows
 * innodb_log_file_size = 512M               # Large log for bulk inserts
 * innodb_flush_log_at_trx_commit = 2        # Faster for heavy INSERT workloads
 * max_connections = 200                     # BullMQ concurrency 50 + connections
 * innodb_flush_method = O_DIRECT            # Reduce double buffering
 * innodb_file_per_table = ON                # Better for large tables
 *
 * Why MariaDB (not MySQL):
 * - Better bulk INSERT performance (500 emails/batch × 14,071 batches)
 * - Optimized thread pool for concurrent reads/writes
 * - Superior query optimizer for 7M+ row tables with multiple indexes
 * - Cloudways default with better tuning out-of-the-box
 */

const fs = require('fs');
const path = require('path');

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return {};
  }

  return fs
    .readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .reduce((env, line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) {
        return env;
      }

      const separatorIndex = trimmed.indexOf('=');
      if (separatorIndex === -1) {
        return env;
      }

      const key = trimmed.slice(0, separatorIndex).trim();
      let value = trimmed.slice(separatorIndex + 1).trim();

      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }

      env[key] = value;
      return env;
    }, {});
}

const productionEnv = {
  ...loadEnvFile(path.resolve(__dirname, '.env.production')),
  ...process.env,
};

function env(name, fallback) {
  return productionEnv[name] ?? fallback;
}

const sharedProductionEnv = {
  NODE_ENV: 'production',
  APP_NAME: env('APP_NAME', 'InventoryPal Email Platform'),

  // Database
  DB_HOST: env('DB_HOST', 'localhost'),
  DB_PORT: env('DB_PORT', '3306'),
  DB_USERNAME: env('DB_USERNAME'),
  DB_PASSWORD: env('DB_PASSWORD'),
  DB_DATABASE: env('DB_DATABASE'),
  DB_LOGGING: env('DB_LOGGING', 'false'),
  DB_SYNCHRONIZE: env('DB_SYNCHRONIZE', 'false'),

  // Redis
  REDIS_HOST: env('REDIS_HOST', 'localhost'),
  REDIS_PORT: env('REDIS_PORT', '6379'),
  REDIS_USERNAME: env('REDIS_USERNAME'),
  REDIS_PASSWORD: env('REDIS_PASSWORD'),
  REDIS_DB: env('REDIS_DB', '0'),

  // Email Verification
  EMAIL_VERIFICATION_HELO_DOMAIN: env('EMAIL_VERIFICATION_HELO_DOMAIN'),
  EMAIL_VERIFICATION_MAIL_FROM: env('EMAIL_VERIFICATION_MAIL_FROM'),
  EMAIL_VERIFICATION_TIMEOUT: env('EMAIL_VERIFICATION_TIMEOUT', '10000'),

  // BullMQ
  BULLMQ_CONCURRENCY: env('BULLMQ_CONCURRENCY', '50'),
  BULLMQ_RATE_LIMIT_MAX: env('BULLMQ_RATE_LIMIT_MAX', '100'),
  BULLMQ_RATE_LIMIT_DURATION: env('BULLMQ_RATE_LIMIT_DURATION', '1000'),

  // JWT
  JWT_SECRET: env('JWT_SECRET'),
  JWT_EXPIRES_IN: env('JWT_EXPIRES_IN', '7d'),

  // Logging
  LOG_LEVEL: env('LOG_LEVEL', 'info'),

  // Gmail API
  GMAIL_CLIENT_ID: env('GMAIL_CLIENT_ID'),
  GMAIL_CLIENT_SECRET: env('GMAIL_CLIENT_SECRET'),
  GMAIL_REDIRECT_URI: env('GMAIL_REDIRECT_URI'),
  GMAIL_REFRESH_TOKEN: env('GMAIL_REFRESH_TOKEN'),

  // OpenAI API (for LLM email categorization)
  OPENAI_API_KEY: env('OPENAI_API_KEY'),

  // Elastic Email delivery feedback
  ELASTIC_EMAIL_API_KEY: env('ELASTIC_EMAIL_API_KEY'),
  ELASTIC_EMAIL_WEBHOOK_SECRET: env('ELASTIC_EMAIL_WEBHOOK_SECRET'),

  // ZeroBounce external validation
  ZEROBOUNCE_API_KEY: env('ZEROBOUNCE_API_KEY'),
  ZEROBOUNCE_API_BASE_URL: env('ZEROBOUNCE_API_BASE_URL', 'https://api-eu.zerobounce.net/v2'),

  // SuppliKit customer sync
  INVENTORYPAL_SYNC_API_URL: env('INVENTORYPAL_SYNC_API_URL'),
  INVENTORYPAL_SYNC_API_TOKEN: env('INVENTORYPAL_SYNC_API_TOKEN'),
  INVENTORYPAL_WEBHOOK_SECRET: env('INVENTORYPAL_WEBHOOK_SECRET'),
  INVENTORYPAL_WEBHOOK_IMPORT_DAYS_BACK: env('INVENTORYPAL_WEBHOOK_IMPORT_DAYS_BACK', '2'),
  INVENTORYPAL_WEBHOOK_IMPORT_LIMIT: env('INVENTORYPAL_WEBHOOK_IMPORT_LIMIT', '5000'),
  INVENTORYPAL_AUTO_IMPORT_ENABLED: env('INVENTORYPAL_AUTO_IMPORT_ENABLED', 'false'),
  INVENTORYPAL_AUTO_IMPORT_DAYS_BACK: env('INVENTORYPAL_AUTO_IMPORT_DAYS_BACK', '1'),
  INVENTORYPAL_AUTO_IMPORT_LIMIT: env('INVENTORYPAL_AUTO_IMPORT_LIMIT', '5000'),
};

const commonProcessConfig = {
  instances: 1,
  exec_mode: 'fork',

  // Auto-restart
  autorestart: true,
  watch: false, // Nu folosi watch în producție
  max_restarts: 10, // Max 10 restarts în...
  min_uptime: '10s', // ...dacă uptime < 10s

  // Logging with rotation to prevent disk bloat
  log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
  merge_logs: true,
  max_size: '100M', // Rotate when log reaches 100MB
  max_files: 5, // Keep only last 5 rotated files
  compress: true, // Compress rotated logs

  // Advanced
  kill_timeout: 30000, // Give BullMQ workers time to close gracefully
  listen_timeout: 10000, // Wait 10s pentru app să fie ready
};

module.exports = {
  apps: [
    {
      ...commonProcessConfig,
      name: 'inventorypal-email-api',
      script: 'dist/src/main.js',
      env_production: {
        ...sharedProductionEnv,
        PORT: env('PORT', '3001'),
        INVENTORYPAL_PROCESS_ROLE: 'api',
      },
      max_memory_restart: '700M',
      error_file: 'logs/pm2-api-error.log',
      out_file: 'logs/pm2-api-out.log',
    },
    {
      ...commonProcessConfig,
      name: 'inventorypal-email-worker',
      script: 'dist/src/worker.js',
      env_production: {
        ...sharedProductionEnv,
        PORT: env('WORKER_PORT', '3002'),
        INVENTORYPAL_PROCESS_ROLE: 'worker',
      },
      max_memory_restart: '1200M',
      error_file: 'logs/pm2-worker-error.log',
      out_file: 'logs/pm2-worker-out.log',
    },
  ],
};
