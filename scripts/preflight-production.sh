#!/bin/bash

##############################################################################
# Production Preflight
# Read-only checks before running a production deployment.
##############################################################################

set -e

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
RED='\033[0;31m'
NC='\033[0m'

if [ ! -f ".env.server" ]; then
  echo -e "${RED}Error: .env.server not found${NC}"
  exit 1
fi

source .env.server

REMOTE_DIR="${APP_DIR:-/home/1619442.cloudwaysapps.com/yqcmhdmpah/public_html/inventorypal-email}"

if [ -z "${SSH_USER:-}" ] || [ -z "${SSH_HOST:-}" ]; then
  echo -e "${RED}Error: SSH_USER and SSH_HOST are required in .env.server${NC}"
  exit 1
fi

SSH_PORT="${SSH_PORT:-22}"

if [ -n "${SSH_PASSWORD:-}" ]; then
  if ! command -v sshpass >/dev/null 2>&1; then
    echo -e "${RED}Error: SSH_PASSWORD is set but sshpass is not installed${NC}"
    exit 1
  fi

  SSH_CMD=(
    sshpass -p "${SSH_PASSWORD}" ssh
    -o StrictHostKeyChecking=no
    -p "${SSH_PORT}"
    "${SSH_USER}@${SSH_HOST}"
  )
else
  SSH_CMD=(ssh -o BatchMode=yes -o StrictHostKeyChecking=no -p "${SSH_PORT}" "${SSH_USER}@${SSH_HOST}")
fi

echo -e "${GREEN}"
echo "╔═══════════════════════════════════════════════════════════╗"
echo "║            InventoryPal Production Preflight             ║"
echo "╚═══════════════════════════════════════════════════════════╝"
echo -e "${NC}"
echo -e "${BLUE}Target:${NC} ${SSH_USER}@${SSH_HOST}:${REMOTE_DIR}"
echo ""

"${SSH_CMD[@]}" 'bash -s' -- "${REMOTE_DIR}" <<'EOF'
set -e

APP_DIR="$1"
cd "${APP_DIR}"

echo "== location =="
pwd

echo "== env file =="
if [ -f .env.production ]; then
  echo ".env.production: present"
else
  echo ".env.production: MISSING"
  exit 20
fi

DOTENV_CONFIG_PATH=.env.production node -r dotenv/config - <<'NODE'
const required = [
  'NODE_ENV',
  'PORT',
  'DB_HOST',
  'DB_PORT',
  'DB_USERNAME',
  'DB_PASSWORD',
  'DB_DATABASE',
  'JWT_SECRET',
  'REDIS_HOST',
  'REDIS_PORT',
  'REDIS_PASSWORD',
];

const missing = required.filter((key) => !process.env[key]);

for (const key of required) {
  console.log(`${process.env[key] ? 'present' : 'missing'}: ${key}`);
}

if (missing.length > 0) {
  console.error(`required env check: FAILED (${missing.join(', ')})`);
  process.exit(21);
}
NODE

echo "== tools =="
command -v node >/dev/null && node --version
command -v npm >/dev/null && npm --version
command -v npx >/dev/null && echo "npx: present" || { echo "npx: MISSING"; exit 22; }
command -v mysqldump >/dev/null && echo "mysqldump: present" || { echo "mysqldump: MISSING"; exit 23; }

echo "== pm2 =="
npx pm2 status inventorypal-email || true
npx pm2 status inventorypal-email-api || true
npx pm2 status inventorypal-email-worker || true

echo "== db connectivity =="
DOTENV_CONFIG_PATH=.env.production node -r dotenv/config - <<'NODE'
const mysql = require('mysql2/promise');

(async () => {
  const connection = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USERNAME,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_DATABASE,
  });

  const [rows] = await connection.query('SELECT DATABASE() AS db, VERSION() AS version');
  console.log(`db: connected (${rows[0].db}, ${rows[0].version})`);
  await connection.end();
})().catch((error) => {
  console.error(`db: FAILED (${error.message})`);
  process.exit(1);
});
NODE

echo "== redis connectivity =="
DOTENV_CONFIG_PATH=.env.production node -r dotenv/config - <<'NODE'
const Redis = require('ioredis');

const redis = new Redis({
  host: process.env.REDIS_HOST,
  port: Number(process.env.REDIS_PORT || 6379),
  username: process.env.REDIS_USERNAME || undefined,
  password: process.env.REDIS_PASSWORD || undefined,
  db: Number(process.env.REDIS_DB || 0),
  lazyConnect: true,
  connectTimeout: 5000,
  maxRetriesPerRequest: 1,
});

(async () => {
  await redis.connect();
  const pong = await redis.ping();
  console.log(`redis: ${pong}`);
  redis.disconnect();
})().catch((error) => {
  console.error(`redis: FAILED (${error.message})`);
  redis.disconnect();
  process.exit(1);
});
NODE

echo "== dist and migrations =="
[ -f dist/src/main.js ] && echo "dist/src/main.js: present" || echo "dist/src/main.js: MISSING"
[ -f dist/src/worker.js ] && echo "dist/src/worker.js: present" || echo "dist/src/worker.js: MISSING"
[ -f dist/src/config/database.config.js ] && echo "dist database config: present" || echo "dist database config: MISSING"
if [ -d dist/src/database/migrations ]; then
  echo "compiled migrations: $(find dist/src/database/migrations -maxdepth 1 -type f -name '*.js' | wc -l | tr -d ' ')"
else
  echo "compiled migrations: MISSING"
fi

echo "== pending migrations =="
NODE_ENV=production npm run migration:show:prod || echo "migration show failed"

echo "== local auth endpoint =="
if command -v curl >/dev/null 2>&1; then
  PORT="$(DOTENV_CONFIG_PATH=.env.production node -r dotenv/config -e "console.log(process.env.PORT || 3001)")"
  code=$(curl -s -o /dev/null -w "%{http_code}" -X POST "http://127.0.0.1:${PORT}/api/auth/login" -H "Content-Type: application/json" -d '{"email":"test@test.com","password":"testtest"}' || true)
  echo "local login endpoint status: ${code}"
else
  echo "curl: not available"
fi
EOF

echo ""
echo -e "${GREEN}✓ Preflight complete${NC}"
