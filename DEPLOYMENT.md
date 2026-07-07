# InventoryPal Email Platform - Production Deployment Guide

## Application Architecture

### Tech Stack

**Backend:**
- Framework: NestJS 10.3.0 (Node.js with TypeScript)
- Database: MariaDB 10.11+ with TypeORM
- Queue: BullMQ with Redis
- Process Manager: PM2
- API: RESTful API on `/api/*` routes

**Frontend:**
- Framework: Angular 20.2.0
- Styling: TailwindCSS + SCSS
- Build: Production optimized bundle
- Served by: NestJS backend (via `@nestjs/serve-static`)

### How Frontend + Backend Work Together

```
┌─────────────────────────────────────────────────────────────┐
│                    Nginx (Port 80/443)                      │
│           https://mailpal.inventorypal.com                  │
└────────────────────────┬────────────────────────────────────┘
                         │
                         │ Reverse Proxy
                         ↓
┌─────────────────────────────────────────────────────────────┐
│           NestJS Backend (Port 3001)                        │
│                                                             │
│  ┌──────────────────┐          ┌──────────────────┐        │
│  │   API Routes     │          │  Static Serving  │        │
│  │   /api/*        │          │  Angular SPA     │        │
│  │                 │          │                  │        │
│  │  - Gmail API    │          │  Serves:         │        │
│  │  - Emails       │          │  frontend/dist/  │        │
│  │  - Customers    │          │                  │        │
│  │  - Scanning     │          │  index.html      │        │
│  │  - Queue        │          │  *.js, *.css     │        │
│  └──────────────────┘          └──────────────────┘        │
│                                                             │
│  ┌──────────────────────────────────────────────┐          │
│  │         BullMQ Workers (Background)          │          │
│  │  - Email scanning (7M emails)                │          │
│  │  - Redis queue processing                    │          │
│  └──────────────────────────────────────────────┘          │
│                                                             │
└──────────┬────────────────────────┬─────────────────────────┘
           │                        │
           ↓                        ↓
   ┌───────────────┐        ┌──────────────┐
   │  MariaDB      │        │    Redis     │
   │  Port 3306    │        │  Port 6379   │
   │               │        │              │
   │  7M+ emails   │        │  Job Queue   │
   │  Customers    │        │  Progress    │
   └───────────────┘        └──────────────┘
```

**Request Flow:**

1. **Frontend Pages** (`/`, `/dashboard`, `/emails`, etc.)
   - Nginx → NestJS → Serves Angular `index.html`
   - Browser loads Angular SPA
   - Angular handles client-side routing

2. **API Requests** (`/api/gmail/scan`, `/api/emails`, etc.)
   - Angular → HTTP call to `/api/*`
   - NestJS processes request
   - Returns JSON response

3. **Build Process:**
   ```bash
   # Frontend build → frontend/dist/frontend/browser/
   npm run frontend:build

   # Backend build → dist/
   npm run backend:build

   # Both
   npm run build
   ```

4. **Deployment:**
   - Single PM2 process runs NestJS
   - NestJS serves both API and Angular static files
   - No separate nginx config needed for frontend vs backend

---

## Server Requirements (Cloudways)

### Plan Selection
- **Plan Type:** General Purpose 4GB / 2 vCPU
- **RAM:** 4GB (2.5GB MariaDB + 1GB Redis + 0.5GB App)
- **Storage:** 80GB SSD minimum
- **Database:** MariaDB 10.11+ (NOT MySQL - important!)
- **Cost:** ~$48-55/month

### Why General Purpose (not CPU Optimized)?
Application is RAM-heavy, not CPU-heavy:
- MySQL/MariaDB needs 2-3GB for buffer pool (7M email rows)
- Redis needs 500MB-1GB for BullMQ queue persistence
- Node.js app needs 300-500MB
- CPU usage is LOW (mostly I/O bound - waiting on Gmail API)

---

## Step 1: Create Cloudways Server

