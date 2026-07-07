#!/bin/bash

##############################################################################
# Server Status Check Script
# Checks what is installed on the Cloudways server
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
SSH_OPTS="-o StrictHostKeyChecking=no -o PreferredAuthentications=password -o PubkeyAuthentication=no -p ${SSH_PORT}"

echo -e "${GREEN}"
echo "╔═══════════════════════════════════════════════════════════╗"
echo "║                                                           ║"
echo "║         Checking Server Status & Configuration           ║"
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

# Create a single SSH command to run all checks
sshpass -p "${SSH_PASSWORD}" ssh ${SSH_OPTS} ${SSH_USER}@${SSH_HOST} << 'EOF'

echo "════════════════════════════════════════════════════════════"
echo "  SYSTEM INFORMATION"
echo "════════════════════════════════════════════════════════════"
echo ""

echo "OS Version:"
cat /etc/os-release | grep PRETTY_NAME
echo ""

echo "Hostname:"
hostname
echo ""

echo "CPU & RAM:"
echo "  CPUs: $(nproc)"
echo "  RAM: $(free -h | grep Mem | awk '{print $2}')"
echo "  Disk: $(df -h / | tail -1 | awk '{print $2 " total, " $4 " free"}')"
echo ""

echo "════════════════════════════════════════════════════════════"
echo "  INSTALLED SOFTWARE"
echo "════════════════════════════════════════════════════════════"
echo ""

echo "Node.js:"
if command -v node &> /dev/null; then
  echo "  ✓ Installed: $(node --version)"
else
  echo "  ✗ NOT INSTALLED"
fi
echo ""

echo "npm:"
if command -v npm &> /dev/null; then
  echo "  ✓ Installed: $(npm --version)"
else
  echo "  ✗ NOT INSTALLED"
fi
echo ""

echo "PM2:"
if command -v pm2 &> /dev/null; then
  echo "  ✓ Installed: $(pm2 --version)"
else
  echo "  ✗ NOT INSTALLED"
fi
echo ""

echo "MariaDB/MySQL:"
if command -v mysql &> /dev/null; then
  echo "  ✓ Installed: $(mysql --version)"
  systemctl is-active --quiet mariadb && echo "  ✓ MariaDB is RUNNING" || echo "  ⚠ MariaDB is NOT RUNNING"
else
  echo "  ✗ NOT INSTALLED"
fi
echo ""

echo "Redis:"
if command -v redis-cli &> /dev/null; then
  echo "  ✓ Installed: $(redis-cli --version)"
  systemctl is-active --quiet redis-server && echo "  ✓ Redis is RUNNING" || systemctl is-active --quiet redis && echo "  ✓ Redis is RUNNING" || echo "  ⚠ Redis is NOT RUNNING"
else
  echo "  ✗ NOT INSTALLED"
fi
echo ""

echo "Nginx:"
if command -v nginx &> /dev/null; then
  echo "  ✓ Installed: $(nginx -v 2>&1 | cut -d'/' -f2)"
  systemctl is-active --quiet nginx && echo "  ✓ Nginx is RUNNING" || echo "  ⚠ Nginx is NOT RUNNING"
else
  echo "  ✗ NOT INSTALLED"
fi
echo ""

echo "Git:"
if command -v git &> /dev/null; then
  echo "  ✓ Installed: $(git --version | cut -d' ' -f3)"
else
  echo "  ✗ NOT INSTALLED"
fi
echo ""

echo "════════════════════════════════════════════════════════════"
echo "  NETWORK & PORTS"
echo "════════════════════════════════════════════════════════════"
echo ""

echo "Open ports (important ones):"
if command -v ss &> /dev/null; then
  echo "  Port 80 (HTTP):"
  ss -tuln | grep ':80 ' && echo "    ✓ LISTENING" || echo "    ✗ NOT LISTENING"

  echo "  Port 443 (HTTPS):"
  ss -tuln | grep ':443 ' && echo "    ✓ LISTENING" || echo "    ✗ NOT LISTENING"

  echo "  Port 3306 (MariaDB):"
  ss -tuln | grep ':3306 ' && echo "    ✓ LISTENING" || echo "    ✗ NOT LISTENING"

  echo "  Port 6379 (Redis):"
  ss -tuln | grep ':6379 ' && echo "    ✓ LISTENING" || echo "    ✗ NOT LISTENING"
fi
echo ""

echo "════════════════════════════════════════════════════════════"
echo "  DIRECTORIES & PERMISSIONS"
echo "════════════════════════════════════════════════════════════"
echo ""

echo "Checking /var/www:"
if [ -d "/var/www" ]; then
  echo "  ✓ Exists"
  ls -la /var/www/ | head -10
else
  echo "  ✗ Does not exist"
fi
echo ""

echo "Home directory:"
echo "  Current: $(pwd)"
echo "  User: $(whoami)"
echo ""

echo "════════════════════════════════════════════════════════════"
echo "  MARIADB CONFIGURATION (if installed)"
echo "════════════════════════════════════════════════════════════"
echo ""

if command -v mysql &> /dev/null; then
  echo "MariaDB config file locations:"
  ls -l /etc/my.cnf 2>/dev/null || echo "  /etc/my.cnf - not found"
  ls -l /etc/mysql/my.cnf 2>/dev/null || echo "  /etc/mysql/my.cnf - not found"
  ls -d /etc/mysql/conf.d/ 2>/dev/null && echo "  /etc/mysql/conf.d/ - exists" || echo "  /etc/mysql/conf.d/ - not found"
fi
echo ""

echo "════════════════════════════════════════════════════════════"
echo "  SUMMARY"
echo "════════════════════════════════════════════════════════════"
echo ""
echo "Check complete! Review the output above."
echo ""

EOF

echo ""
echo -e "${GREEN}✓ Server check complete!${NC}"
echo ""
echo -e "${YELLOW}Next steps:${NC}"
echo "  1. Review the output above"
echo "  2. Install missing software if needed"
echo "  3. Configure MariaDB tuning (see ecosystem.config.js)"
echo ""
