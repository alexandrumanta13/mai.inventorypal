# InventoryPal Email - Project Overview

## Project Description

InventoryPal Email is a comprehensive email and customer management system designed to centralize email data from multiple e-commerce domains, verify email quality, manage customer relationships, and prepare for email marketing campaigns.

### Tech Stack
- **Backend**: NestJS 10.3.0 with Fastify adapter
- **Frontend**: Angular 20 (standalone components)
- **Database**: MySQL 8.0 with TypeORM
- **Cache**: Redis for session management
- **External Integrations**: WooCommerce HPOS databases (direct MySQL connections)

---

## Current Implementation Status

### ✅ Completed Features

#### 1. Database Schema
- **emails** table: 1.93M records with email verification fields
  - Fields: email (unique), customerId, emailDomain, verification status, quality scores, etc.
  - Indexes: email (unique), customerId, emailDomain, createdAt

- **customers** table: 75,436 unique customers
  - Full address fields, payment preferences, WooCommerce customer IDs
  - Primary domain tracking

- **customer_domains** junction table: 127,033 associations
  - Many-to-many relationship for cross-domain customer tracking
  - Per-domain stats (order count, total spent, WooCommerce customer ID)

- **domains** table: 6 domains configured
  - 3 active WooCommerce domains (with database credentials)
  - 3 inactive CSV-only domains

- **import_jobs** table: Import tracking and progress monitoring
- **email_sources** table: GDPR compliance tracking

#### 2. Data Import System

##### WooCommerce HPOS Import
- **File**: `src/modules/import/services/woocommerce-import.service.ts`
- **Features**:
  - Direct MySQL connection to remote WooCommerce databases
  - HPOS schema support (wp_wc_orders, wp_wc_order_addresses)
  - Customer data aggregation (orders, spending, addresses)
  - Payment method detection and mapping
  - Automatic email-to-customer linking

**Import Results**:
| Domain | Customers Imported | Emails Linked |
|--------|-------------------|---------------|
| fabricadeasternuturi.ro | 66,200 | ~48,000 |
| fabrica-pucioasa.ro | 6,934 | ~5,000 |
| asternuturi-pucioasa.ro | 2,391 | ~1,700 |

##### CSV Import
- **File**: `src/modules/import/services/csv-import.service.ts`
- **Features**:
  - Batch processing (10,000 records per batch)
  - Domain mapping by filename pattern
  - Customer creation for inactive domains
  - In-memory deduplication + database UNIQUE constraint
  - Progress tracking

**Import Results**:
| Domain | Customers Created | Source Files |
|--------|------------------|--------------|
| fabricapucioasa.ro | 51,048 | fabrica-pucioasa-clienti.csv |
| depozituldeasternuturi.ro | 391 | depozitul de asternuturi-comenzi.csv |
| lenjeriiieftine.ro | 69 | lenjeriiieftine-comenzi.csv |

##### JSON Pages Import
- **File**: `src/modules/import/services/json-import.service.ts`
- Batch processing of JSON page files
- ~1.87M emails imported initially

#### 3. Backend API Endpoints

##### Emails Module
```
GET    /api/emails                        - List emails (paginated, filtered)
GET    /api/emails/:id                    - Get single email
GET    /api/emails/stats                  - Email statistics by status
GET    /api/emails/domains                - List email domains with counts
PATCH  /api/emails/:id/status             - Update verification status
```

**Query Parameters**:
- `page`, `limit` - Pagination
- `status` - Filter by verification status (pending, valid, invalid, risky, disposable, unsubscribed)
- `search` - Search by email address (LIKE)
- `emailDomain` - Filter by domain
- `minScore` - Filter by minimum quality score

##### Import Module
```
POST   /api/imports/json-pages            - Start JSON import
POST   /api/imports/csv                   - Start CSV import
POST   /api/imports/woocommerce           - Import from all active domains
POST   /api/imports/woocommerce/:domainId - Import from specific domain
GET    /api/imports/jobs                  - List import jobs
GET    /api/imports/jobs/:id              - Get import job status
```

