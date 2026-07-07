# Gmail Smart Scan and Historical Backfill

Last updated: 2026-07-06

## Context

The Gmail smart scan is used to recover and protect the email/customer list by reading historical Gmail messages and detecting:

- customer order emails, used to create or update customers
- unsubscribe requests, used to mark contacts as unsubscribed
- abusive/offensive replies, used to mark contacts as risky
- bounces/delivery failures, used to mark contacts as invalid

The project was paused for a while, so the historical scan needs to cover significantly more than the recent daily cron window.

This work should be treated together with the existing **Email recovery & quality gate** from the SuppliKit import page. Both features feed the same core business workflow: automatically discovering customer emails, deciding whether they are safe enough to enter the CRM/email list, and protecting sending lists from test, typo, invalid, disposable, unsubscribed, or abusive contacts.

## Current Production Findings

Exact Gmail API pagination counts, checked on 2026-07-01:

- full mailbox scope, including spam/trash: `351,173` messages
- scanner scope, excluding spam/trash: `349,825` messages
- email rows already marked with `lastGmailScanDate`: about `68,760`

Important: `68,760` is not the Gmail mailbox size. It is only the number of application email rows that have already been touched by Gmail scan logic.

Recent production scan facts:

- daily cron exists and queues `daily-smart-scan`
- cron schedule: `0 2 * * *`, timezone `Europe/Bucharest`
- latest completed daily job before the manual run: job `40`
- job `40` result:
  - scanned: `3068`
  - detected: `1163`
  - updated: `745`
  - created: `417`
  - errors: `2`
- job `41` was started manually as a 7-day control rescan after import fixes
- job `41` completed on 2026-07-01
  - scanned: `2,654`
  - detected: `1,035`
  - updated: `1,032`
  - created: `3`
  - errors: `1`

Production status after validation deploy on 2026-07-06:

- historical job `43` is completed: `349,919` scanned, `114,666` detected, `114,389` updated, `275` created, `20,537` errors
- daily jobs `44` through `48` completed after the historical scan
- deployed Gmail logic now skips the daily cron when another Gmail scan job is active, waiting, or delayed
- deployed Gmail logic preserves protected email states during repeated daily scans:
  - invalid
  - disposable
  - unsubscribed
  - risky/manual-test/quality-gate protected rows
  - typo review rows
- Gmail queue check after deploy: 0 active, 0 waiting, 0 delayed
- Redis policy fixed after deploy: `noeviction`, `evicted_keys=0`, BullMQ warning cleared

## Scan Scope

Default scan query:

```text
in:anywhere -in:trash -in:spam
```

This intentionally excludes spam and trash. Historical backfill should use explicit date windows:

```text
in:anywhere -in:trash -in:spam after:YYYY/MM/DD before:YYYY/MM/DD
```

Examples:

```text
in:anywhere -in:trash -in:spam after:2026/06/01 before:2026/07/01
in:anywhere -in:trash -in:spam after:2026/05/01 before:2026/06/01
```

## What We Scan For

### Orders

Order emails are used to create or update customers. The scanner currently parses WooCommerce-like order emails from billing blocks.

Expected behavior:

- extract customer email
- extract name, phone, address, city, state, postcode, country where available
- create or update the customer record
- create or update the email record as `valid`
- preserve existing `unsubscribed` and `risky` status if a later order arrives from the same email

Needed improvement:

- extend parsing/detection for Shopify order emails, especially secondary domain 9
- keep source/domain tracking where it can be inferred from sender, subject, or body

### Unsubscribe

Unsubscribe replies must be marked as `unsubscribed`.

Signals include:

- `unsubscribe`
- `dezabonare`
- `nu mai trimite`
- `remove me`
- `do not send`
- related Romanian/English opt-out language

Important distinction:

- order cancellation is not unsubscribe
- return/refund/customer support is not unsubscribe

### Abuse / Risky

Offensive, threatening, or abusive customer replies must be marked as `risky`.

The smart scan uses a hybrid approach:

- pattern matching for clear abuse words
- LLM classification for replies or ambiguous customer messages

Important fix prepared locally:

- if the LLM returns `uncertain`, it should not erase a clear pattern-based unsubscribe/abuse classification

### Bounce / Invalid

Delivery failures, mailer-daemon replies, and permanent mailbox errors are marked as invalid/bounce.

Local improvement prepared on 2026-07-06:

- bounce handling now extracts the failed recipient from `X-Failed-Recipients`, `Final-Recipient`, `Original-Recipient`, delivery-status body lines, and common Gmail bounce text
- if a failed recipient is found, the scan marks that email as invalid/bounce instead of the mailer-daemon sender
- if no failed recipient is found, the scan keeps the previous fallback behavior
- after deployment, run a bounce-focused historical backfill to separate genuinely invalid inboxes from recoverable typo candidates

