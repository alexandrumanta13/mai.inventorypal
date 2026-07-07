# Validation Prep Plan

Last updated: 2026-07-06

## Current Production Guardrail

Historical Gmail job `43` has finished. Validation deployment can move to preflight and rollout checks.

Latest checked state:

- job `43`: completed
- progress: `349919`
- result: `349919` scanned, `114666` detected, `114389` updated, `275` created, `20537` errors
- finished at UTC: `2026-07-05T16:37:11.828Z`
- last production check: `2026-07-06T13:19:26.734Z`
- Gmail queue: 0 active, 0 waiting, 9 completed, 2 failed
- daily jobs `44` through `48`: completed after the historical job
- Redis policy fixed on 2026-07-06: `noeviction`, `evicted_keys=0`

Production rollout on 2026-07-06:

- production preflight passed before deploy
- production deploy completed after updating deploy scripts to allow the installed SSH key instead of forcing password-only auth
- database backup created before migrations: `database-backups/inventorypal_email_pre_migration_20260706_140036.sql.gz`
- validation migrations applied:
  - `CreateEmailValidationTables1777650500000`
  - `AddEmailSendEligibilityFields1777650600000`
- API restarted and responded correctly to auth checks
- Gmail worker restarted after deploy with the new cron guard and safe re-scan logic
- Gmail queue after deploy: 0 active, 0 waiting, 0 delayed
- cleanup applied to 3 `quality_gate_test` rows: all are now `invalid`, `do_not_send`, and no longer appear in typo review
- Redis eviction policy changed from `allkeys-lfu` to `noeviction`; `CONFIG REWRITE` succeeded and BullMQ warning disappeared
- stale production import job `209` was identified as an orphaned `inventorypal` job from 2026-07-01 and marked `failed`; no `pending` or `running` import jobs remain
- local backend now reconciles stale `pending/running` import jobs older than 120 minutes before listing/importing, so dashboard jobs should not stay `running` forever after an API restart
- local SuppliKit sync now has a persistent `sync_states` watermark with overlap-based catch-up; cron/webhook imports expand their days-back window when the last successful sync is older than the configured minimum

Follow-up check on 2026-07-06:

- production cron code still queues `daily-smart-scan` without checking whether `gmail-scan` is busy
- this allowed daily jobs `44` through `47` to wait behind historical job `43`
- local code now has a cron guard that skips the daily scan when active/waiting/delayed Gmail jobs exist
- local tests cover the cron guard
- historical errors were mostly parser misses: `Smart scan detected order but could not parse customer`
- concrete technical scan errors found in logs: `Data too long for column 'city' at row 1`
- local Gmail email metadata writes now trim/truncate strings before saving to `emails`
- local tests cover long `city` / `phone` / `country` Gmail metadata
- local Gmail scan now preserves manual `quality_gate_test` decisions and will not promote them back to valid or typo review
- local Gmail scan is now safer for repeated daily windows:
  - order scans do not promote existing invalid/disposable/unsubscribed/typo/manual-test rows to valid
  - bounce scans do not overwrite unsubscribe/manual-test rows
  - abuse scans do not overwrite protected rows
  - protected rows can still keep harmless customer linkage/order metadata where appropriate, without changing send eligibility

Rollout checklist status:

- production preflight: done
- expected validation migrations: applied
- deploy with database backup: done
- worker restart after API deploy/migrations: done
- post-deploy queue check: done

## What We Have

### Local Validation Building Blocks

- `SyntaxValidator`
  - practical syntax validation
  - catches missing `@`, invalid local/domain shape, length issues
- `DnsValidator`
  - DNS/MX validation layer
- `SmtpValidator`
  - SMTP check support
  - should remain async and rate-limited
- `FilterValidator`
  - disposable domain detection
  - role-based detection
  - common domain typo detection
  - name/local-part typo suggestion utility exists, but must be used only by mail-daemon/bounce recovery where we have evidence that the address failed delivery
  - ambiguous local-parts remain untouched, e.g. `catalina_frmusika@gmail.com` is not corrected from `Catalina Dumitru`