##### Domains Module
```
GET    /api/domains                       - List all domains
GET    /api/domains/active                - List active domains
GET    /api/domains/:id                   - Get domain by ID
POST   /api/domains                       - Create domain (not yet implemented)
PATCH  /api/domains/:id                   - Update domain (not yet implemented)
```

##### Customers Module
```
GET    /api/customers                     - List customers (basic, needs enhancement)
GET    /api/customers/:id                 - Get customer details (not yet implemented)
```

#### 4. Frontend Components

##### Emails Component (`frontend/src/app/pages/emails`)
**Features**:
- Paginated email list (100 per page)
- Live search with 300ms debounce
- Filters:
  - Status filter (pending, valid, invalid, risky, disposable, unsubscribed)
  - Domain filter (dropdown with all domains)
- Table columns:
  - Email address
  - Status badge (color-coded)
  - Quality score
  - Validation flags (Syntax ✓/✗, DNS ✓/✗, SMTP ✓/-)
  - Customer ID (#12345 or -)
  - Email domain
  - Created date
  - Action buttons (Mark Risky, Unsubscribe)
- Action buttons with confirmation dialogs
- Responsive design

**APIs Used**:
- `GET /api/emails` - Load emails with filters
- `GET /api/emails/domains` - Load domain filter options
- `PATCH /api/emails/:id/status` - Update status

---

## Domain Configuration

### Active Domains (WooCommerce)
1. **fabricadeasternuturi.ro** (ID: 1)
   - Host: 209.250.236.158
   - Database: fabrica_wp_db
   - Prefix: wp_
   - Status: Active

2. **fabrica-pucioasa.ro** (ID: 2)
   - Host: 209.250.236.158
   - Database: fabricapucioasa_wp_db
   - Prefix: wp_
   - Status: Active

3. **asternuturi-pucioasa.ro** (ID: 3)
   - Host: 209.250.236.158
   - Database: asternuturipucioasa_wp_db
   - Prefix: wp_
   - Status: Active

### Inactive Domains (CSV Only)
4. **fabricapucioasa.ro** (ID: 4) - CSV import only
5. **depozituldeasternuturi.ro** (ID: 5) - CSV import only
6. **lenjeriiieftine.ro** (ID: 6) - CSV import only

---

## Customer Deduplication Strategy

The system uses email addresses as the unique identifier for customers across all domains:

1. **Single Customer Record**: One customer per unique email address
2. **Primary Domain**: First domain where customer was imported
3. **Cross-Domain Tracking**: Junction table `customer_domains` tracks:
   - Which domains the customer has ordered from
   - Per-domain statistics (order count, total spent)
   - Domain-specific IDs (WooCommerce customer_id)

**Example**:
```
Customer: john@example.com
- Primary Domain: fabricadeasternuturi.ro (first import)
- Also ordered from:
  - fabrica-pucioasa.ro (3 orders, €250)
  - lenjeriiieftine.ro (1 order, €45)
```

---

## Email Verification System

### Verification Status Enum
```typescript
enum VerificationStatus {
  PENDING = 'pending',      // Not yet verified
  VALID = 'valid',          // All checks passed
  INVALID = 'invalid',      // Failed validation
  RISKY = 'risky',          // Suspicious patterns
  DISPOSABLE = 'disposable', // Temporary email service
  UNSUBSCRIBED = 'unsubscribed' // User opted out
}
```

### Verification Fields
- `hasValidSyntax`: Email format check (RFC 5322)
- `hasValidDns`: MX record exists for domain
- `hasValidSmtp`: SMTP server accepts email
- `isDisposable`: Matches disposable email list
- `isRoleBased`: Generic role address (info@, admin@, etc.)
- `hasTypo`: Common typo detection
- `typoSuggestion`: Suggested correction
- `qualityScore`: 0-100 score based on all checks

### Current Implementation
- Manual status updates via UI (Mark Risky, Unsubscribe)
- Automatic verification service **NOT YET IMPLEMENTED**

---

## Data Statistics (Current)

### Emails
- **Total**: 1,932,834 emails
- **Linked to Customers**: 57,291 (3%)
- **Top Domains**:
  - yahoo.com: 1,016,617
  - gmail.com: 733,449
  - yahoo.ro: 28,190
  - ymail.com: 8,470

### Customers
- **Total Unique**: 75,436
- **Total Domain Associations**: 127,033
- **Average Domains per Customer**: 1.68

### Imports Completed
- JSON Pages: 1 job (1,873,247 emails)
- CSV: 1 job (51,587 records, all duplicates)
- WooCommerce: 3 domains (75,525 customers)

---

## Next Steps (Roadmap)

### Phase 1: Analytics & Improvements (Current Focus)
- [ ] **Email Analytics Section**
  - Domain distribution chart
  - Top 10 domains by count
  - Verification status breakdown
  - Quality score distribution
  - Daily/weekly growth trends

- [ ] **Email Component Styling**
  - Improved table design
  - Better badge colors
  - Loading states
  - Empty states
  - Responsive improvements

### Phase 2: Customers Management
- [ ] **Customers List Page**
  - Paginated table
  - Search by name, email, phone
  - Filter by domain, country, payment method
  - Sort by total spent, order count, last order date

- [ ] **Customer Detail Page**
  - Full customer information
  - Order history (if available from WooCommerce)
  - Email history
  - Domain associations
  - Edit customer data

- [ ] **Customer Segmentation**
  - Tags system (VIP, Frequent Buyer, At Risk, etc.)
  - Custom segments creation
  - Export segments to CSV

### Phase 3: Email Verification System
- [ ] **Automated Verification**
  - Syntax validation service
  - DNS/MX record checking
  - SMTP verification (with rate limiting)
  - Disposable email detection
  - Typo detection (did you mean?)

- [ ] **Queue System**
  - Bull/BullMQ for job processing
  - Batch verification jobs
  - Progress tracking
  - Retry logic for failures

- [ ] **Verification Settings**
  - Configure verification rules
  - Set quality score thresholds
  - Enable/disable specific checks
  - Rate limit configuration

### Phase 4: Campaign Management
- [ ] **Campaign Creation**
  - Create email campaigns
  - Select target segments
  - Email template builder
  - Schedule sending

- [ ] **Sending Infrastructure**
  - Integration with SendGrid/Mailgun/SES
  - Batch sending with rate limiting
  - Bounce handling
  - Unsubscribe link management

- [ ] **Campaign Analytics**
  - Open rate tracking
  - Click-through rate
  - Bounce rate
  - Unsubscribe rate
  - Revenue attribution

### Phase 5: Advanced Features
- [ ] **Customer Lifetime Value**
  - Calculate LTV per customer
  - LTV by acquisition source
  - LTV by domain
  - Predictive LTV modeling

- [ ] **Engagement Scoring**
  - Email engagement score (opens, clicks)
  - Purchase frequency score
  - Combined engagement + purchase score
  - Automatic segment assignment

- [ ] **Bulk Operations**
  - Select multiple emails
  - Bulk status updates
  - Bulk export
  - Bulk delete

- [ ] **Audit Log**
  - Track all data changes
  - User actions log
  - GDPR compliance tracking
  - Export audit logs

- [ ] **Domain Management UI**
  - CRUD operations for domains
  - Test WooCommerce connection
  - Manual import triggers
  - Domain-level settings

- [ ] **Analytics Dashboard**
  - Overall system metrics
  - Per-domain analytics
  - Conversion funnels
  - Revenue tracking
  - Custom reports

### Phase 6: Performance & Scalability
- [ ] **Database Optimization**
  - Index optimization
  - Query performance tuning
  - Archiving old data

- [ ] **Caching Strategy**
  - Redis caching for frequent queries
  - CDN for static assets
  - Response caching

- [ ] **API Rate Limiting**
  - Protect against abuse
  - Fair usage policies

---

## Development Environment

### Prerequisites
- Node.js 18+
- MySQL 8.0
- Redis 7.0
- Angular CLI

### Setup
```bash
# Backend
npm install
npm run start:dev  # Port 3001

# Frontend
cd frontend
npm install
npm run start      # Port 4200
```

### Environment Variables
```env
# Database
DATABASE_HOST=localhost
DATABASE_PORT=3306
DATABASE_USER=root
DATABASE_PASSWORD=
DATABASE_NAME=inventorypal_email

# Redis
REDIS_HOST=localhost
REDIS_PORT=6379

# CSV Import
CSV_ORDERS_PATH=/Users/alexmanta/Developer/sem/sites-orders
IMPORT_BATCH_SIZE=10000
```

### Running Imports
```bash
# JSON Pages Import
curl -X POST http://localhost:3001/api/imports/json-pages

# CSV Import
curl -X POST http://localhost:3001/api/imports/csv

# WooCommerce Import (all domains)
curl -X POST http://localhost:3001/api/imports/woocommerce

# WooCommerce Import (specific domain)
curl -X POST http://localhost:3001/api/imports/woocommerce/1
```

---

## Architecture Notes

### Import Job Pattern
All imports follow the same pattern:
1. Create `ImportJob` record with `PENDING` status
2. Update status to `RUNNING` and set `startedAt`
3. Process data in batches (fire-and-forget async)
4. Update progress periodically
5. Mark as `COMPLETED` or `FAILED` with `completedAt`

This allows:
- Non-blocking API responses
- Progress monitoring via `GET /api/imports/jobs/:id`
- Error handling and retry logic
- Historical tracking of all imports

### Customer Upsert Pattern
```typescript
// Check if customer exists
const existing = await customersService.findByEmail(email);

// Upsert (update or insert)
const customer = await customersService.upsert({
  email,
  firstName,
  lastName,
  // ... other fields
  primaryDomainId: existing ? existing.primary_domain_id : newDomainId
});

// Associate with domain (no duplicates)
await customersService.associateWithDomain(customer.id, domainId, {
  orderCount,
  totalSpent,
  woocommerceCustomerId
});

// Link emails to customer
await emailRepository.update(
  { email },
  { customerId: customer.id }
);
```

---

## File Structure

```
inventorypal-email/
├── src/                          # Backend (NestJS)
│   ├── modules/
│   │   ├── emails/
│   │   │   ├── entities/         # Email, EmailSource
│   │   │   ├── services/         # EmailsService
│   │   │   └── controllers/      # EmailsController
│   │   ├── customers/
│   │   │   ├── entities/         # Customer, CustomerDomain
│   │   │   ├── services/         # CustomersService
│   │   │   └── controllers/      # CustomersController
│   │   ├── domains/
│   │   │   ├── entities/         # Domain
│   │   │   └── services/         # DomainsService
│   │   ├── import/
│   │   │   ├── entities/         # ImportJob
│   │   │   ├── services/
│   │   │   │   ├── json-import.service.ts
│   │   │   │   ├── csv-import.service.ts
│   │   │   │   └── woocommerce-import.service.ts
│   │   │   └── controllers/      # ImportController
│   │   └── email-verification/   # Future verification service
│   └── shared/
│       └── enums/                # Shared enums
├── frontend/                     # Angular 20
│   └── src/
│       └── app/
│           └── pages/
│               └── emails/       # Emails component (complete)
└── docs/                         # Documentation
    └── PROJECT_OVERVIEW.md       # This file
```

---

## Known Issues & Technical Debt

1. **No Email Verification**: Automated verification not yet implemented
2. **Limited Customer API**: Needs full CRUD and details endpoint
3. **No Customer UI**: Frontend component not yet built
4. **No Analytics Dashboard**: Needs separate analytics module
5. **No Campaign System**: Email sending not implemented
6. **Manual Domain Config**: Domain management UI needed
7. **No Bulk Actions**: Multi-select and bulk operations needed
8. **No Audit Log**: Change tracking for compliance
9. **Performance**: Large datasets (1.9M emails) may need optimization
10. **Testing**: Unit tests and E2E tests needed

---

## Contributing Guidelines

### Code Style
- Use TypeScript strict mode
- Follow NestJS best practices
- Use Angular standalone components
- Write meaningful commit messages
- Add JSDoc comments for complex logic

### Database Migrations
- Always create migrations for schema changes
- Test migrations in development before production
- Never modify data directly in production

### Import Safety
- All imports should be idempotent
- Handle duplicates gracefully
- Log all errors with context
- Track import progress

---

## License

Proprietary - Internal use only

---

**Last Updated**: 2026-04-29
**Version**: 0.1.0 (Alpha)
**Author**: InventoryPal Team
