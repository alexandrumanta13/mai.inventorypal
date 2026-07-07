# Validation Intake Gate

Last updated: 2026-07-03

Related research: [EMAIL_VALIDATION_BEST_PRACTICES.md](./EMAIL_VALIDATION_BEST_PRACTICES.md).
Implementation staging: [VALIDATION_PREP_PLAN.md](./VALIDATION_PREP_PLAN.md).

## Goal

Build one shared validation gate before any automatically discovered email becomes usable in MailPal.

This gate protects the customer list from:

- malformed emails
- test emails
- typo domains
- disposable domains
- unsubscribed contacts
- abusive/risky contacts
- bounced or unreachable inboxes
- commercial/provider segments that still need external verification

The immediate priority is to connect this gate to the automatic SuppliKit customer import. The same gate should later be used by Gmail order scans, WooCommerce imports, CSV/JSON imports, and manual recovery flows.

## Production Constraint

Historical Gmail scan job `43` is currently active in production.

Until it finishes:

- do not restart the worker
- do not deploy worker logic changes unless explicitly approved
- normal API/frontend work can continue if it does not interrupt the worker
- queue-level changes should be staged locally and deployed after the historical job completes

## Sources That Must Use The Gate

The shared intake gate should cover:

- SuppliKit live order import
- SuppliKit webhook-triggered import
- SuppliKit recoverable missing emails by phone
- Gmail order email extraction
- WooCommerce direct imports
- Shopify order imports, including secondary domain 9
- CSV and JSON imports
- manual email/customer creation, where applicable

SuppliKit is the first integration target because it can create customers automatically as new synced orders appear.

## Core Principle

Do not treat an imported email as safe to send just because it came from an order.

An order email can still be:

- a typo, such as `client@gamil.com`
- a fake/test address
- a previously bounced inbox
- a suppressed address
- a role-based or risky address

The import may preserve the observed data, but sending eligibility must come from the validation decision.

## Gate Stages

### 1. Normalize

- trim whitespace
- lowercase email
- remove invisible/control characters
- extract local part and domain
- preserve the original observed email for audit/debugging

### 2. Hard Reject

Block immediately when the email is clearly unusable:

- empty email
- missing `@`
- invalid shape
- known placeholders: `noemail@`, `no-email@`, `unknown@`
- obvious examples/tests: `test@example.com`, `client@example.com`, `example@example.com`
- already suppressed as `invalid`, `disposable`, or `unsubscribed`
- already marked as test/ignored by recovery tooling

Decision: `blocked`

### 3. Local Quality Scan

Run cheap deterministic checks before any external verification:

- syntax validation
- known disposable domain detection
- role-based mailbox detection
- known commercial domain grouping
- typo domain suggestion with `mailcheck`
- no customer-name/local-part typo inference during SuppliKit intake; local-part recovery needs bounce evidence
- bounce/suppression lookup
- existing customer/email lookup
- source provenance lookup, where available

Suggested decisions:

- `accepted_pending_validation`
- `needs_typo_review`
- `needs_bounce_review`
- `needs_manual_review`
- `blocked`

### 4. Typo Handling

Typo emails are not the same as invalid emails.

Rules:

- preserve the original typo email
- save `hasTypo = true`
- save `typoSuggestion`
- keep the email out of safe sending flows
- do not auto-correct without review
- allow bulk or individual approval
- after approval, validate the corrected email before it becomes sendable

Useful examples:

```text
client@gamil.com -> client@gmail.com
client@gmai.com -> client@gmail.com
client@yahoo.con -> client@yahoo.com
```

Customer typo handling:

- do not rewrite `customers.email` automatically
- create a common-domain typo review candidate linked to the customer where safe
- reserve customer-name/local-part typo candidates for mail-daemon/bounce recovery
- after human approval and validation, update or merge the corrected email/customer record

### 5. Bounce Handling

Historical Gmail scan should identify bounced recipients and preserve them separately.

Name/local-part typo recovery belongs here, because the mail daemon gives us evidence that the observed address failed delivery. Example:

```text
Catalina Dumitru + catalina.dmitru@gmail.com + mailbox-not-found bounce
=> candidate suggestion: catalina.dumitru@gmail.com
```

Without a bounce, SuppliKit order intake should not infer that a local-part is wrong.

Signals to parse:

- `Final-Recipient`
- `Original-Recipient`
- `X-Failed-Recipients`
- `Diagnostic-Code`
- common permanent failure phrases