## What We Ignore

The scanner should skip:

- spam
- trash
- Gmail promotions/social labels
- newsletters received by us
- commercial/marketing emails received by us
- clean emails without useful signals

Marketing/newsletter signals include:

- `List-Unsubscribe`
- `List-Id`
- `Precedence: bulk/list`
- `newsletter@`
- `marketing@`
- `promo@`
- `offers@`
- `deals@`
- common marketing sender patterns

Replies are treated differently: if a message is a reply, it should not be skipped just because it contains newsletter-like headers, because real unsubscribe or abuse responses can happen as replies to campaigns/order emails.

## Current Strengths

- The smart scan does not fetch full bodies for every message.
- It first reads metadata/snippets and only fetches full body for candidates.
- Orders, bounces, unsubscribe, and abuse are handled in one smart pass.
- Existing `unsubscribed` and `risky` statuses are protected from being overwritten by later order emails.
- Customer import now has field-length protection, preventing bad postcode/address data from crashing writes.
- Gmail scan stats now count non-null scan dates correctly.

## Email Recovery & Quality Gate

The current Email recovery & quality gate is focused on SuppliKit orders where the order has no email address, but the phone number can be matched to another order that does have an email.

Current behavior:

- scans missing-email orders from SuppliKit
- matches by normalized phone
- proposes a candidate email from previous orders with the same phone
- marks one-candidate matches as `high`
- marks multi-candidate phone matches as `review`
- skips already recovered rows
- skips invalid/test/suppressed email candidates via `EmailsService.isImportCandidateAccepted`
- supports manual `Recover`
- supports `Mark test`, which creates/updates the email as invalid and suppresses future imports
- automatically applies high-confidence recovery after InventoryPal/SuppliKit import, unless disabled

Current UI queues:

- `Review`: ambiguous matches that need human review
- `Auto`: high-confidence or already recovered rows
- `Ignored`: rows marked as test/ignored or otherwise suppressed
- `All`: full loaded audit window

Current protection:

- rejects empty/malformed shapes such as missing `@`
- rejects `noemail@`, `no-email@`, `no_email@`, `unknown@`
- rejects `test@example.com`, `client@example.com`, `example@example.com`
- rejects `test...@example.*`
- rejects candidates already marked as:
  - `invalid`
  - `disposable`
  - `unsubscribed`
- manual `Mark test` blocks the address from future imports and sending lists

Current gap:

- the recovery gate checks basic shape and suppression state, but it does not run full verification before creating/linking the recovered customer/email
- typo suggestions are not surfaced in this recovery table yet
- `hasTypo` is present in the email entity but should be set consistently with `typoSuggestion`
- recovered high-confidence emails are operationally trusted too early unless the verification queue runs afterward

## Typo Recovery Queue

Typo emails are not the same as invalid emails. They must be saved separately because many of them can become usable after correction and verification.

Examples:

```text
client@gamil.com -> client@gmail.com
client@yahoo.con -> client@yahoo.com
```

Rules:

- always preserve the original observed email as evidence
- store the suggested correction in `typoSuggestion`
- set `hasTypo = true`
- keep the email out of `safe to send`
- do not auto-correct without review or verification
- keep source context where available: Gmail message, SuppliKit order, domain id, phone, customer name, and acquisition source

Current local implementation:

- the verification service now sets `hasTypo` whenever `typoSuggestion` exists
- typo candidates are downgraded to `risky` and receive a quality-score penalty
- Gmail order auto-import now stores typo order emails as review candidates instead of marking them `valid` with score `100`
- SuppliKit direct import stores typo order emails before customer creation and skips the normal import path
- SuppliKit recoverable missing-email recovery stores typo candidates before customer creation/linking and skips the normal recovery path
- WooCommerce, CSV, and JSON imports now use the same typo candidate storage before normal import
- deliverability analytics explicitly exclude `hasTypo = true` from `safe to send`
- existing-list typo audit endpoint is available at `POST /api/verification/typo-audit`
  - default mode is `dryRun`
  - supports batch scanning with `limit` and `afterId`
  - updates existing rows with `hasTypo` and `typoSuggestion` when run with `dryRun: false`
- customer email typo audit endpoint is available at `POST /api/verification/customer-typo-audit`
  - does not update `customers.email`
  - saves detected typo candidates into the same `emails.hasTypo` recovery queue
  - links the candidate to `customerId` where safe
- the Emails page has a `Typo recovery` tab
  - shows saved typo candidates from `hasTypo = true`
  - can run typo audit dry-runs for `emails` or `customers`
  - can apply the next typo audit batch for the selected scope
  - advances the `afterId` cursor after each batch

Needed next implementation:

