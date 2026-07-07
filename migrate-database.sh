#!/bin/bash

##############################################################################
# Database Migration Script
# Exports local database and imports to production server
#
# Tables to migrate:
# - emails: ~1.9M rows
# - email_sources: ~1.9M rows
# - customer_domains: ~127K rows
# - customers: ~84K rows
# - domains: 6 rows
# - import_jobs: 5 rows
#
# Total: ~3.9M rows
##############################################################################

set -e

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
RED='\033[0;31m'
NC='\033[0m'

# Database configuration
LOCAL_DB="inventorypal_email"
LOCAL_USER="root"
LOCAL_PASS=""  # Add password if needed

# Load server credentials
if [ ! -f ".env.server" ]; then
  echo -e "${RED}Error: .env.server not found${NC}"
  exit 1
fi

source .env.server

echo -e "${GREEN}"
echo "╔═══════════════════════════════════════════════════════════╗"
echo "║                                                           ║"
echo "║        Database Migration - Local to Production          ║"
echo "║                                                           ║"
echo "╚═══════════════════════════════════════════════════════════╝"
echo -e "${NC}"

echo -e "${YELLOW}⚠  WARNING: This will migrate ~1.9M emails and related data${NC}"
echo -e "${YELLOW}   Estimated time: 10-30 minutes depending on connection${NC}"
echo ""
read -p "Continue? (yes/no): " confirm
if [ "$confirm" != "yes" ]; then
  echo "Migration cancelled"
  exit 0
fi

# Create backup directory
BACKUP_DIR="./database-backups"
mkdir -p "$BACKUP_DIR"

TIMESTAMP=$(date +%Y%m%d_%H%M%S)
DUMP_FILE="${BACKUP_DIR}/${LOCAL_DB}_${TIMESTAMP}.sql"
COMPRESSED_FILE="${DUMP_FILE}.gz"

echo ""
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}Step 1: Export Local Database${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

echo -e "${YELLOW}Exporting database (this may take 5-15 minutes)...${NC}"
echo "  Database: $LOCAL_DB"
echo "  Output: $DUMP_FILE"
echo ""

# Export with optimizations for large tables
mysqldump \
  -u $LOCAL_USER \
  --quick \
  --single-transaction \
  --extended-insert \
  --no-autocommit \
  --disable-keys \
  --skip-lock-tables \
  --skip-add-locks \
  $LOCAL_DB > "$DUMP_FILE"

# Show dump file size
DUMP_SIZE=$(du -h "$DUMP_FILE" | cut -f1)
echo -e "${GREEN}✓ Export complete${NC}"
echo "  Size: $DUMP_SIZE"
echo ""

echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}Step 2: Compress Dump File${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

echo -e "${YELLOW}Compressing...${NC}"
gzip -c "$DUMP_FILE" > "$COMPRESSED_FILE"

COMPRESSED_SIZE=$(du -h "$COMPRESSED_FILE" | cut -f1)
COMPRESSION_RATIO=$(echo "scale=1; $(stat -f%z "$DUMP_FILE") / $(stat -f%z "$COMPRESSED_FILE")" | bc)

echo -e "${GREEN}✓ Compression complete${NC}"
echo "  Original: $DUMP_SIZE"
echo "  Compressed: $COMPRESSED_SIZE"
echo "  Ratio: ${COMPRESSION_RATIO}x"
echo ""

echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}Step 3: Upload to Server${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

REMOTE_PATH="${APP_DIR}/database-backups/"

echo -e "${YELLOW}Creating remote directory...${NC}"
sshpass -p "${SSH_PASSWORD}" ssh -o StrictHostKeyChecking=no -p ${SSH_PORT} ${SSH_USER}@${SSH_HOST} \
  "mkdir -p ${REMOTE_PATH}"

echo -e "${YELLOW}Uploading compressed database (this may take 5-10 minutes)...${NC}"
sshpass -p "${SSH_PASSWORD}" rsync -avz --progress \
  -e "ssh -o StrictHostKeyChecking=no -p ${SSH_PORT}" \
  "$COMPRESSED_FILE" \
  ${SSH_USER}@${SSH_HOST}:${REMOTE_PATH}

echo -e "${GREEN}✓ Upload complete${NC}"
echo ""

echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}Step 4: Import on Production Server${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

# Use credentials from .env.server
PROD_DB="${PROD_DB_NAME}"
PROD_USER="${PROD_DB_USER}"
PROD_PASS="${PROD_DB_PASS}"

echo -e "${YELLOW}Using production database credentials from .env.server:${NC}"
echo "  Database: $PROD_DB"
echo "  User: $PROD_USER"
echo "  Host: localhost"
echo ""

echo -e "${YELLOW}Importing database on production (this may take 10-20 minutes)...${NC}"

sshpass -p "${SSH_PASSWORD}" ssh -o StrictHostKeyChecking=no -p ${SSH_PORT} ${SSH_USER}@${SSH_HOST} << EOF
set -e

cd ${REMOTE_PATH}

echo "Decompressing SQL dump..."
gunzip -c ${LOCAL_DB}_${TIMESTAMP}.sql.gz > ${LOCAL_DB}_${TIMESTAMP}.sql

echo "Creating database if not exists..."
mysql -u ${PROD_USER} -p'${PROD_PASS}' -e "CREATE DATABASE IF NOT EXISTS ${PROD_DB} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"

echo "Importing data (this will take time)..."
mysql -u ${PROD_USER} -p'${PROD_PASS}' ${PROD_DB} < ${LOCAL_DB}_${TIMESTAMP}.sql

echo "Verifying import..."
mysql -u ${PROD_USER} -p'${PROD_PASS}' ${PROD_DB} -e "SELECT TABLE_NAME, TABLE_ROWS FROM information_schema.TABLES WHERE TABLE_SCHEMA = '${PROD_DB}' ORDER BY TABLE_ROWS DESC;"

echo ""
echo "Cleaning up decompressed file..."
rm -f ${LOCAL_DB}_${TIMESTAMP}.sql

echo ""
echo "Import complete!"
EOF

echo ""
echo -e "${GREEN}✓ Database migration complete!${NC}"
echo ""

echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}Summary${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo "  Local backup: $COMPRESSED_FILE"
echo "  Remote backup: ${REMOTE_PATH}${LOCAL_DB}_${TIMESTAMP}.sql.gz"
echo ""
echo -e "${GREEN}✓ Migration successful!${NC}"
echo ""
echo -e "${YELLOW}Next steps:${NC}"
echo "  1. Verify data on production"
echo "  2. Update .env.production with database credentials"
echo "  3. Run migrations if schema changed: npm run migration:run"
echo "  4. Deploy application: ./deploy.sh"
echo ""
