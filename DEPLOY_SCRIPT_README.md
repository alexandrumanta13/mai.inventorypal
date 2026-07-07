# Deploy Script Guide

## Overview

The `deploy.sh` script is an automated deployment tool that handles the complete deployment process for both the Angular frontend and NestJS backend.

## Features

- ✅ **Zero Downtime Deployment** - Uses PM2 reload for seamless updates
- ✅ **Automated Build Process** - Builds both frontend and backend
- ✅ **Database Migrations** - Automatically runs TypeORM migrations
- ✅ **Dependency Management** - Installs npm packages for both projects
- ✅ **Git Integration** - Optional git pull before deployment
- ✅ **Deployment Verification** - Checks if application is responding
- ✅ **Colorized Output** - Clear visual feedback during deployment

## Usage

### Basic Deployment

```bash
./deploy.sh
```

This will:
1. Install backend dependencies
2. Install frontend dependencies
3. Build Angular frontend
4. Build NestJS backend
5. Run database migrations
6. Restart PM2 (zero downtime)
7. Verify deployment

### Pull Latest Code and Deploy

```bash
./deploy.sh --pull
```

This will pull the latest code from Git before deploying.

### Skip Dependency Installation (Faster)

```bash
./deploy.sh --skip-deps
```

Use this when you know dependencies haven't changed. Saves ~2-3 minutes.

### Skip Database Migrations

```bash
./deploy.sh --skip-migrations
```

Use this when you haven't made database schema changes.

### Combine Options

```bash
./deploy.sh --pull --skip-deps
```

Pull latest code but skip npm install (fastest for quick code updates).

## Command Options

| Option | Description |
|--------|-------------|
| `--pull` | Pull latest code from Git before deployment |
| `--skip-deps` | Skip npm install for both frontend and backend |
| `--skip-migrations` | Skip TypeORM database migrations |

## Deployment Steps Explained

### Step 1: Git Pull (Optional)
- Stashes any local changes
- Pulls latest code from `main` or `master` branch
- Only runs with `--pull` flag

### Step 2: Install Dependencies
- Runs `npm install` in root (backend)
- Runs `npm install` in `frontend/` directory
- Skipped with `--skip-deps` flag

### Step 3: Build Frontend
- Builds Angular application for production
- Output: `frontend/dist/frontend/browser/`
- Optimized bundle with minification, tree-shaking, etc.

### Step 4: Build Backend
- Builds NestJS application
- Output: `dist/main.js`
- TypeScript compiled to JavaScript

### Step 5: Run Migrations
- Runs TypeORM migrations with `NODE_ENV=production`
- Creates/updates database schema
- Skipped with `--skip-migrations` flag

### Step 6: PM2 Restart
- **If app is running:** Uses `pm2 reload` (zero downtime)
- **If app is not running:** Uses `pm2 start`
- Automatically saves PM2 configuration

### Step 7: Verification
- Shows PM2 status
- Tests application health endpoint
- Displays recent logs

## Prerequisites

1. **PM2 Installed:**
   ```bash
   npm install -g pm2
   ```

2. **Script Permissions:**
   ```bash
   chmod +x deploy.sh
   ```

3. **Environment File:**
   - `.env.production` must exist in project root

4. **Git Repository (for --pull):**
   - Project must be a Git repository
   - Remote must be configured

## What Happens on First Deployment?

On the first deployment, the script will:

1. Install all dependencies (backend + frontend)
2. Build both applications
3. Run all database migrations
4. Start a new PM2 process
5. Save PM2 configuration
6. Show instructions for `pm2 startup` (auto-start on reboot)

You should then run:
```bash
pm2 startup
# Follow the command it outputs
```

## What Happens on Subsequent Deployments?

On subsequent deployments, the script will:

1. (Optional) Pull latest code
2. (Optional) Install dependencies
3. Build frontend and backend
4. Run new migrations (if any)
5. **Reload PM2 process** (zero downtime - old process stays up until new one is ready)
6. Verify deployment

