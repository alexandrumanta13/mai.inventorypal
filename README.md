# InventoryPal Email Platform

Email marketing platform cu self-hosted email verification (4 straturi) pentru pre-filter înainte de NeverBounce.

## Features FAZA 1

- ✅ Import 3.5M emailuri din JSON files + InventoryPal orders
- ✅ Verificare self-hosted 4 straturi (FĂRĂ trimitere efectivă):
  - Strat 1: Syntax validation (RFC 5322)
  - Strat 2: DNS/MX lookup (cu Redis cache 24h)
  - Strat 3: SMTP handshake verification (timeout 10s)
  - Strat 4: Filters (disposable, role-based, typo detection)
- ✅ BullMQ queue processing (22K emailuri/zi sustained)
- ✅ REST API (import, verification, analytics, CRUD)
- ✅ Quality scoring (0-100) și status classification

## Tech Stack

- **Framework**: NestJS 10.x (Fastify)
- **Database**: MySQL 8.0 (Cloudways)
- **Cache**: Redis 7.x (Cloudways)
- **Queue**: BullMQ 5.x
- **ORM**: TypeORM 0.3.x

## Installation

```bash
# Install dependencies
npm install

# Copy environment file
cp .env.example .env

# Edit .env cu Cloudways credentials
nano .env

# Run migrations
npm run migration:run

# Start development server
npm run start:dev
```

## Environment Variables

Vezi [.env.example](.env.example) pentru configurare completă.

**Important**:
- `EMAIL_VERIFICATION_*` configurații NU trimit emailuri efectiv
- Doar verifică dacă mailbox-ul există prin SMTP dialog

## API Endpoints

### Import
- `POST /api/imports/json-pages` - Import emailuri din sem/json_pages
- `POST /api/imports/inventorypal` - Import din InventoryPal orders
- `GET /api/imports/jobs/:id` - Status import job

### Verification
- `POST /api/verification/single` - Verificare real-time (1 email)
- `POST /api/verification/bulk` - Queue bulk verification
- `GET /api/verification/queue-stats` - BullMQ queue status

### Emails
- `GET /api/emails` - List emails (paginated, filtered)
- `GET /api/emails/:id` - Email details cu history
- `GET /api/emails/export` - Export CSV

### Analytics
- `GET /api/analytics/overview` - Dashboard stats
- `GET /api/analytics/verification-performance` - Metrics

## Database Schema

4 tabele principale:
- `emails` - 3.5M records, emailuri cu status verificare
- `email_sources` - GDPR consent tracking
- `verification_history` - Audit trail verificări
- `import_jobs` - Progress tracking import jobs

## Verification Flow

```
Email → [Syntax] → [DNS/MX] → [SMTP Check] → [Filters] → Result
```

**IMPORTANT**: SMTP Check = test dacă mailbox există (HELO/RCPT dialog).
**NU trimite niciun email efectiv!**

## Development

```bash
# Development mode (watch)
npm run start:dev

# Build
npm run build

# Production
npm run start:prod

# Tests
npm run test
npm run test:e2e
npm run test:cov
```

## Deployment (Cloudways)

1. Push code to Git repository
2. SSH în Cloudways server
3. Clone repository
4. `npm install --production`
5. Setup .env cu Cloudways MySQL + Redis
6. `npm run migration:run`
7. `npm run build`
8. Start cu PM2: `pm2 start dist/main.js --name inventorypal-email`

## License

UNLICENSED - Proprietary