1. Login to Cloudways Dashboard
2. Create new server:
   - **Application:** PHP (we'll replace it)
   - **Server Size:** 4GB General Purpose
   - **Region:** Choose closest to your users
   - **Database:** Select MariaDB 10.11+ (NOT MySQL!)

3. Wait for server provisioning (~10 minutes)

---

## Step 2: MariaDB Configuration

### Why MariaDB instead of MySQL?
- Better bulk INSERT performance (500 emails/batch × 14,071 batches = 7M emails)
- Optimized thread pool for concurrent reads/writes
- Superior query optimizer for tables with millions of rows
- Cloudways default with better tuning

### Apply MariaDB Tuning

**Via SSH (Recommended):**

```bash
# SSH into server
ssh user@your-server-ip

# Edit MariaDB configuration
sudo nano /etc/my.cnf
```

Add these settings under `[mysqld]` section:

```ini
[mysqld]
# Critical for 7M rows - uses 50% of 4GB RAM
innodb_buffer_pool_size = 2G

# Large log for bulk inserts (500 emails per batch)
innodb_log_file_size = 512M

# Faster for heavy INSERT workloads (trades durability for speed)
innodb_flush_log_at_trx_commit = 2

# For BullMQ concurrency 50 + dashboard connections
max_connections = 200

# Reduce double buffering
innodb_flush_method = O_DIRECT

# Better for large tables
innodb_file_per_table = ON
```

**Restart MariaDB:**

```bash
sudo systemctl restart mariadb
```

**Verify settings applied:**

```bash
mysql -u root -p

# In MySQL prompt:
SHOW VARIABLES LIKE 'innodb_buffer_pool_size';
SHOW VARIABLES LIKE 'max_connections';
EXIT;
```

---

## Step 3: Install Dependencies

```bash
# Update system
sudo apt update && sudo apt upgrade -y

# Install Node.js 18.x (or latest LTS)
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt install -y nodejs

# Install PM2 globally
sudo npm install -g pm2

# Verify installations
node --version
npm --version
pm2 --version
```

---

## Step 4: Setup Redis

```bash
# Install Redis
sudo apt install redis-server -y

# Configure Redis
sudo nano /etc/redis/redis.conf
```

Add/modify these lines:

```ini
maxmemory 1gb
maxmemory-policy allkeys-lru
```

**Start Redis:**

```bash
sudo systemctl enable redis-server
sudo systemctl start redis-server

# Verify Redis is running
redis-cli ping
# Should return: PONG
```

---

## Step 5: Database Setup

```bash
# Login to MariaDB
mysql -u root -p

# Create database
CREATE DATABASE inventorypal_email CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

# Create user (replace PASSWORD with strong password)
CREATE USER 'inventorypal'@'localhost' IDENTIFIED BY 'YOUR_STRONG_PASSWORD';

# Grant privileges
GRANT ALL PRIVILEGES ON inventorypal_email.* TO 'inventorypal'@'localhost';
FLUSH PRIVILEGES;

EXIT;
```

---

## Step 6: Deploy Application

### Upload Code

```bash
# Create application directory
cd /var/www
sudo mkdir inventorypal-email
sudo chown $USER:$USER inventorypal-email
cd inventorypal-email

# Clone repository OR upload via SFTP
git clone <your-repo-url> .

# OR if using SFTP, upload all files to /var/www/inventorypal-email/
```

### Install Dependencies

```bash
cd /var/www/inventorypal-email

# Install backend dependencies
npm install

# Install frontend dependencies
cd frontend
npm install
cd ..
```

### Make Deploy Script Executable

```bash
chmod +x deploy.sh
```

---

## Step 7: Configure Environment

### Update .env.production

```bash
nano .env.production
```

**Fill in these values:**

```env
# Application
NODE_ENV=production
PORT=3001
APP_NAME=InventoryPal Email Platform

# Database - FILL THESE IN!
DB_HOST=localhost
DB_PORT=3306
DB_USERNAME=inventorypal
DB_PASSWORD=YOUR_STRONG_PASSWORD_FROM_STEP_5
DB_DATABASE=inventorypal_email
DB_LOGGING=false
DB_SYNCHRONIZE=false

# Redis
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_PASSWORD=
REDIS_DB=0

# Email Verification
EMAIL_VERIFICATION_HELO_DOMAIN=mail-check.tau-domeniu.ro
EMAIL_VERIFICATION_MAIL_FROM=verify@mail-check.tau-domeniu.ro
EMAIL_VERIFICATION_TIMEOUT=10000

# BullMQ
BULLMQ_CONCURRENCY=50
BULLMQ_RATE_LIMIT_MAX=100
BULLMQ_RATE_LIMIT_DURATION=1000

# JWT - CHANGE THIS TO RANDOM STRING!
JWT_SECRET=GENERATE_RANDOM_64_CHARACTER_STRING_HERE
JWT_EXPIRES_IN=7d

# Logging
LOG_LEVEL=info

# Gmail API Configuration (Production)
GMAIL_CLIENT_ID=YOUR_GMAIL_CLIENT_ID
GMAIL_CLIENT_SECRET=YOUR_GMAIL_CLIENT_SECRET
GMAIL_REDIRECT_URI=https://mailpal.inventorypal.com/api/gmail/oauth2callback
GMAIL_REFRESH_TOKEN=
```

**Generate JWT Secret:**

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
# Copy output and paste as JWT_SECRET
```

---

## Step 8: Run Database Migrations

```bash
# Build application first
npm run build

# Run migrations
NODE_ENV=production npm run typeorm migration:run
```

---

## Step 9: Gmail OAuth Setup (Get Refresh Token)

### Start Application Temporarily

```bash
NODE_ENV=production npm run start
```

### Get Refresh Token

1. Open browser: `https://mailpal.inventorypal.com/api/gmail/auth`
2. Login with Google account that has the emails
3. Grant permissions
4. Copy the **refresh_token** from the redirect page
5. Stop the temporary server (Ctrl+C)

### Update .env.production

```bash
nano .env.production
# Set: GMAIL_REFRESH_TOKEN=<token_from_step_3>
```

---

## Step 10: Deploy with PM2

### Option A: Using Deploy Script (Recommended)

The project includes an automated deployment script that handles everything:

```bash
cd /var/www/inventorypal-email

# First deployment (install deps, build, migrate, start)
./deploy.sh

# Future deployments with git pull
./deploy.sh --pull

# Quick deployment (skip npm install)
./deploy.sh --pull --skip-deps

# Skip database migrations
./deploy.sh --pull --skip-migrations
```

**What the deploy script does:**
1. ✅ Pulls latest code (optional with --pull)
2. ✅ Installs backend dependencies
3. ✅ Installs frontend dependencies
4. ✅ Builds Angular frontend for production
5. ✅ Builds NestJS backend
6. ✅ Runs database migrations
7. ✅ Restarts PM2 (zero downtime reload)
8. ✅ Verifies deployment success

### Option B: Manual Deployment

If you prefer manual control:

```bash
cd /var/www/inventorypal-email

# Create logs directory
mkdir -p logs

# Build frontend
cd frontend
npm run build
cd ..

# Build backend
npm run backend:build

# Run migrations
NODE_ENV=production npm run migration:run

# Start with PM2 using ecosystem config
NODE_ENV=production pm2 start ecosystem.config.js

# Save PM2 configuration
pm2 save

# Setup PM2 to start on server boot
pm2 startup
# Follow the command it outputs (will be something like):
# sudo env PATH=$PATH:/usr/bin pm2 startup systemd -u your-user --hp /home/your-user
```

### Verify Application is Running

```bash
# Check PM2 status
pm2 status

# View logs
pm2 logs inventorypal-email

# Check if app responds
curl http://localhost:3001/health
```

---

## Step 11: Setup Nginx Reverse Proxy

### Create Nginx configuration

```bash
sudo nano /etc/nginx/sites-available/mailpal.inventorypal.com
```

**Add this configuration:**

```nginx
server {
    listen 80;
    server_name mailpal.inventorypal.com;

    location / {
        proxy_pass http://localhost:3001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

**Enable site:**

```bash
sudo ln -s /etc/nginx/sites-available/mailpal.inventorypal.com /etc/nginx/sites-enabled/

# Test configuration
sudo nginx -t

# Reload Nginx
sudo systemctl reload nginx
```

---

## Step 12: Setup SSL with Let's Encrypt

```bash
# Install certbot
sudo apt install certbot python3-certbot-nginx -y

# Get SSL certificate
sudo certbot --nginx -d mailpal.inventorypal.com

# Follow prompts - choose to redirect HTTP to HTTPS

# Verify auto-renewal
sudo certbot renew --dry-run
```

---

## Step 13: Start Gmail Scanning

### Start Full Email Scan

```bash
# Use curl to start scan for ALL emails
curl -X POST https://mailpal.inventorypal.com/api/gmail/scan/queue/start \
  -H "Content-Type: application/json" \
  -d '{
    "scanType": "abuse",
    "daysBack": 10000,
    "autoUpdate": true
  }'

