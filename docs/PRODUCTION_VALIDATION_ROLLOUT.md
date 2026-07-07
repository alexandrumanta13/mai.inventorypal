# Production Validation Rollout

Last updated: 2026-07-06

## Guardrail

Gmail historical job `43` is complete. Production rollout may proceed after preflight.

Latest production check:

- checked at UTC: `2026-07-06T13:19:26.734Z`
- job `43`: completed
- progress: `349919`
- result: `349919` scanned, `114666` detected, `114389` updated, `275` created, `20537` errors
- finished at UTC: `2026-07-05T16:37:11.828Z`
- queue: 0 active, 0 waiting, 9 completed, 2 failed
- daily jobs `44`, `45`, `46`, `47`, `48`: completed
- Redis policy fixed after rollout: `noeviction`, `evicted_keys=0`

## What This Rollout Contains

Backend/API:

- validation batch/event entities and migrations
- `sendEligibility`, `doNotSendReason`, `lastValidationSource`, `lastValidationAt`
- send eligibility analytics endpoint
- emails list filters for send eligibility and reason
- campaign CSV export gated by `safe_to_send` by default
- SuppliKit recovered emails saved as `pending` before validation

Frontend:

- Dashboard send eligibility panel
- Emails list send gate filters and column
- Campaign export gate in Emails > Validation

Worker-sensitive logic:

- Gmail smart-scan send eligibility updates
- email verifier send eligibility updates

Because worker logic changed, the worker must be restarted after API deploy/migrations are verified.

## Migration Order

TypeORM will run pending migrations by timestamp:

1. `1777650500000-CreateEmailValidationTables`
2. `1777650600000-AddEmailSendEligibilityFields`

Important effects:

- creates `email_validation_batches`
- creates `email_validation_events`
- adds send eligibility fields to `emails`
- backfills existing `emails` rows into `pending`, `safe_to_send`, `review`, or `do_not_send`
- creates `idx_email_send_eligibility`

## Rollout Sequence

### 1. Wait For Historical Gmail Scan

Run:

```bash
/private/tmp/gmail-prod-job-status.sh 43
```

This condition is now satisfied:

- job `43` state is `completed` or `failed` and the result is understood
- no historical scan is active
- waiting daily jobs have been reviewed

### 2. Preflight

Run:

```bash
./scripts/preflight-production.sh
```

Confirm:

- `.env.production` present
- DB and Redis reachable
- PM2 API/worker status understood
- pending migrations are the expected validation migrations
- auth endpoint responds locally

### 3. Backup And Deploy

Use the production deploy script only after step 1 is clear:

```bash
./deploy-production.sh
```

The script:

- runs local tests/build
- uploads code
- installs production dependencies
- creates DB backup
- runs migrations
- reloads API
- leaves existing worker running if already present

### 4. Worker Activation

If the deploy script leaves the worker running on old code, restart it only after confirming job `43` is done:

```bash
npx pm2 restart inventorypal-email-worker --update-env
```

Do not restart the worker before job `43` completes.

### 5. Post-Deploy Checks

Verify API:

- `GET /api/emails/analytics/send-eligibility`
- `GET /api/emails?sendEligibility=safe_to_send`
- `GET /api/emails/campaign/preview`
- `GET /api/emails/campaign/export.csv`
- `GET /api/verification/intake-overview`

Verify UI:

- Dashboard shows send eligibility totals
- Emails list filters by send gate and reason
- Emails > Validation campaign export previews only selected eligibility
- NeverBounce batch builder remains separate from campaign exports

Verify data:

- `do_not_send` includes unsubscribed/invalid/disposable/bounced/ignored typo
- `review` includes risky/role/typo pending/unknown/low score
- `safe_to_send` is not inferred from `verificationStatus` alone

### 6. Backfill Work After Rollout

After deployment and worker restart:

1. inspect historical Gmail job results
2. inspect daily Gmail jobs that accumulated while historical scan was active
3. run full typo scan over emails and customers
4. review typo candidates
5. export resolved typo candidates for external validation
6. export commercial-domain validation batches
7. import provider results once implemented

## Rollback Notes

If API deployment fails before migrations:

- restore previous code using the existing deploy process
- do not run migrations

If migrations have run:

- prefer forward fix over rollback
- database backup created by `deploy-production.sh` is the emergency restore point
- do not drop validation tables or send eligibility fields unless explicitly restoring from backup