Rules:

- mark matching `emails` as invalid/bounced
- link the bounce to the customer when possible
- expose a bounce recovery list for typo-like local-part or domain mistakes
- keep bounced addresses out of sendable segments

### 6. Verification Queue

Accepted emails should be queued for validation instead of being marked fully safe immediately.

Internal validation should cover:

- syntax
- MX/DNS
- local suppression rules
- typo state
- disposable/role-based flags
- bounce state

External validation can be added with ZeroBounce, NeverBounce, or another provider.

External validation should be used mainly for:

- commercial email domains selected by domain filter
- resolved typo candidates after local approval
- large existing-list cleanup batches

Provider batches should be tracked by the app so the operator does not need to remember where a batch stopped.

## SuppliKit Integration

The SuppliKit auto-add flow should call the shared gate before creating or linking customers.

Required behavior:

1. SuppliKit import receives customer/order email.
2. Validation gate evaluates the email.
3. If `blocked`, record skip reason and do not create a sendable contact.
4. If `needs_typo_review`, save typo candidate and do not create/link as sendable.
5. If `needs_manual_review`, save review item with source context.
6. If `accepted_pending_validation`, create/link customer, create/update email as pending/risky as needed, and enqueue validation.
7. Only after validation passes can the email enter safe sending flows.

The webhook must remain non-blocking:

- SuppliKit still sends a fire-and-forget signal
- MailPal still returns `202 Accepted`
- background import performs the gate checks
- failed/reviewed/blocked counts are stored on the import job

## Validation UI

The validation area should be separate from the Typo tab. Typo recovery is one input into validation, not the whole validation product.

Recommended sections:

- Overview
  - pending validation
  - validated safe
  - blocked
  - typo review
  - bounce review
  - external provider batches
- Intake Queue
  - source
  - email
  - decision
  - reason
  - customer/source context
- Typo Review
  - search
  - pagination
  - individual approve/reject
  - bulk approve selected suggestions
- Bounce Recovery
  - bounced recipient
  - matched customer/email
  - suspected correction
  - approve/reject
- Internal Validation Jobs
  - queued/running/completed/failed
  - retry failed
- External Provider Validation
  - create tracked batch from filters
  - export CSV or send through API
  - import results
  - map results back to email status

## External Provider Flow

Preferred operational flow:

1. Select source segment:
   - resolved typo candidates
   - commercial domain filter
   - a tracked email domain batch
2. App creates a tracked validation batch.
3. Batch exports/sends up to a configured row count.
4. App marks those emails as included in a specific batch.
5. Operator uploads/scans in the provider, or API integration handles it.
6. Result import maps:
   - `valid` -> validated/safe, if not otherwise suppressed
   - `invalid` -> invalid/do not send
   - `catchall` -> risky/review, not safe by default
   - `unknown` -> pending/risky, not safe by default
7. Future batches exclude emails already scanned in previous batches unless the operator explicitly resets/requeues them.

## Data Model Direction

Prefer an append-only validation/review trail instead of overwriting evidence.

Useful concepts:

- validation decision
- validation source
- original observed email
- suggested corrected email
- source system: SuppliKit/Gmail/Woo/CSV/JSON/manual
- source domain id/platform when available
- source order/message id when available
- review status
- external validation provider
- external batch id
- last validated at
- final send eligibility

Existing fields such as `hasTypo`, `typoSuggestion`, `verificationStatus`, and suppression states should be reused where possible. Add a separate table only where audit history or batch tracking cannot fit cleanly.

## Deployment Sequence

After Gmail historical job `43` finishes:

1. Audit the historical scan results.
2. Decide what to do with queued daily jobs `44` and `45`.
3. Deploy the daily cron guard and prepared typo-domain UI/API changes.
4. Run full typo scan over existing `emails` and `customers`.
5. Build the shared validation gate service.
6. Connect SuppliKit automatic import to the gate.
7. Build the validation UI sections.
8. Add tracked external validation CSV/API batches.
9. Import provider results and map them back to send eligibility.

## Open Decisions

- Should `accepted_pending_validation` create the customer immediately, or hold customer creation until validation passes?
- Which statuses should be considered "commercial domains" for first external validation cleanup?
- Should role-based addresses be blocked or only marked risky?
- Should catch-all / accept-all provider results be excluded from campaigns by default?
- What retention period do we want for rejected/test/review evidence?