# This will return a job ID - save it!
```

### Monitor Scan Progress

```bash
# Check all jobs
curl https://mailpal.inventorypal.com/api/gmail/scan/queue/jobs | jq

# Check specific job (replace JOB_ID)
curl https://mailpal.inventorypal.com/api/gmail/scan/queue/jobs/JOB_ID | jq
```

**Expected Timeline:**
- **Total Emails:** 7,035,650 (140,713 pages × 50 emails/page)
- **Batch Size:** 500 emails
- **Total Batches:** 14,071 batches
- **Time per Batch:** ~2.5 minutes
- **Total Time:** ~24 days non-stop

---

## Monitoring & Maintenance

### View PM2 Logs

```bash
# Real-time logs
pm2 logs inventorypal-email

# Last 100 lines
pm2 logs inventorypal-email --lines 100

# Error logs only
pm2 logs inventorypal-email --err
```

### Check System Resources

```bash
# Memory usage
free -h

# Disk space
df -h

# CPU usage
top

# PM2 monitoring dashboard
pm2 monit
```

### Restart Application

```bash
# Graceful restart (zero downtime)
pm2 reload inventorypal-email

# Hard restart
pm2 restart inventorypal-email

# Stop application
pm2 stop inventorypal-email

# Start application
pm2 start inventorypal-email
```

### Database Backup

```bash
# Create backup script
sudo nano /usr/local/bin/backup-inventorypal-db.sh
```

**Backup Script:**

```bash
#!/bin/bash
BACKUP_DIR="/var/backups/inventorypal"
DATE=$(date +%Y%m%d_%H%M%S)
mkdir -p $BACKUP_DIR