- run the historical typo backfill over production in controlled batches
- add actions:
  - accept suggested correction
  - reject as invalid/test
  - send suggested correction to external verification such as NeverBounce
  - merge corrected email back to the customer once verified

## Unified Customer Intake Gate

SuppliKit recovery and Gmail auto-add should be packaged as one shared intake pipeline.

### Sources

The shared gate should cover:

- SuppliKit direct customer import
- SuppliKit recoverable missing email by phone
- Gmail order-email customer extraction
- WooCommerce direct imports
- future Shopify order imports
- CSV/JSON/manual imports where applicable

### Gate Stages

Recommended shared pipeline:

1. Normalize
   - lowercase
   - trim
   - extract domain
   - normalize obvious whitespace/control characters

2. Hard reject
   - missing email
   - invalid shape
   - internal business domains where not expected
   - `noemail@`, `unknown@`
   - known test/example patterns
   - suppressed statuses: `invalid`, `disposable`, `unsubscribed`

3. Local quality scan
   - syntax validator
   - disposable-domain check
   - role-based check
   - typo suggestion check
   - test-pattern check

4. Decision
   - `accepted_pending_verification`: create/link customer, email remains pending/risky until verified
   - `needs_typo_review`: do not send; show correction suggestion
   - `needs_manual_review`: ambiguous phone match or risky role-based address
   - `blocked`: invalid/test/disposable/unsubscribed/suppressed

5. Verification queue
   - DNS/MX
   - SMTP where safe
   - external service such as NeverBounce if we choose to integrate one

6. Final sending status
   - valid and safe to send
   - risky/review
   - invalid/do not send
   - unsubscribed/do not send

### Important Rule

Do not automatically correct typo emails. For example:

```text
client@gamil.com -> client@gmail.com
```

The system should store the suggestion and route it to review/verification. Auto-correction can create false positives and attach orders to the wrong person.

## Current Risks / Gaps

### API and Worker Separation

The Gmail queue worker used to run inside the same PM2 process as the API application.

Legacy process:

```text
inventorypal-email
```

That process coupled API deploys with active Gmail scans.

Current local implementation separates:

```text
inventorypal-email-api
inventorypal-email-worker
```

Process roles:

- `INVENTORYPAL_PROCESS_ROLE=api`: serves HTTP and queues jobs, but does not run BullMQ processors or cron
- `INVENTORYPAL_PROCESS_ROLE=worker`: runs BullMQ processors and cron without opening HTTP
- `INVENTORYPAL_PROCESS_ROLE=all`: backwards-compatible local/default mode

Deployment rule:

- normal deploy reloads `inventorypal-email-api`
- `inventorypal-email-worker` is started if missing
- existing worker is left running unless explicitly restarted

Worker entrypoint:

```bash
npm run start:worker
```

### Historical Jobs Must Not Be Huge

The scanner scope is about `349,825` messages. A single full historical job is too risky because:

- it can run for a long time
- deploy/restart can interrupt it
- Redis/BullMQ can mark long jobs as stalled
- progress is harder to reason about

Historical scan must be split into explicit date windows.

### Redis Eviction Warning

Production logs repeatedly show:

```text
Eviction policy is allkeys-lfu. It should be "noeviction"
```

This matters because BullMQ recommends Redis `noeviction`. This should be fixed at the infrastructure level to reduce stalled-job risk.

### 2026-07-06 Historical Result Audit

Historical job `43` completed, but reported `20537` errors.

Log audit showed the errors were mostly parser misses:

```text
Smart scan detected order but could not parse customer
```

Meaning: the message looked like an order candidate, but the scanner could not extract a usable customer from the body.

Observed examples:

- old WooCommerce order subjects whose body did not match the parser shape
- commercial/billing emails incorrectly treated as order candidates, such as Google Ads billing and Canva invoice messages
- short `comanda #...` subjects without a usable billing block

Technical errors found:

```text
Data too long for column 'city' at row 1
```

Local fix prepared:

- Gmail metadata written to `emails` is trimmed/truncated before save/update
- tests cover long city/phone/country metadata

Daily job audit:

- production currently queues daily scans even when a long historical scan is active
- jobs `44` through `47` waited behind job `43` and then completed
- local cron guard now skips daily scans when the Gmail queue has active/waiting/delayed jobs
- tests cover the guard

Repeated daily windows:

- the daily scan intentionally checks a rolling 7-day window, so the same messages can be seen more than once
- this is acceptable only if database updates are idempotent and respect stronger existing decisions
- local protection now prevents order scans from promoting invalid/disposable/unsubscribed/typo/manual-test rows to valid
- local protection prevents bounce/abuse scans from overwriting protected rows
- tests cover invalid-not-promoted, manual-test-not-promoted, and unsubscribe-not-overwritten cases

