# Email Validation Operating Flow

Last updated: 2026-07-10

This is the current operational model for MailPal email validation.

## Goal

Keep every email traceable from source to final send decision.

The application must not treat an email as campaign-safe just because it came from an order, Gmail, Elastic Email, or an external provider. The campaign decision comes from `sendEligibility`.

## Final Send Buckets

- `safe_to_send`: usable for campaign exports.
- `review`: keep out of campaigns until a human or external provider resolves it.
- `do_not_send`: never include in marketing sends.
- `pending`: accepted but not validated yet.

`verificationStatus` describes evidence about the address. `sendEligibility` decides whether campaigns may use it.

## Source Layers

### SuppliKit Orders

SuppliKit is the main automatic intake path for new customers.

Flow:

1. Order email is normalized.
2. The intake gate rejects empty, malformed, placeholder, suppressed, disposable, or obvious test addresses.
3. Common provider domain typos are saved for typo review, not made sendable.
4. Accepted emails are stored as pending and queued for internal validation.
5. Customer-name/local-part typo guesses are not made here. They require bounce evidence.

### Gmail Daily Scan

Gmail is a signal layer for customer intent and delivery failures.

Current schedule:

- daily scan: last 36 hours
- weekly reconciliation: last 7 days
- historical all-time scan: completed

The daily cron skips itself when the Gmail queue is active, waiting, or delayed.

Gmail can mark:

- unsubscribe: `do_not_send`
- abuse/offensive: `review`
- hard bounce recipient: `do_not_send`
- bounce recovery candidate: `review`, when a domain or name/local-part typo is recoverable

Manual test/ignored rows and protected rows are not promoted back into sendable status.

### Internal Validation

Internal validation checks:

- syntax
- DNS/MX
- disposable domains
- role-based inboxes
- known provider typo domains
- SMTP only as a weak signal

Internal SMTP failure alone is no longer enough to make an email permanently invalid when syntax and DNS are valid. Those rows go to `review`.

### Elastic Email

Elastic Email is delivery evidence, not an absolute judge.

Hard recipient failures stay `do_not_send`:

- `elastic_hard_bounce_mailbox_not_found`
- `elastic_hard_bounce_account_disabled`
- `elastic_hard_bounce`

Non-final delivery failures go to `review`:

- `elastic_soft_bounce_mailbox_full`
- `elastic_soft_bounce_temporary`
- `elastic_delivery_auth_failure`
- `elastic_domain_dns_failure`
- `elastic_delivery_connection_failure`

Elastic events now store readable category/message evidence, not opaque message IDs as the main reason.

### Bounce Recovery

Bounce recovery is the only place where name/local-part typo suggestions are allowed.

Example:

```text
Catalina Dumitru + catalina.dmitru@gmail.com + mailbox-not-found bounce
=> catalina.dumitru@gmail.com as a recovery candidate
```

Approved recovery emails still need validation before campaign use.

### External Validation

ZeroBounce is the preferred API provider for small controlled batches.

CSV export/import remains useful for:

- recovered typo emails
- commercial/public mailbox domain batches
- manual external provider runs

Every external validation batch must preserve:

- submitted email
- source segment
- provider result
- mapped status
- send eligibility
- raw provider response summary

## Current Production State

Checked after the 2026-07-09/2026-07-10 validation rollout:

- API online
- worker online
- Gmail queue: no active or waiting jobs
- import jobs: no pending or running jobs
- Elastic legacy generic `invalid`: none remaining
- temporary production audit scripts: removed
- git commit: `43eab0a Harden email validation intake and bounce handling`

## UI Direction

The validation page should expose four operator areas:

- Gate: intake, queue, typo scan, suppression signals
- Recovery: bounce recovery candidates and manual correction
- External validation: ZeroBounce, CSV export, provider result import, external batch history
- Audit: status map and domain batches

Avoid mixing scanner controls, recovery decisions, external provider actions, and audit tables in one continuous page.