mysqldump -u inventorypal -p'YOUR_PASSWORD' inventorypal_email | gzip > $BACKUP_DIR/inventorypal_email_$DATE.sql.gz

# Keep only last 7 days of backups
find $BACKUP_DIR -name "*.sql.gz" -mtime +7 -delete

echo "Backup completed: inventorypal_email_$DATE.sql.gz"
```

**Make executable and schedule:**

```bash
sudo chmod +x /usr/local/bin/backup-inventorypal-db.sh

# Add to crontab (daily at 3 AM)
sudo crontab -e
# Add this line:
0 3 * * * /usr/local/bin/backup-inventorypal-db.sh >> /var/log/inventorypal-backup.log 2>&1
```

---

## Troubleshooting

### Application won't start

```bash
# Check logs
pm2 logs inventorypal-email --err

# Check if port 3001 is available
sudo lsof -i:3001

# Verify .env.production is correct
cat .env.production
```

### Database connection fails

```bash
# Test MariaDB connection
mysql -u inventorypal -p inventorypal_email

# Check if MariaDB is running
sudo systemctl status mariadb

# Check logs
sudo tail -f /var/log/mysql/error.log
```

### Redis connection fails

```bash
# Test Redis
redis-cli ping

# Check if Redis is running
sudo systemctl status redis-server

# Check logs
sudo tail -f /var/log/redis/redis-server.log
```

### Gmail API rate limit errors

```bash
# Check logs for "429 Too Many Requests"
pm2 logs inventorypal-email | grep "429"

