#!/bin/bash

##############################################################################
# Complete Production Deploy Script
# Uploads code, builds, and deploys to Cloudways server
##############################################################################

set -e

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
RED='\033[0;31m'
NC='\033[0m'

# Load server credentials
if [ ! -f ".env.server" ]; then
  echo -e "${RED}Error: .env.server not found${NC}"
  exit 1
fi

source .env.server

# Server paths
REMOTE_DIR="/home/1619442.cloudwaysapps.com/yqcmhdmpah/public_html/inventorypal-email"
SSH_OPTS="-o StrictHostKeyChecking=no -p ${SSH_PORT}"
RSYNC_SSH_OPTS="ssh -o StrictHostKeyChecking=no -p ${SSH_PORT}"

echo -e "${GREEN}"
echo "╔═══════════════════════════════════════════════════════════╗"
echo "║                                                           ║"
echo "║         Complete Production Deploy to Cloudways          ║"
echo "║                                                           ║"
echo "╚═══════════════════════════════════════════════════════════╝"
echo -e "${NC}"

# Step 1: Local preflight
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}Step 1: Local Preflight${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

npm test -- --runInBand
npm run build
echo ""
echo -e "${GREEN}✓ Tests and full build successful${NC}"
echo ""

# Step 2: Upload code
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}Step 2: Upload Code to Server${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

# Create remote directory
sshpass -p "${SSH_PASSWORD}" ssh ${SSH_OPTS} ${SSH_USER}@${SSH_HOST} "mkdir -p ${REMOTE_DIR}"

# Upload built code
echo -e "${YELLOW}Uploading code...${NC}"
sshpass -p "${SSH_PASSWORD}" rsync -avz \
  --exclude 'node_modules' \
  --exclude 'frontend/node_modules' \
  --exclude '.git' \
  --exclude '.env*' \
  --exclude 'logs/*.log' \
  --exclude 'database-backups' \
  -e "${RSYNC_SSH_OPTS}" \
  ./ ${SSH_USER}@${SSH_HOST}:${REMOTE_DIR}/

echo ""
echo -e "${GREEN}✓ Code uploaded${NC}"
echo ""

# Step 3: Install dependencies on server
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}Step 3: Install Dependencies on Server${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

sshpass -p "${SSH_PASSWORD}" ssh ${SSH_OPTS} ${SSH_USER}@${SSH_HOST} << 'EOF'
set -euo pipefail
cd /home/1619442.cloudwaysapps.com/yqcmhdmpah/public_html/inventorypal-email
echo "Installing backend dependencies..."
npm install --legacy-peer-deps --production
echo ""
echo "✓ Dependencies installed"
EOF

echo ""

# Step 4: Backup database and run migrations
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}Step 4: Backup Database and Run Migrations${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

sshpass -p "${SSH_PASSWORD}" ssh ${SSH_OPTS} ${SSH_USER}@${SSH_HOST} << 'EOF'
set -euo pipefail
cd /home/1619442.cloudwaysapps.com/yqcmhdmpah/public_html/inventorypal-email

if [ ! -f ".env.production" ]; then
  echo "ERROR: .env.production not found on server"
  exit 1
fi

DB_HOST="$(DOTENV_CONFIG_PATH=.env.production node -r dotenv/config -e "console.log(process.env.DB_HOST || '')")"
DB_PORT="$(DOTENV_CONFIG_PATH=.env.production node -r dotenv/config -e "console.log(process.env.DB_PORT || '3306')")"
DB_USERNAME="$(DOTENV_CONFIG_PATH=.env.production node -r dotenv/config -e "console.log(process.env.DB_USERNAME || '')")"
DB_PASSWORD="$(DOTENV_CONFIG_PATH=.env.production node -r dotenv/config -e "console.log(process.env.DB_PASSWORD || '')")"
DB_DATABASE="$(DOTENV_CONFIG_PATH=.env.production node -r dotenv/config -e "console.log(process.env.DB_DATABASE || '')")"

if [ -z "${DB_HOST}" ] || [ -z "${DB_USERNAME}" ] || [ -z "${DB_PASSWORD}" ] || [ -z "${DB_DATABASE}" ]; then
  echo "ERROR: missing DB_* values in .env.production"
  exit 1
fi

BACKUP_DIR="database-backups"
BACKUP_FILE="${BACKUP_DIR}/inventorypal_email_pre_migration_$(date +%Y%m%d_%H%M%S).sql.gz"

mkdir -p "${BACKUP_DIR}"
echo "Creating database backup: ${BACKUP_FILE}"
mysqldump \
  -h "${DB_HOST}" \
  -P "${DB_PORT:-3306}" \
  -u "${DB_USERNAME}" \
  -p"${DB_PASSWORD}" \
  "${DB_DATABASE}" | gzip > "${BACKUP_FILE}"
echo "✓ Database backup created"

echo "Running production migrations..."
npm run migration:run:prod
echo "✓ Migrations completed"
EOF

echo ""
echo -e "${GREEN}✓ Database backup and migrations complete${NC}"
echo ""

# Step 5: Restart PM2
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}Step 5: Restart Application with PM2${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

sshpass -p "${SSH_PASSWORD}" ssh ${SSH_OPTS} ${SSH_USER}@${SSH_HOST} << 'EOF'
set -euo pipefail
cd /home/1619442.cloudwaysapps.com/yqcmhdmpah/public_html/inventorypal-email

echo "Cleaning up legacy monolith PM2 process if present..."
npx pm2 stop inventorypal-email 2>/dev/null || true
npx pm2 delete inventorypal-email 2>/dev/null || true

if npx pm2 describe inventorypal-email-api >/dev/null 2>&1; then
  echo "Reloading API process from ecosystem config..."
  npx pm2 reload ecosystem.config.js --only inventorypal-email-api --env production --update-env
else
  echo "Starting API process..."
  npx pm2 start ecosystem.config.js --only inventorypal-email-api --env production
fi

if npx pm2 describe inventorypal-email-worker >/dev/null 2>&1; then
  echo "Worker process already exists; leaving it running."
  echo "Restart it explicitly only when worker/scan code must change:"
  echo "  npx pm2 restart inventorypal-email-worker --update-env"
else
  echo "Starting worker process..."
  npx pm2 start ecosystem.config.js --only inventorypal-email-worker --env production
fi

echo "Saving PM2 configuration..."
npx pm2 save

echo ""
echo "Waiting 5 seconds for application to start..."
sleep 5
echo ""

echo "PM2 Status:"
npx pm2 status

echo ""
echo "Application Logs (last 20 lines):"
npx pm2 logs inventorypal-email-api --lines 20 --nostream
EOF

echo ""
echo -e "${GREEN}✓ Application restarted${NC}"
echo ""

# Step 6: Verify deployment
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}Step 6: Verify Deployment${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

echo -e "${YELLOW}Testing login endpoint...${NC}"
RESPONSE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "http://mailpal.inventorypal.ro/api/auth/login" \
  -H "Content-Type: application/json" \
  -d '{"email":"test@test.com","password":"test"}')

if [ "$RESPONSE" = "401" ] || [ "$RESPONSE" = "400" ]; then
  echo -e "${GREEN}✓ Auth endpoint responding (HTTP $RESPONSE)${NC}"
else
  echo -e "${RED}⚠ Unexpected response: HTTP $RESPONSE${NC}"
fi

echo ""
echo -e "${GREEN}═══════════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}                 Deployment Complete!                      ${NC}"
echo -e "${GREEN}═══════════════════════════════════════════════════════════${NC}"
echo ""
echo -e "${YELLOW}Application URL:${NC} http://mailpal.inventorypal.ro"
echo ""
echo -e "${BLUE}To view logs:${NC}"
echo "  ssh ${SSH_USER}@${SSH_HOST}"
echo "  cd ${REMOTE_DIR}"
echo "  npx pm2 logs inventorypal-email-api"
echo "  npx pm2 logs inventorypal-email-worker"
echo ""