- `EmailVerifierService`
  - combines syntax, DNS, SMTP and filters
  - stores verification fields and history
- `ValidationIntakeGateService`
  - local shared gate introduced for SuppliKit auto-add
  - evaluates incoming emails before customer creation/linking
  - stores typo candidates instead of letting them become sendable
  - queues accepted emails for validation

### Local UI Building Blocks

- dedicated `/verification` page exists locally
- shows validation/intake overview
- shows verification queue status
- shows typo scan status
- shows commercial domain CSV candidates

### Current Import Protection

SuppliKit import is now prepared locally to:

- run the intake gate before customer upsert
- block invalid/test/suppressed candidates
- route common-domain typo candidates to review
- avoid customer-name/local-part typo decisions during SuppliKit intake; those belong to mail-daemon/bounce recovery
- keep accepted emails pending validation
- queue accepted emails for verification

Recoverable missing-email flow is also prepared to avoid dry-run side effects.

### Existing Typo Tooling

- typo candidate fields exist on `emails`
- typo scanner exists for `emails`
- typo scanner exists for `customers`
- generic typo scans flag common-provider domain typos only
- clear name/local-part typo suggestions are reserved for bounce recovery after a mail-daemon failure
- full typo scan queue exists
- typo resolver UI exists in Emails
- customer domain cards can flag suspected typo domains locally

### Existing External Batch Shape

There is already a CSV/export concept for external validation batches.

Current implementation is named around NeverBounce, but this should be renamed/generalized before we treat it as the main validation product.

## What Is Missing

### Data Model

We still need durable validation tracking:

- `email_validation_batches`
- `email_validation_events`
- provider name
- provider job id
- source segment
- original email
- normalized email
- corrected email, where relevant
- provider status
- provider sub-status
- raw provider response
- validated at
- imported at

### Send Eligibility

We now have a local explicit send decision separate from `verificationStatus`.

Implemented locally:

- `send_eligibility`
- `do_not_send_reason`
- `last_validation_source`
- `last_validation_at`
- `SendEligibilityService`
- migration `1777650600000-AddEmailSendEligibilityFields`

Rule: campaign sending must not infer safety only from `verificationStatus`.

### Provider Abstraction

Build one internal interface:

```text
validateSingle(email)
createBatch(rows)
getBatchStatus(batchId)
getBatchResults(batchId)
mapProviderResult(raw)
```

ZeroBounce should be the first serious provider candidate because it has richer quality states:

- `spamtrap`
- `abuse`
- `do_not_mail`
- `possible_typo`
- `role_based`
- `disposable`
- `mailbox_not_found`
- `global_suppression`
- `toxic`
- `accept_all`

NeverBounce remains useful as a fallback because it has a simpler batch flow and known CSV/result model.

### Validation UI

The current `/verification` page is a start, not the final operator workflow.

Needed sections:

- Intake queue
- Typo resolver entry point
- Bounce recovery
- Validation batches
- External provider jobs
- Provider result import
- Send eligibility summary
- Search and pagination everywhere review lists can grow

### SuppliKit Job Reporting

Import jobs should store and show:

- accepted pending validation
- blocked invalid/test/suppressed
- typo review
- manual review
- validation queued
- validation queue failures

### Gmail Bounce Recovery

Historical Gmail scan should be used to extract bounced recipients:

- parse failed recipient from bounce body/headers
- mark matching emails invalid/bounced
- link to customers where possible
- create separate recovery candidates for typo-like bounces
- use customer first/last name versus failed local-part only in this bounce/mail-daemon context, not during SuppliKit order intake

Status:

- smart scan already detects bounce-like messages and marks sender/from-address flows as invalid/bounce
- dedicated bounce-recipient extraction is implemented locally
- local parser reads `X-Failed-Recipients`, `Final-Recipient`, `Original-Recipient`, delivery-status body lines, and common human-readable Gmail bounce text
- smart and legacy Gmail scans now mark the failed recipient when available, with fallback to the previous sender/from-address behavior
- local bounce recovery candidate model exists: `bounce_recovery_candidates`
- local bounce recovery service creates candidates only when there is a clear domain typo or clear name/local-part suggestion with bounce evidence
- local endpoints exist:
  - `GET /api/verification/bounce-recovery/summary`
  - `GET /api/verification/bounce-recovery`
  - `POST /api/verification/bounce-recovery/backfill`