### LLM Cost and Reliability

The LLM is useful for ambiguous replies, but large historical scans can call it many times. The scan should continue to avoid LLM calls for obvious clean/marketing messages and should preserve pattern fallback if the LLM is unavailable or uncertain.

### Intake Gate Is Not Centralized Yet

SuppliKit recovery uses `EmailsService.isImportCandidateAccepted`, while Gmail order import currently marks order emails as valid directly. This means different sources have different quality gates.

Required improvement:

- create one shared intake/quality service
- use it from SuppliKit recovery and Gmail order import
- create/link customers only after hard reject and local quality scan pass
- enqueue verification after intake
- do not mark Gmail order emails as fully `valid` before verification, unless they already passed a trusted verification path

## Prepared Local Changes

These changes are prepared locally and passed tests/build:

- support `afterDate` / `beforeDate` in smart scan
- pass date windows through queue jobs
- keep default scan query excluding spam/trash
- add tests for smart scan query generation
- preserve pattern-based unsubscribe/abuse when LLM returns `uncertain`
- separate API and worker process roles
- PM2 config with `inventorypal-email-api` and `inventorypal-email-worker`
- deployment scripts that reload API only and leave an existing worker running
- dashboard Gmail scan stats:
  - total scanned
  - last 24h scanned
  - orders
  - unsubscribes
  - abuse
  - bounces

Implemented locally from the intake/typo plan:

- typo review queue
- local typo gate for SuppliKit recovery and Gmail order import
- typo audit over existing emails
- typo audit over customers without changing `customers.email`

Prepared conceptually, not implemented yet:

- verification queue integration immediately after auto-add/recovery
- NeverBounce or similar external verification adapter

Validation performed locally:

```bash
npm test -- --runInBand
npm run build
```

Both passed.

## Backfill Plan

### Step 1: Confirm Job 41 Finished

Job `41` completed on 2026-07-01, so the next deploy can proceed with the worker/API separation.

Before deploy, still check:

- inspect result
- inspect errors
- verify created/updated counts
- verify unsubscribe/abuse/bounce totals

### Step 2: Deploy Windowed Scan Support

Deploy the prepared changes:

- date-window scan support
- dashboard Gmail stats
- LLM fallback fix

### Step 3: Separate API and Worker

Create separate PM2 processes:

```text
inventorypal-email-api
inventorypal-email-worker
```

Deployment rule:

- normal deploy restarts API only
- worker restart is explicit and only done when scan logic changes

Local implementation is ready. First production deploy with this change will remove the old
`inventorypal-email` monolith and create both new processes.

### Step 3.5: Centralize Intake Quality Gate

Before running large historical Gmail backfill, connect the shared gate to automatic customer creation:

- SuppliKit recoverable missing emails should continue to use high/review/test queues
- Gmail order imports should pass through the same local gate before creating a valid email
- typo candidates should be marked and held for review
- verification jobs should be queued for accepted pending emails
- only verified-safe emails should be treated as safe to send

### Step 4: Start Historical Backfill in Windows

Recommended order:

1. most recent full month
2. previous month
3. continue month-by-month backward
4. split into weekly windows if a month has too many messages

Example first windows:

```json
{
  "scanType": "smart",
  "afterDate": "2026-06-01",
  "beforeDate": "2026-07-01",
  "autoUpdate": true
}
```

```json
{
  "scanType": "smart",
  "afterDate": "2026-05-01",
  "beforeDate": "2026-06-01",
  "autoUpdate": true
}
```

### Step 5: Verify Each Window

For each backfill window, record:

- date window
- scanned
- ignored
- orders detected
- customers created
- customers updated
- unsubscribed
- risky/abuse
- bounce/invalid
- errors
- duration

Do not continue blindly if errors spike.

## Dashboard Requirements

The dashboard should show:

- Gmail connection status
- last cron/job time
- active job status
- current window being scanned
- scanned total
- scanned last 24h / 7d / 30d
- orders found
- customers created/updated from Gmail
- unsubscribers found
- risky/abuse contacts found
- bounce/invalid found
- failed/stalled jobs

For the unified customer intake gate, it should also show:

- accepted pending verification
- blocked test/ignored
- typo suggestions waiting review
- role-based/risky candidates
- disposable candidates
- verification queue waiting/active/failed
- recoveries applied automatically vs manually

This makes the daily cron and historical backfill auditable from the UI.

## Operational Rule

Before API/worker separation is deployed:

- do not deploy backend while a Gmail scan job is active
- frontend-only changes are safer, but still verify the deployment script does not restart PM2
- large historical scans should wait for worker isolation

After API/worker separation is deployed:

- API/UI development can continue while worker scans
- worker deploys should be planned around scan windows