# Current rate limit settings (in processor):
# - Concurrency: 1 (one scan at a time)
# - Delay between batches: 1 second
# - Batch size: 500 emails

# If still hitting limits, increase delay in:
# src/modules/gmail/processors/gmail-scan.processor.ts line 143
```

### High memory usage

```bash
# Check PM2 memory
pm2 status

# If app exceeds 1GB, PM2 will auto-restart (ecosystem.config.js setting)
# Check restart count:
pm2 status

# If restarts are frequent, increase max_memory_restart:
nano ecosystem.config.js
# Change: max_memory_restart: '1.5G'
pm2 reload inventorypal-email
```

---

## Post-Deployment Checklist

### Server Configuration
- [ ] Cloudways General Purpose 4GB server created
- [ ] MariaDB 10.11+ installed and tuned (innodb_buffer_pool_size = 2G)
- [ ] Redis running and configured (maxmemory 1gb)
- [ ] Node.js 18+ installed
- [ ] PM2 installed globally

### Application Setup
- [ ] Code deployed to `/var/www/inventorypal-email`
- [ ] Backend dependencies installed (`npm install`)
- [ ] Frontend dependencies installed (`cd frontend && npm install`)
- [ ] Deploy script executable (`chmod +x deploy.sh`)

### Configuration
- [ ] .env.production created with all values
- [ ] Database credentials configured
- [ ] JWT_SECRET generated (random 64-char string)
- [ ] Gmail OAuth credentials for production set
- [ ] Gmail refresh token obtained

### Database
- [ ] Database `inventorypal_email` created
- [ ] Database user created with permissions
- [ ] Migrations run successfully

### Build & Deploy
- [ ] Frontend built (`npm run frontend:build`)
- [ ] Backend built (`npm run backend:build`)
- [ ] PM2 application started
- [ ] PM2 configuration saved (`pm2 save`)
- [ ] PM2 startup configured for auto-start on reboot

### Nginx & SSL
- [ ] Nginx reverse proxy configured
- [ ] SSL certificate installed (Let's Encrypt)
- [ ] HTTP to HTTPS redirect enabled

### Verification
- [ ] Application accessible at https://mailpal.inventorypal.com
- [ ] Frontend loads correctly
- [ ] API responding at https://mailpal.inventorypal.com/api/
- [ ] Health endpoint works (`/health`)

### Gmail Integration
- [ ] Gmail OAuth flow completed
- [ ] Email scan started successfully
- [ ] BullMQ queue processing jobs

### Maintenance
- [ ] Database backup cron job configured
- [ ] PM2 logs accessible and rotating
- [ ] Monitoring setup (PM2 monit)

### Future Deployments
- [ ] Deploy script tested (`./deploy.sh`)
- [ ] Git repository configured for `./deploy.sh --pull`

---

## Important Notes

1. **Gmail Scan Duration:** The full scan will take approximately 24 days to complete. Do NOT restart the server during this time unless absolutely necessary.

2. **PM2 Auto-Restart:** If the application crashes or exceeds 1GB memory, PM2 will automatically restart it. The BullMQ job will resume from the last saved pageToken.

3. **Checkpoints:** Currently, pageToken is saved in progress but NOT persisted to job data. If the application restarts, the scan will start from the beginning. This is acceptable for stable production deployment with PM2 auto-restart.

4. **Future Improvement:** Implement true checkpoint/resume by saving pageToken to job data using `job.updateData()` so scans can resume from exact position.

5. **Rate Limits:** Gmail API has quota limits (250 units/user/second). Current settings (concurrency: 1, 1-second delay) are safe and tested.

6. **Database Growth:** Expect final database size of ~70GB for 7M emails. Monitor disk space regularly.

---

## Support & Contacts

- **Application:** InventoryPal Email Platform
- **Version:** 1.0.0
- **Framework:** NestJS 10.3.0
- **Database:** MariaDB 10.11+
- **Queue:** BullMQ with Redis
- **Process Manager:** PM2

For issues, check logs first:
```bash
pm2 logs inventorypal-email
```