- after deployment, run a bounce-focused historical scan/backfill to build the bounce recovery list

### Existing List Backfill

After historical job `43` finishes:

- run typo scan over `emails`
- run typo scan over `customers`
- review/resolve typo candidates
- validate resolved typos
- validate commercial domain batches through provider
- import provider results
- update send eligibility

## Where We Start

### Step 1: Stabilize The Local Gate

Before adding provider API:

- add structured reason codes to `ValidationIntakeGateService` - done locally
- add tests for accepted/blocked/typo/role/disposable cases - done locally
- ensure SuppliKit auto-add never creates sendable typo/test/suppressed contacts
- keep role-based as `needs_manual_review` or risky, not invalid by default

Implemented local reason codes:

- `accepted`
- `empty`
- `invalid_shape`
- `invalid_syntax`
- `test_or_placeholder`
- `existing_suppressed`
- `common_domain_typo`
- `disposable`
- `role_based`

Current local validation:

- normal customer email -> `accepted_pending_validation`
- empty/malformed email -> `blocked`
- obvious test/placeholder -> `blocked`
- existing invalid/disposable/unsubscribed -> `blocked`
- common provider typo -> `needs_typo_review`
- disposable domain -> `blocked`
- role-based email -> `needs_manual_review`
- validation queue skips suppressed/typo rows

### Step 2: Add Validation Tables

Add migrations and entities for:

- validation batches - done locally
- validation events - done locally

This lets us track external scans without relying on memory, CSV filenames or manual notes.

Implemented locally:

- `EmailValidationBatch`
- `EmailValidationEvent`
- migration `1777650500000-CreateEmailValidationTables`

`email_validation_batches` tracks:

- provider: `internal`, `zerobounce`, `neverbounce`, `manual`, `unknown`
- status: `draft`, `queued`, `submitted`, `running`, `completed`, `failed`, `cancelled`
- source segment: `supplikit_intake`, `existing_domain`, `typo_resolved`, `bounce_recovery`, `manual`, `csv_import`, `unknown`
- provider job id
- source domain/filter
- totals and result counters
- provider/job metadata and errors

`email_validation_events` tracks:

- batch id
- email id
- provider
- input email
- normalized email
- corrected email
- provider status/sub-status
- mapped internal status
- send eligibility
- reason code
- confidence score
- raw provider response
- validation timestamp

### Step 3: Add Send Eligibility

Add a computed or stored eligibility layer - done locally.

Initial strict rule:

- valid local syntax
- not unsubscribed
- not invalid
- not disposable
- not risky/abuse
- not typo pending
- not bounced
- external `valid`, when an external provider result exists

Treat `unknown`, `catch-all`, `accept_all`, `role_based`, and `possible_trap` as not safe by default.

Implemented local decisions:

- `do_not_send`: unsubscribed, invalid, bounced, disposable, ignored typo
- `review`: abuse/risky, role-based, typo pending, typo accepted before external validation, unknown provider result, low score
- `safe_to_send`: valid result with acceptable local quality score
- `pending`: no decisive validation result yet

Current integration points:

- SuppliKit/Gmail-created email rows receive a send eligibility decision.
- SuppliKit high-confidence missing-email recovery creates recovered rows as `pending`, then queues validation.
- Gmail smart-scan updates refresh send eligibility when rows are marked valid, invalid, unsubscribed, risky or typo review.
- Internal verifier updates send eligibility when verification results are saved.
- Campaign CSV exports default to `safe_to_send`; `review` and `pending` require explicit operator selection.
- NeverBounce CSV exports remain separate validation-provider batches and are not treated as campaign-safe exports.
- Existing production rows will be backfilled by migration when deployed.