## Typical Deployment Scenarios

### Scenario 1: Code-Only Changes (Fastest)
```bash
./deploy.sh --pull --skip-deps --skip-migrations
```

**Time:** ~3-5 minutes
**Use when:** You only changed TypeScript/JavaScript code, no dependency or schema changes

### Scenario 2: Code + Dependency Changes
```bash
./deploy.sh --pull --skip-migrations
```

**Time:** ~5-7 minutes
**Use when:** You added/updated npm packages but no database changes

### Scenario 3: Full Deployment (Safest)
```bash
./deploy.sh --pull
```

**Time:** ~7-10 minutes
**Use when:** You made database schema changes or want to be safe

### Scenario 4: Manual Git Pull (No Auto Pull)
```bash
git pull origin main
./deploy.sh
```

**Time:** ~5-7 minutes
**Use when:** You want to review changes before deployment

## Troubleshooting

### "PM2 is not installed"
```bash
npm install -g pm2
```

### "Must be run from project root directory"
Make sure you're in `/var/www/inventorypal-email` (or wherever the project is).

### ".env.production not found"
Create the file following the guide in `DEPLOYMENT.md` Step 7.

### "Frontend build failed"
Check frontend build errors:
```bash
cd frontend
npm run build
```

### "Backend build failed"
Check backend build errors:
```bash
npm run backend:build
```

### "Application may not be responding"
Check logs:
```bash
pm2 logs inventorypal-email
```

Restart manually if needed:
```bash
pm2 restart inventorypal-email
```

## Post-Deployment

After deployment, you can:

### View Logs
```bash
pm2 logs inventorypal-email

# Last 100 lines
pm2 logs inventorypal-email --lines 100

# Follow logs (real-time)
pm2 logs inventorypal-email --lines 0
```

### Check Status
```bash
pm2 status
```

### Monitor Resources
```bash
pm2 monit
```

### Test Application
```bash
# Health check
curl http://localhost:3001/health

# Frontend (should return HTML)
curl http://localhost:3001/

# API endpoint
curl http://localhost:3001/api/emails
```

## Production Best Practices

1. **Always test locally first**
   ```bash
   npm run build
   npm run start:prod
   ```

2. **Review git changes before --pull**
   ```bash
   git fetch origin
   git log HEAD..origin/main
   ```

3. **Backup database before major migrations**
   ```bash
   mysqldump -u user -p inventorypal_email > backup_$(date +%Y%m%d).sql
   ```

4. **Monitor logs during deployment**
   ```bash
   # In another SSH session
   pm2 logs inventorypal-email --lines 0
   ```

5. **Keep PM2 saved**
   - The script automatically runs `pm2 save`
   - Ensures process list persists across reboots

## Script Exit Codes

- `0` - Deployment successful
- `1` - Error occurred (check output for details)

## Timeline Expectations

| Task | Duration |
|------|----------|
| Git pull | ~10-30s |
| Backend npm install | ~1-2 min |
| Frontend npm install | ~1-2 min |
| Frontend build | ~1-2 min |
| Backend build | ~30-60s |
| Migrations | ~5-30s |
| PM2 reload | ~5-10s |
| **Total (full)** | **~7-10 min** |
| **Total (skip deps)** | **~3-5 min** |

## Example Output

```
╔═══════════════════════════════════════════════════════════╗
║                                                           ║
║   InventoryPal Email Platform - Production Deploy        ║
║                                                           ║
╚═══════════════════════════════════════════════════════════╝

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
▶ Step 1: Pulling latest code from Git
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
✓ Code updated successfully

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
▶ Step 2: Installing Dependencies
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
...
```

## Support

For issues:
1. Check `pm2 logs inventorypal-email`
2. Review `DEPLOYMENT.md` for full deployment guide
3. Check application logs in `logs/pm2-out.log` and `logs/pm2-error.log`
