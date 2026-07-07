# Production Deployment Guide

## Quick Deploy

Pentru deploy rapid în producție:

```bash
npm run deploy:prod
```

Acest script va:
1. ✅ Build backend local
2. ✅ Upload cod pe server
3. ✅ Instalează dependencies
4. ✅ Restart PM2 (clean restart - delete + start)
5. ✅ Verifică deployment

## Deployment Manual (Step by Step)

### 1. Build Local

```bash
# Build backend
npm run backend:build

# Build frontend (opțional - doar dacă ai modificat frontend)
npm run frontend:build
```

### 2. Upload Code

```bash
npm run deploy:upload
# SAU direct:
./upload-code.sh
```

### 3. SSH pe Server

```bash
# Din .env.server
sshpass -p 'PASSWORD' ssh USER@HOST
cd /home/1619442.cloudwaysapps.com/yqcmhdmpah/public_html/inventorypal-email
```

### 4. Install Dependencies

```bash
npm install --legacy-peer-deps --production
```

### 5. Restart PM2 (IMPORTANT!)

**FOARTE IMPORTANT**: Pentru a evita cache issues și erori Redis, folosește delete + start:

```bash
# STOP și DELETE procesul vechi
npx pm2 stop inventorypal-email
npx pm2 delete inventorypal-email

# START proces nou (încarcă fresh env vars)
npx pm2 start ecosystem.config.js

# SAVE configurația
npx pm2 save
```

**NU folosi** `pm2 restart` - poate cauza:
- Cache issues cu modulele vechi
- Environment variables neîncărcate corect
- Erori Redis WRONGPASS

### 6. Verify Deployment

```bash
# Status PM2
npx pm2 status

# Logs
npx pm2 logs inventorypal-email --lines 50

# Test endpoint
curl http://mailpal.inventorypal.ro/api/auth/login
```

## Troubleshooting

### Redis WRONGPASS Errors

**Cauză**: PM2 nu a încărcat noile environment variables

**Soluție**:
```bash
npx pm2 delete inventorypal-email
npx pm2 start ecosystem.config.js
```

### 502 Bad Gateway

**Verificări**:
```bash
# PM2 status
npx pm2 status

# Logs
npx pm2 logs inventorypal-email --err --lines 30

# Port listening
lsof -i :3001
```

**Soluție**:
```bash
# Kill process pe port 3001 (dacă există)
lsof -i :3001 | grep LISTEN | awk '{print $2}' | xargs kill -9

# Restart PM2
npx pm2 delete inventorypal-email
npx pm2 start ecosystem.config.js
```

### Application Crashes (max_restarts reached)

**Cauză**: Erori la pornire (de obicei dependency issues sau env vars)

**Verificare**:
```bash
# Logs detaliate
npx pm2 logs inventorypal-email --err --lines 100

# Test manual
NODE_ENV=production node dist/src/main.js
```

**Soluții**:
1. Verifică că toate dependencies sunt instalate
2. Verifică `.env.production` pentru variabile lipsă
3. Verifică că `dist/src/main.js` există

### Disk Space Full (102GB Logs)

**Prevenit prin**: PM2 log rotation în `ecosystem.config.js`
```javascript
max_size: '100M',
max_files: 5,
compress: true,
```

**Verificare disk space**:
```bash
df -h
du -sh logs/
```

**Cleanup manual**:
```bash
# Delete old logs
rm -f logs/pm2-error.log logs/pm2-out.log

# Restart PM2 pentru a crea logs noi
npx pm2 restart inventorypal-email
```

## Environment Variables

Fișiere necesare pe server:

### `.env.production`
```env
NODE_ENV=production
PORT=3001

# Database
DB_HOST=localhost
DB_PORT=3306
DB_USERNAME=yqcmhdmpah
DB_PASSWORD=***
DB_DATABASE=yqcmhdmpah

# Redis
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_USERNAME=yqcmhdmpah
REDIS_PASSWORD=***
REDIS_DB=0

# JWT
JWT_SECRET=***
JWT_EXPIRES_IN=7d

# Gmail API
GMAIL_CLIENT_ID=***
GMAIL_CLIENT_SECRET=***
GMAIL_REDIRECT_URI=https://mailpal.inventorypal.ro/api/gmail/oauth2callback
```

## Security Notes

### Admin Credentials

Set admin credentials via environment variables before running the seed script:

```env
ADMIN_EMAIL=admin@example.com
ADMIN_PASSWORD=CHANGE_THIS_TO_A_STRONG_PASSWORD
```

**IMPORTANT**: Schimbă parola după primul login!

### Protected Endpoints

Toate endpoint-urile `/api/*` sunt protejate cu JWT auth.

**Excepții (public)**:
- `POST /api/auth/login`
- `POST /api/auth/register`
- `GET /api/gmail/oauth2callback`

## PM2 Management

### Useful Commands

```bash
# Status
npx pm2 status

# Logs (live)
npx pm2 logs inventorypal-email

# Logs (last 100 lines)
npx pm2 logs inventorypal-email --lines 100 --nostream

# Only errors
npx pm2 logs inventorypal-email --err

# Restart
npx pm2 delete inventorypal-email && npx pm2 start ecosystem.config.js

# Monitor
npx pm2 monit

# Save current state
npx pm2 save

# Startup script (run once)
npx pm2 startup
```

## Deployment Checklist

- [ ] Build backend local: `npm run backend:build`
- [ ] Upload code: `npm run deploy:upload`
- [ ] SSH pe server
- [ ] Install dependencies: `npm install --legacy-peer-deps --production`
- [ ] Stop PM2: `npx pm2 delete inventorypal-email`
- [ ] Start PM2: `npx pm2 start ecosystem.config.js`
- [ ] Save PM2: `npx pm2 save`
- [ ] Verify logs: `npx pm2 logs inventorypal-email --lines 30`
- [ ] Test API: `curl http://mailpal.inventorypal.ro/api/auth/login`
- [ ] Test Frontend: Open http://mailpal.inventorypal.ro

## Production URLs

- **Frontend**: http://mailpal.inventorypal.ro
- **API**: http://mailpal.inventorypal.ro/api
- **Auth Login**: http://mailpal.inventorypal.ro/api/auth/login
- **Stats**: http://mailpal.inventorypal.ro/api/emails/stats

## Next Steps After Deployment

1. **Gmail OAuth Setup**:
   - Navigate to: http://mailpal.inventorypal.ro/api/gmail/auth-url
   - Complete OAuth flow
   - Refresh token va fi salvat automat

2. **Test Email Verification**:
   ```bash
   curl -X POST http://mailpal.inventorypal.ro/api/verification/test \
     -H "Authorization: Bearer YOUR_JWT_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"email":"test@example.com"}'
   ```

3. **Monitor Application**:
   - Check PM2 logs periodic
   - Monitor disk space: `df -h`
   - Check database size: `du -sh /var/lib/mysql/`

## Support

Pentru probleme de deploy, verifică:
1. PM2 logs: `npx pm2 logs inventorypal-email --err`
2. Nginx logs: `tail -f /var/log/nginx/error.log`
3. System logs: `journalctl -xe`