### Step 4: Generalize External Validation Naming

Rename the NeverBounce-specific UI/API concepts to neutral names:

- External validation
- Provider batch
- Provider result import

Then plug ZeroBounce as first provider candidate.

### Step 5: ZeroBounce Adapter

Implement only after local model is ready:

- config keys
- single validation
- batch/file flow or batch API flow
- result mapping
- raw response storage
- retry/rate handling

### Step 5A: Elastic Email Transactional Signals

SuppliKit already sends transactional/admin emails through Elastic Email. Those delivery events are a stronger validation signal than parsing Gmail mail-daemon messages alone.

Current local implementation:

- provider `elastic_email` exists in validation enums and migrations
- webhook endpoint: `POST /api/verification/elastic-email/webhook?secret=...`
- webhook verification endpoint: `GET /api/verification/elastic-email/webhook?secret=...`
- authenticated manual ingest endpoint: `POST /api/verification/elastic-email/ingest`
- authenticated Elastic Email v4 event pull endpoint: `POST /api/verification/elastic-email/pull`
- Elastic Email v4 accepts one `eventTypes` value per request; the app normalizes `Error,Bounce,Abuse,Unsubscribe` to separate pulls for `Bounce`, `Complaint`, and `Unsubscribe`
- events are stored in `email_validation_events`
- matched rows in `emails` can be updated automatically
- unknown negative recipients create suppression rows in `emails` with `sendEligibility = do_not_send`
- unknown positive/neutral recipients remain audit-only and do not create contacts

Policy:

- Elastic bounce/delivery failure wins over unsubscribe for deliverability.
- Elastic hard bounce suppresses the original bounced address only; the customer is still recoverable through a separate bounce recovery candidate when a strong domain typo or name/local-part typo suggestion exists.
- Existing `unsubscribed -> bounce` becomes `do_not_send` with reason `bounce_after_unsubscribe`.
- Elastic bounce for a new address creates a do-not-send suppression row with reason `elastic_bounce`.
- Elastic bounce with recoverable typo creates a pending bounce recovery candidate with source `elastic_email_bounce`; the suggested email must still pass review/external validation before it can become sendable.
- Elastic unsubscribe becomes `do_not_send` with reason `unsubscribed`.
- Elastic abuse/complaint becomes `do_not_send` with reason `elastic_abuse_complaint`.
- Elastic delivered/sent can promote only unprotected rows; it must not overwrite unsubscribe, invalid, disposable, manual do-not-send, or pending typo rows.
- Gmail mail-daemon parsing remains useful for historical and non-Elastic messages, but Elastic events should be preferred when both exist.

Operational rollout:

1. configure `ELASTIC_EMAIL_API_KEY` and `ELASTIC_EMAIL_WEBHOOK_SECRET`
2. run `/api/verification/elastic-email/pull` with `dryRun: true`
3. compare matched/missing rows and reason counts
4. apply negative events first; first production run on 2026-07-07 processed 116 Elastic bounces/complaints/unsubscribes across 107 distinct existing emails and marked them invalid/do-not-send, with no new suppression rows
   - follow-up bounce recovery backfill scanned 2,647 existing bounce rows and saved 24 recovery candidates: 12 domain typos and 12 name/local-part typos
5. configure Elastic Email webhook to call the webhook endpoint with the shared secret
   - configured on 2026-07-07 as webhook `a85cf6b8-672b-40be-a40c-e05efb1842cf`
   - enabled flags: `NotificationForError`, `NotificationForUnsubscribed`, `NotificationForAbuseReport`
   - disabled flags: `NotificationForSent`, `NotificationForOpened`, `NotificationForClicked`
6. expose Elastic Email stats in the Verification dashboard

### Step 6: Production Rollout

Only after Gmail historical job `43` finishes:

1. inspect job `43` result
2. decide what to do with waiting daily jobs
3. deploy already prepared safe frontend/API changes
4. avoid worker restart unless worker changes are explicitly needed
5. run typo/customer backfills in controlled jobs
6. enable validation gate behavior progressively
