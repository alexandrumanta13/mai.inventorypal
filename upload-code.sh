#!/bin/bash

##############################################################################
# Upload Code to Server
# Uses rsync to upload application code to Cloudways server
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
echo "║           Upload Code to Cloudways Server                ║"
echo "║                                                           ║"
echo "╚═══════════════════════════════════════════════════════════╝"
echo -e "${NC}"

echo -e "${BLUE}Destination: ${SSH_USER}@${SSH_HOST}:${REMOTE_DIR}${NC}"
echo ""

# Check if sshpass is available
if ! command -v sshpass &> /dev/null; then
  echo -e "${RED}Error: sshpass is not installed${NC}"
  echo "Install with: brew install sshpass"
  exit 1
fi

# Create remote directory if needed
echo -e "${YELLOW}Creating remote directory...${NC}"
sshpass -p "${SSH_PASSWORD}" ssh ${SSH_OPTS} ${SSH_USER}@${SSH_HOST} "mkdir -p ${REMOTE_DIR}"
echo ""

# Upload code using rsync
echo -e "${YELLOW}Uploading application code...${NC}"
echo "  This may take a few minutes..."
echo ""

# Use rsync to upload code (excluding node_modules and build artifacts)
sshpass -p "${SSH_PASSWORD}" rsync -avz --progress \
  --exclude 'node_modules' \
  --exclude 'frontend/node_modules' \
  --exclude 'dist' \
  --exclude 'frontend/dist' \
  --exclude '.git' \
  --exclude '.env*' \
  --exclude 'logs' \
  --exclude '*.log' \
  -e "${RSYNC_SSH_OPTS}" \
  ./ ${SSH_USER}@${SSH_HOST}:${REMOTE_DIR}/

echo ""
echo -e "${GREEN}✓ Code uploaded successfully!${NC}"
echo ""

# Verify upload
echo -e "${YELLOW}Verifying upload...${NC}"
sshpass -p "${SSH_PASSWORD}" ssh ${SSH_OPTS} ${SSH_USER}@${SSH_HOST} << EOF
echo "Contents of ${REMOTE_DIR}:"
ls -la ${REMOTE_DIR}/ | head -20
echo ""
echo "Checking key files:"
[ -f "${REMOTE_DIR}/package.json" ] && echo "  ✓ package.json" || echo "  ✗ package.json MISSING"
[ -f "${REMOTE_DIR}/ecosystem.config.js" ] && echo "  ✓ ecosystem.config.js" || echo "  ✗ ecosystem.config.js MISSING"
[ -f "${REMOTE_DIR}/deploy.sh" ] && echo "  ✓ deploy.sh" || echo "  ✗ deploy.sh MISSING"
[ -f "${REMOTE_DIR}/.env.production" ] && echo "  ✓ .env.production" || echo "  ✗ .env.production MISSING"
[ -d "${REMOTE_DIR}/src" ] && echo "  ✓ src/" || echo "  ✗ src/ MISSING"
[ -d "${REMOTE_DIR}/frontend" ] && echo "  ✓ frontend/" || echo "  ✗ frontend/ MISSING"
EOF

echo ""
echo -e "${GREEN}Upload complete!${NC}"
echo ""
echo -e "${YELLOW}Next steps:${NC}"
echo "  1. Configure .env.production on server"
echo "  2. Install dependencies: ssh to server and run 'npm install'"
echo "  3. Build application: npm run build"
echo "  4. Deploy with PM2: ./deploy.sh"
echo ""
echo -e "${BLUE}To SSH into server:${NC}"
echo "  ssh ${SSH_USER}@${SSH_HOST}"
echo "  cd ${REMOTE_DIR}"
echo ""
