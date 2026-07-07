# Next Steps - Development Roadmap

## Security Backlog

### Secure Login Roadmap 🧭
**Status**: Documented, parked for later.

See [SECURE_LOGIN_ROADMAP.md](./SECURE_LOGIN_ROADMAP.md).

Recommended path:
- Google OpenID Connect login with exact email allowlist.
- Local password login kept as break-glass fallback.
- TOTP 2FA required for admin fallback accounts.
- No SMS-based 2FA.

## Current Sprint (In Progress)

### 0. Validation Intake Gate ⏳
**Goal**: Centralize validation before automatic customer creation.

See [VALIDATION_INTAKE_GATE.md](./VALIDATION_INTAKE_GATE.md).
See also [VALIDATION_PREP_PLAN.md](./VALIDATION_PREP_PLAN.md).
Production rollout checklist: [PRODUCTION_VALIDATION_ROLLOUT.md](./PRODUCTION_VALIDATION_ROLLOUT.md).

Immediate focus:
- Documented intake rules for SuppliKit, Gmail, WooCommerce, Shopify, CSV and JSON.
- Build a shared validation gate service.
- Add explicit `sendEligibility` so campaigns do not infer sendability from `verificationStatus`.
- Connect SuppliKit automatic import/webhook to the gate.
- Keep typo, bounce, suppression and external provider flows separated but connected.

Local progress:
- Structured intake reason codes are implemented.
- Validation batch/event tracking is implemented locally.
- `sendEligibility`, `doNotSendReason`, `lastValidationSource` and `lastValidationAt` are implemented locally.
- Dashboard analytics for `sendEligibility` are implemented locally.
- Emails list filters for `sendEligibility` and `doNotSendReason` are implemented locally.
- Campaign CSV export is gated by `sendEligibility` and defaults to `safe_to_send` locally.
- Production rollout waits for Gmail historical job `43` to finish.

---

### 1. Email Analytics Section ⏳
**Goal**: Add analytics dashboard to emails page

**Features to Implement**:
- [x] Email domain distribution (already have API endpoint)
- [ ] Stats cards at top of page:
  - Total emails
  - Total with customers
  - Average quality score
  - Verification status breakdown
- [ ] Top 10 domains chart (bar chart or table)
- [ ] Verification status pie chart
- [ ] Quality score distribution histogram
- [ ] Daily/weekly growth trend line chart

**Proposed Analytics**:
1. **Domain Analytics**
   - Emails per domain (top 20)
   - Percentage distribution
   - Customer linkage rate per domain

2. **Quality Metrics**
   - Quality score distribution (0-20, 21-40, 41-60, 61-80, 81-100)
   - Verification status breakdown
   - Disposable email percentage
   - Role-based email percentage

3. **Growth Metrics**
   - Emails added per day (last 30 days)
   - Emails added per week (last 12 weeks)
   - Trend line

4. **Customer Metrics**
   - Emails linked to customers
   - Emails without customers
   - Linkage rate by domain

5. **Risk Assessment**
   - Risky emails count
   - Invalid emails count
   - Disposable emails count
   - Unsubscribed emails count

**Backend Requirements**:
```typescript
// New endpoints needed:
GET /api/emails/analytics/overview
GET /api/emails/analytics/domains
GET /api/emails/analytics/quality-distribution
GET /api/emails/analytics/growth-trend
```

**Frontend Implementation**:
- Use Chart.js or ng2-charts for visualizations
- Create separate analytics component or section
- Make it collapsible/expandable
- Cache analytics data (refresh button)

---

### 2. Email Component Styling Improvements ⏳
**Goal**: Improve UI/UX of emails list

**Improvements to Make**:
- [ ] Better table design:
  - Striped rows
  - Hover effects
  - Better spacing
  - Sticky header
- [ ] Improved badge colors:
  - Green for valid
  - Red for invalid
  - Orange for risky
  - Yellow for disposable
  - Gray for pending
  - Dark gray for unsubscribed
- [ ] Loading states:
  - Skeleton loaders instead of spinner
  - Progressive loading
- [ ] Empty states:
  - Better empty state design
  - Suggestions when no results
- [ ] Responsive design:
  - Mobile-friendly table
  - Horizontal scroll on mobile
  - Compact view option
- [ ] Action improvements:
  - Dropdown menu instead of 2 buttons
  - More actions (View Details, Delete, etc.)
  - Confirmation modals instead of browser alerts
- [ ] Filters enhancement:
  - Clear filters button
  - Active filters indicator
  - Save filter presets

---

## Sprint 2: Customers Management

### 3. Customers List Component 📋
**Goal**: Create customers management interface

**Features**:
- [ ] Paginated customers table
- [ ] Search by:
  - Email
  - Name
  - Phone
  - Customer ID
- [ ] Filters:
  - Primary domain
  - Country
  - City
  - Preferred payment method
  - Has multiple domains
  - Total spent range
  - Order count range
- [ ] Sort by:
  - Name
  - Email
  - Total spent
  - Order count
  - Created date
