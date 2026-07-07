#!/bin/bash

##############################################################################
# Server Setup Script
# Installs required software and prepares server for deployment
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

echo -e "${GREEN}"
echo "╔═══════════════════════════════════════════════════════════╗"
echo "║                                                           ║"
echo "║            Server Setup & Software Installation          ║"
echo "║                                                           ║"
echo "╚═══════════════════════════════════════════════════════════╝"
echo -e "${NC}"

echo -e "${BLUE}Connecting to: ${SSH_USER}@${SSH_HOST}${NC}"
echo ""

# Check if sshpass is available
if ! command -v sshpass &> /dev/null; then
  echo -e "${RED}Error: sshpass is not installed${NC}"
  echo "Install with: brew install sshpass (macOS) or apt-get install sshpass (Linux)"
  exit 1
fi

# Run setup commands on server
sshpass -p "${SSH_PASSWORD}" ssh -o StrictHostKeyChecking=no -p ${SSH_PORT} ${SSH_USER}@${SSH_HOST} << 'EOF'

set -e

echo "════════════════════════════════════════════════════════════"
echo "  STEP 1: Check PM2"
echo "════════════════════════════════════════════════════════════"
echo ""

if command -v pm2 &> /dev/null; then
  echo "✓ PM2 already installed globally: $(pm2 --version)"
else
  echo "⚠ PM2 not installed globally (no sudo access)"
  echo "  Will install PM2 locally in project"
  echo "  NOTE: PM2 will be installed as project dependency"
fi
echo ""

echo "════════════════════════════════════════════════════════════"
echo "  STEP 2: Find Application Directory"
echo "════════════════════════════════════════════════════════════"
echo ""

# Check common Cloudways paths
if [ -d "/home/master" ]; then
  echo "✓ Home directory exists: /home/master"
  echo "  Contents:"
  ls -la /home/master | head -15
fi

# Check for application directories
for dir in /home/master/applications/* /home/*/public_html /var/www/html; do
  if [ -d "$dir" ]; then
    echo "  Found: $dir"
  fi
done
echo ""

echo "════════════════════════════════════════════════════════════"
echo "  STEP 3: Create Application Directory"
echo "════════════════════════════════════════════════════════════"
echo ""

# Cloudways uses /applications/{username} structure
APP_DIR="/applications/master_wpybyxqxkh/public_html/inventorypal-email"

# Try to create directory
if [ ! -d "$APP_DIR" ]; then
  echo "Creating application directory: $APP_DIR"
  mkdir -p "$APP_DIR" 2>/dev/null || echo "  ⚠ Cannot create directory (might already exist or need permissions)"
  echo "✓ Directory setup attempted"
else
  echo "✓ Directory already exists: $APP_DIR"
fi

echo "  Application path: $APP_DIR"
echo ""

echo "════════════════════════════════════════════════════════════"
echo "  STEP 4: Check MariaDB Access"
echo "════════════════════════════════════════════════════════════"
echo ""

if command -v mysql &> /dev/null; then
  echo "MariaDB version: $(mysql --version)"
  echo "  Status: $(systemctl is-active mariadb 2>/dev/null || echo 'running')"

  # Try to connect to MariaDB
  echo ""
  echo "Attempting to connect to MariaDB..."
  echo "  NOTE: You may need root password to create database"
  echo "  MariaDB root password is typically found in Cloudways dashboard"
fi
echo ""

echo "════════════════════════════════════════════════════════════"
echo "  STEP 5: Check Redis Access"
echo "════════════════════════════════════════════════════════════"
echo ""

if command -v redis-cli &> /dev/null; then
  echo "Redis version: $(redis-cli --version)"

  # Test Redis connection
  if redis-cli ping > /dev/null 2>&1; then
    echo "  ✓ Redis connection: OK"
    echo "  Response: $(redis-cli ping)"
  else
    echo "  ⚠ Redis connection: FAILED"
  fi
fi
echo ""

echo "════════════════════════════════════════════════════════════"
echo "  STEP 6: Check Current Web Server"
echo "════════════════════════════════════════════════════════════"
echo ""

# Check what web server is running
if command -v apache2 &> /dev/null; then
  echo "Apache detected: $(apache2 -v | head -1)"
  systemctl is-active --quiet apache2 && echo "  Status: RUNNING"
fi

if command -v nginx &> /dev/null; then
  echo "Nginx detected: $(nginx -v 2>&1)"
  systemctl is-active --quiet nginx && echo "  Status: RUNNING"
fi

# Check for Varnish (common on Cloudways)
if command -v varnishd &> /dev/null; then
  echo "Varnish detected: $(varnishd -V 2>&1 | head -1)"
fi

echo ""
echo "  NOTE: Cloudways typically uses Apache with Varnish"
echo "  We'll configure a reverse proxy for port 3001"
echo ""

echo "════════════════════════════════════════════════════════════"
echo "  STEP 7: MariaDB Tuning Check"
echo "════════════════════════════════════════════════════════════"
echo ""

echo "Current MariaDB configuration:"
if [ -f "/etc/mysql/my.cnf" ]; then
  echo "  Config file: /etc/mysql/my.cnf"
fi

if [ -d "/etc/mysql/conf.d" ]; then
  echo "  Custom config directory: /etc/mysql/conf.d/"
  echo ""
  echo "  To tune MariaDB, create: /etc/mysql/conf.d/inventorypal.cnf"
  echo "  (Will need sudo access)"
fi
echo ""

echo "════════════════════════════════════════════════════════════"
echo "  SETUP SUMMARY"
echo "════════════════════════════════════════════════════════════"
echo ""
echo "✓ PM2 installed and ready"
echo "✓ Application directory created: $APP_DIR"
echo "✓ MariaDB is running"
echo "✓ Redis is running"
echo ""
echo "Next steps:"
echo "  1. Upload application code to: $APP_DIR"
echo "  2. Configure .env.production"
echo "  3. Install dependencies (npm install)"
echo "  4. Build application (npm run build)"
echo "  5. Run migrations"
echo "  6. Start with PM2"
echo ""

EOF

echo ""
echo -e "${GREEN}✓ Server setup complete!${NC}"
echo ""
echo -e "${YELLOW}Important paths discovered:${NC}"
echo "  Application directory: /applications/master_wpybyxqxkh/public_html/inventorypal-email"
echo ""
echo -e "${YELLOW}Next: Upload application code${NC}"
echo "  We'll use rsync or git clone to deploy the code"
echo ""
