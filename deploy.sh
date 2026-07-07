#!/bin/bash

##############################################################################
# InventoryPal Email Platform - Production Deployment Script
##############################################################################
#
# This script handles complete deployment of both frontend and backend:
# - Pulls latest code from Git (optional)
# - Installs dependencies for both backend and frontend
# - Builds Angular frontend
# - Builds NestJS backend
# - Runs database migrations
# - Restarts PM2 process
#
# Usage:
#   ./deploy.sh                 # Deploy without git pull
#   ./deploy.sh --pull          # Pull latest code, then deploy
#   ./deploy.sh --skip-deps     # Skip npm install (faster for quick deploys)
#   ./deploy.sh --skip-migrations  # Skip database migrations
#
##############################################################################

set -e  # Exit on any error

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Default options
PULL_CODE=false
SKIP_DEPS=false
SKIP_MIGRATIONS=false

# Parse command line arguments
while [[ $# -gt 0 ]]; do
  case $1 in
    --pull)
      PULL_CODE=true
      shift
      ;;
    --skip-deps)
      SKIP_DEPS=true
      shift
      ;;
    --skip-migrations)
      SKIP_MIGRATIONS=true
      shift
      ;;
    *)
      echo -e "${RED}Unknown option: $1${NC}"
      echo "Usage: ./deploy.sh [--pull] [--skip-deps] [--skip-migrations]"
      exit 1
      ;;
  esac
done

# Function to print step header
print_step() {
  echo ""
  echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo -e "${GREEN}▶ $1${NC}"
  echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
}

# Function to print success
print_success() {
  echo -e "${GREEN}✓ $1${NC}"
}

# Function to print warning
print_warning() {
  echo -e "${YELLOW}⚠ $1${NC}"
}

# Function to print error
print_error() {
  echo -e "${RED}✗ $1${NC}"
}

# Start deployment
echo -e "${GREEN}"
echo "╔═══════════════════════════════════════════════════════════╗"
echo "║                                                           ║"
echo "║   InventoryPal Email Platform - Production Deploy        ║"
echo "║                                                           ║"
echo "╚═══════════════════════════════════════════════════════════╝"
echo -e "${NC}"

# Check if we're in the right directory
if [ ! -f "package.json" ] || [ ! -d "frontend" ]; then
  print_error "Error: Must be run from project root directory"
  exit 1
fi

# Check if .env.production exists
if [ ! -f ".env.production" ]; then
  print_error "Error: .env.production not found"
  exit 1
fi

# Step 1: Git pull (optional)
if [ "$PULL_CODE" = true ]; then
  print_step "Step 1: Pulling latest code from Git"

  # Stash any local changes
  if ! git diff-index --quiet HEAD --; then
    print_warning "Local changes detected, stashing..."
    git stash
  fi

  git pull origin main || git pull origin master
  print_success "Code updated successfully"
else
  print_warning "Skipping git pull (use --pull to enable)"
fi

# Step 2: Install dependencies
if [ "$SKIP_DEPS" = false ]; then
  print_step "Step 2: Installing Dependencies"

  # Backend dependencies
  echo -e "${YELLOW}Installing backend dependencies...${NC}"
  npm install --production=false
  print_success "Backend dependencies installed"

  # Frontend dependencies
  echo -e "${YELLOW}Installing frontend dependencies...${NC}"
  cd frontend
  npm install
  cd ..
  print_success "Frontend dependencies installed"
else
  print_warning "Skipping dependency installation (use without --skip-deps to enable)"
fi

# Step 3: Build Frontend (Angular)
print_step "Step 3: Building Frontend (Angular)"

cd frontend
echo -e "${YELLOW}Building Angular application for production...${NC}"
npm run build --configuration production
cd ..

# Verify frontend build output
if [ ! -d "frontend/dist/frontend/browser" ]; then
  print_error "Frontend build failed - output directory not found"
  exit 1
fi

print_success "Frontend built successfully"
echo -e "${YELLOW}Build location: frontend/dist/frontend/browser/${NC}"

# Step 4: Build Backend (NestJS)
print_step "Step 4: Building Backend (NestJS)"

echo -e "${YELLOW}Building NestJS application...${NC}"
npm run backend:build

# Verify backend build output
if [ ! -f "dist/src/main.js" ]; then
  print_error "Backend build failed - main.js not found"
  exit 1
fi

print_success "Backend built successfully"
echo -e "${YELLOW}Build location: dist/${NC}"

# Step 5: Run Database Migrations
if [ "$SKIP_MIGRATIONS" = false ]; then
  print_step "Step 5: Running Database Migrations"

  echo -e "${YELLOW}Running TypeORM migrations...${NC}"
  NODE_ENV=production npm run migration:run:prod

  print_success "Database migrations completed"
else
  print_warning "Skipping database migrations (use without --skip-migrations to enable)"
fi

# Step 6: PM2 Restart
print_step "Step 6: Restarting Application with PM2"

# Check if PM2 is installed
if ! command -v pm2 &> /dev/null; then
  print_error "PM2 is not installed. Install with: npm install -g pm2"
  exit 1
fi

# Clean up legacy monolith process if present
pm2 delete inventorypal-email &> /dev/null || true

# Check if API is already running
if pm2 describe inventorypal-email-api &> /dev/null; then
  echo -e "${YELLOW}Reloading API process only...${NC}"
  NODE_ENV=production pm2 reload inventorypal-email-api --update-env
  print_success "API reloaded"
else
  echo -e "${YELLOW}Starting API process...${NC}"
  NODE_ENV=production pm2 start ecosystem.config.js --only inventorypal-email-api
  print_success "API started with PM2"
fi

if pm2 describe inventorypal-email-worker &> /dev/null; then
  print_warning "Worker process is already running and was not restarted"
else
  echo -e "${YELLOW}Starting worker process...${NC}"
  NODE_ENV=production pm2 start ecosystem.config.js --only inventorypal-email-worker
  print_success "Worker started with PM2"
fi

# Save PM2 configuration
pm2 save

# Step 7: Verify Deployment
print_step "Step 7: Verifying Deployment"

sleep 3

# Check PM2 status
echo -e "${YELLOW}PM2 Status:${NC}"
pm2 status

# Check if app is responding (optional - requires curl)
if command -v curl &> /dev/null; then
  echo ""
  echo -e "${YELLOW}Testing application health...${NC}"

  if curl -f -s -o /dev/null -w "%{http_code}" http://localhost:3001/health | grep -q "200"; then
    print_success "Application is responding correctly"
  else
    print_warning "Application may not be responding - check logs with: pm2 logs inventorypal-email-api"
  fi
fi

# Final Summary
echo ""
echo -e "${GREEN}"
echo "╔═══════════════════════════════════════════════════════════╗"
echo "║                                                           ║"
echo "║               Deployment Completed Successfully!         ║"
echo "║                                                           ║"
echo "╚═══════════════════════════════════════════════════════════╝"
echo -e "${NC}"

echo -e "${BLUE}Next Steps:${NC}"
echo "  • View API logs: pm2 logs inventorypal-email-api"
echo "  • View worker logs: pm2 logs inventorypal-email-worker"
echo "  • Monitor: pm2 monit"
echo "  • Check status: pm2 status"
echo "  • Access frontend: https://mailpal.inventorypal.com"
echo "  • Access API: https://mailpal.inventorypal.com/api"
echo ""

# Show recent logs
echo -e "${YELLOW}Recent logs:${NC}"
pm2 logs inventorypal-email-api --lines 20 --nostream

exit 0