- [ ] Columns:
  - Customer ID
  - Name
  - Email
  - Phone
  - Primary domain
  - Domains count
  - Total spent (sum across domains)
  - Total orders (sum across domains)
  - Created date
  - Actions

**Backend Requirements**:
```typescript
// Enhance existing endpoint:
GET /api/customers
  ?page=1
  &limit=100
  &search=john
  &domain=1
  &country=RO
  &sortBy=totalSpent
  &sortOrder=desc
  &minSpent=100
  &maxSpent=1000
  &minOrders=5
  &maxOrders=50
```

---

### 4. Customer Details Component 📋
**Goal**: View and edit customer details

**Features**:
- [ ] Customer information card:
  - Full name, email, phone
  - Address details
  - Payment preferences
  - Primary domain
- [ ] Domain associations table:
  - List all domains customer has ordered from
  - Per-domain stats (orders, spent)
  - WooCommerce customer ID per domain
- [ ] Email records:
  - All email records linked to customer
  - Email sources
  - Acquisition dates
- [ ] Edit functionality:
  - Edit customer information
  - Change primary domain
  - Merge duplicate customers
- [ ] Order history (if available):
  - Fetch from WooCommerce
  - Display order timeline
  - Total revenue per domain

**Backend Requirements**:
```typescript
GET /api/customers/:id                 // Get customer details
GET /api/customers/:id/domains         // Get domain associations
GET /api/customers/:id/emails          // Get linked emails
PATCH /api/customers/:id               // Update customer
POST /api/customers/:id/merge/:otherId // Merge customers
```

---

### 5. Customer Segmentation 📋
**Goal**: Create and manage customer segments

**Features**:
- [ ] Tags system:
  - VIP
  - Frequent Buyer
  - At Risk
  - New Customer
  - Dormant
  - Custom tags
- [ ] Automatic segment assignment:
  - Based on order count
  - Based on total spent
  - Based on last order date
  - Based on domains count
- [ ] Custom segments:
  - Create segment with filters
  - Save segment
  - Export segment to CSV
- [ ] Segment analytics:
  - Size of each segment
  - Growth over time
  - Conversion rates

**Backend Requirements**:
```typescript
GET /api/customers/segments            // List all segments
POST /api/customers/segments           // Create segment
GET /api/customers/segments/:id        // Get segment members
PUT /api/customers/segments/:id        // Update segment
DELETE /api/customers/segments/:id     // Delete segment
POST /api/customers/segments/:id/export // Export to CSV
```

---

## Sprint 3: Email Verification System

### 6. Automated Email Verification 📋
**Goal**: Implement automatic email validation

**Features**:
- [ ] Syntax validation:
  - RFC 5322 compliance
  - Common typo detection
  - Suggestion engine
- [ ] DNS validation:
  - MX record lookup
  - Domain existence check
  - SPF/DKIM verification
- [ ] SMTP validation:
  - SMTP server connection
  - RCPT TO verification
  - Rate limiting (100/hour per domain)
  - Retry logic
- [ ] Disposable detection:
  - Maintain disposable domain list
  - Regular updates
  - API integration (disposable.email)
- [ ] Role-based detection:
  - Common patterns (info@, admin@, etc.)
  - Configurable patterns

**Backend Implementation**:
```typescript
// New module: email-verification
src/modules/email-verification/
  ├── services/
  │   ├── syntax-validator.service.ts
  │   ├── dns-validator.service.ts
  │   ├── smtp-validator.service.ts
  │   └── verification-orchestrator.service.ts
  ├── processors/
  │   └── verification.processor.ts  // Bull queue processor
  └── controllers/
      └── verification.controller.ts

// New endpoints:
POST /api/verification/verify-single/:emailId  // Verify one email
POST /api/verification/verify-batch            // Verify multiple
POST /api/verification/verify-all              // Queue all pending
GET /api/verification/status/:jobId            // Get verification job status
```

---

### 7. Queue System (Bull) 📋
**Goal**: Background job processing for verification

**Features**:
- [ ] Install and configure Bull
- [ ] Create verification queue
- [ ] Batch processing (1000 emails per job)
- [ ] Progress tracking
- [ ] Retry logic (3 attempts)
- [ ] Failed job handling
- [ ] Queue dashboard (Bull Board)

**Configuration**:
```typescript
// verification.queue.ts
export const VERIFICATION_QUEUE = 'email-verification';

// Job types:
- verify-single
- verify-batch
- verify-domain
- verify-all-pending
```

---

## Sprint 4: Campaign Management

### 8. Campaign Creation 📋
**Goal**: Create and manage email campaigns

**Features**:
- [ ] Campaign wizard:
  - Step 1: Campaign details (name, subject, from)
  - Step 2: Select recipients (segments, filters)
  - Step 3: Email template/content
  - Step 4: Schedule
  - Step 5: Review and launch
- [ ] Template builder:
  - Drag-and-drop editor
  - Pre-built templates
  - Variable insertion
  - Preview
- [ ] Recipient selection:
  - Choose segments
  - Apply filters
  - Exclude unsubscribed
  - Estimated reach
- [ ] Scheduling:
  - Send immediately
  - Schedule for later
  - Recurring campaigns

**Backend Implementation**:
```typescript
// New entities:
- Campaign
- CampaignTemplate
- CampaignSend
- CampaignRecipient

// New endpoints:
POST /api/campaigns                 // Create campaign
GET /api/campaigns                  // List campaigns
GET /api/campaigns/:id              // Get campaign
PATCH /api/campaigns/:id            // Update campaign
DELETE /api/campaigns/:id           // Delete campaign
POST /api/campaigns/:id/send        // Send campaign
POST /api/campaigns/:id/schedule    // Schedule campaign
GET /api/campaigns/:id/recipients   // Preview recipients
```

---

### 9. Email Sending Infrastructure 📋
**Goal**: Integrate with email service providers

**Features**:
- [ ] ESP Integration:
  - SendGrid
  - Amazon SES
  - Mailgun
  - SMTP fallback
- [ ] Sending queue:
  - Batch sending
  - Rate limiting
  - Retry logic
- [ ] Bounce handling:
  - Hard bounces (mark as invalid)
  - Soft bounces (retry)
  - Bounce tracking
- [ ] Unsubscribe management:
  - One-click unsubscribe
  - Unsubscribe page
  - Resubscribe option
- [ ] Tracking:
  - Open tracking (pixel)
  - Click tracking (link wrapping)
  - Conversion tracking

---

### 10. Campaign Analytics 📋
**Goal**: Track campaign performance

**Features**:
- [ ] Real-time metrics:
  - Sent count
  - Delivered count
  - Open rate
  - Click-through rate
  - Bounce rate
  - Unsubscribe rate
- [ ] Engagement timeline
- [ ] Link click heatmap
- [ ] Device/client breakdown
- [ ] Geographic distribution
- [ ] Revenue attribution (if e-commerce)
- [ ] A/B testing support

---

## Sprint 5: Advanced Features

### 11. Customer Lifetime Value 📋
- [ ] LTV calculation per customer
- [ ] LTV by acquisition source
- [ ] LTV by domain
- [ ] Predictive LTV modeling
- [ ] Cohort analysis

### 12. Engagement Scoring 📋
- [ ] Email engagement score
- [ ] Purchase frequency score
- [ ] Combined score
- [ ] Automatic segmentation

### 13. Bulk Operations 📋
- [ ] Multi-select emails
- [ ] Bulk status updates
- [ ] Bulk export
- [ ] Bulk delete
- [ ] Bulk assign to segment

### 14. Audit Log 📋
- [ ] Track all data changes
- [ ] User actions log
- [ ] GDPR compliance
- [ ] Export audit logs

### 15. Domain Management UI 📋
- [ ] CRUD for domains
- [ ] Test WooCommerce connection
- [ ] Manual import triggers
- [ ] Domain settings

### 16. Analytics Dashboard 📋
- [ ] System overview
- [ ] Per-domain analytics
- [ ] Conversion funnels
- [ ] Revenue tracking
- [ ] Custom reports

---

## Sprint 6: Performance & Scalability

### 17. Database Optimization 📋
- [ ] Index optimization
- [ ] Query performance tuning
- [ ] Partition large tables
- [ ] Archive old data

### 18. Caching Strategy 📋
- [ ] Redis caching for frequent queries
- [ ] Cache invalidation strategy
- [ ] CDN for static assets

### 19. API Rate Limiting 📋
- [ ] Implement rate limiting
- [ ] Fair usage policies
- [ ] API key system

---

## Testing & Quality Assurance

### Unit Tests 📋
- [ ] Backend services (80% coverage)
- [ ] Frontend components (70% coverage)
- [ ] Integration tests
- [ ] E2E tests

### Performance Testing 📋
- [ ] Load testing (10k concurrent users)
- [ ] Database query optimization
- [ ] Frontend bundle optimization

---

## Security

### Authentication & Authorization 📋
- [ ] JWT authentication
- [ ] Role-based access control
- [ ] API key management
- [ ] Session management

### Data Protection 📋
- [ ] Encrypt sensitive data
- [ ] GDPR compliance features
- [ ] Data export/deletion
- [ ] Privacy policy integration

---

## Deployment

### Production Readiness 📋
- [ ] Environment configuration
- [ ] Database migrations
- [ ] Logging and monitoring
- [ ] Error tracking (Sentry)
- [ ] Performance monitoring
- [ ] Backup strategy

---

**Priority Order**:
1. ✅ Email Analytics + Styling (Current Sprint)
2. Customers Management (Sprint 2)
3. Email Verification (Sprint 3)
4. Campaign Management (Sprint 4)
5. Advanced Features (Sprint 5)
6. Performance & Scalability (Sprint 6)

**Estimated Timeline**:
- Current Sprint: 3-5 days
- Sprint 2: 1 week
- Sprint 3: 1 week
- Sprint 4: 2 weeks
- Sprint 5: 2 weeks
- Sprint 6: 1 week

**Total**: ~7-8 weeks for full implementation

---

**Last Updated**: 2026-04-29
