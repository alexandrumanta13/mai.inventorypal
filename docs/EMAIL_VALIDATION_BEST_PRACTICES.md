# Email Validation Best Practices

Last updated: 2026-07-03

## Goal

Build a validation layer close to a commercial email verification product, while keeping MailPal in control of business decisions.

The validator should not answer only "is this an email?". It should answer:

- can we store it as observed evidence?
- can we create or link a customer from it?
- can we send campaigns to it?
- does it need typo/bounce/manual review?
- has it already been checked by an external provider?

## Sources Reviewed

- RFC 5321, SMTP mailbox, routing, MX handling and size limits: https://www.rfc-editor.org/rfc/rfc5321
- RFC 5322, address syntax and `addr-spec`: https://www.rfc-editor.org/rfc/rfc5322
- RFC 2505, anti-spam recommendations around SMTP `VRFY`/`EXPN`: https://www.rfc-editor.org/rfc/rfc2505
- NeverBounce single verification and point-of-entry guidance: https://developers.neverbounce.com/docs/verifying-an-email
- NeverBounce API result codes and flags: https://developers.neverbounce.com/reference/single-check
- NeverBounce bulk/list verification flow: https://developers.neverbounce.com/docs/verifying-a-list
- ZeroBounce v2 validation API/status model: https://www.zerobounce.net/docs/email-validation-api-quickstart/v2-validate-emails

## Important Findings

### Syntax Is Necessary But Weak

RFC-compatible email syntax is more permissive than what most business systems should accept.

Relevant RFC points:

- RFC 5322 defines `addr-spec` as `local-part@domain`.
- RFC 5321 allows a permissive local-part, including quoted strings.
- RFC 5321 says local-part can be case-sensitive, but case-sensitive mailboxes reduce interoperability and are discouraged.
- RFC 5321 limits local-part to 64 octets and domain to 255 octets.

MailPal should use a practical syntax profile:

- accept normal dot-atom local parts
- reject spaces/control characters
- reject quoted local-parts for import flows unless we explicitly choose to support them
- preserve original observed casing for audit if needed
- store a normalized lowercase version for dedupe and operational lookup

### DNS/MX Is Not Enough

MX lookup confirms that a domain is configured for email, not that a mailbox exists.

RFC 5321 also allows an implicit MX fallback: if no MX exists, the host itself can be treated as the mail target. In practice, for modern marketing list hygiene, missing MX should still be treated as high risk unless a later external verifier marks it valid.

Recommended MailPal policy:

- `has_mx = true`: pass DNS stage
- no MX but A/AAAA exists: `unknown` or risky, not safe-to-send
- NXDOMAIN: invalid
- temporary DNS error: retry, do not mark invalid immediately

### SMTP Mailbox Checks Are Fragile

SMTP-level validation can improve confidence, but it is not a clean truth source:

- many servers block or greylist probes
- catch-all domains accept any recipient
- slow servers can turn real inboxes into timeouts
- aggressive probing can hurt IP/domain reputation
- RFC 2505 recommends controlling or disabling `VRFY`/`EXPN` because they can be used for address harvesting

MailPal policy:

- do not rely on `VRFY`/`EXPN`
- if SMTP checks are used, rate-limit them heavily
- treat timeout/greylist as `unknown`, not invalid
- do not run large SMTP probes from the production API process
- prefer external providers for mailbox-level confidence on large lists

## Recommended Validation Stack

### Layer 1: Normalize And Preserve Evidence

For every incoming email:

- trim
- lowercase the operational email
- remove control/invisible characters
- parse local-part/domain
- store original observed email where useful
- attach source context: SuppliKit order id, Gmail message id, Woo domain, Shopify domain, CSV filename, etc.

Output:

- `normalizedEmail`
- `originalEmail`
- `source`
- `sourceIdentifier`
- `sourceDomainId`

### Layer 2: Practical Syntax

Use strict-but-operational syntax validation:

- one `@`
- valid local part
- valid domain shape
- local-part <= 64 octets
- domain <= 255 octets
- total path <= 256 octets where relevant
- no whitespace/control chars
- no quoted addresses in automated import

Reject:

- empty/malformed
- missing domain/TLD
- obvious placeholders
- examples/tests

### Layer 3: Business Suppression Gate

This layer must run before customer auto-add and before send eligibility.

Block or hold:

- `invalid`
- `disposable`
- `unsubscribed`
- known test/ignored emails
- abusive/risky contacts, depending on sending context
- hard bounces from Gmail scan

This is where MailPal is stronger than generic validators because it knows our own history.

### Layer 4: Local Quality Heuristics

Run fast local checks:

- disposable domain list
- role-based local parts: `info@`, `admin@`, `support@`, etc.
- common provider typo detection: `gamil.com`, `gmai.com`, `yahoo.con`
- squatter/lookalike domain detection where possible
- free-provider vs company-domain classification
- commercial domain grouping for NeverBounce batches

Policy:

- typo candidates go to typo resolver, not customer auto-add as sendable
- role-based emails are not invalid by default, but should be risky/manual review for campaigns
- disposable emails are blocked from sending and generally blocked from customer auto-add unless kept only as source evidence

### Layer 5: DNS Validation

Use DNS as a confidence layer:

- MX lookup
- A/AAAA fallback awareness
- temporary failure handling
- cache DNS results with TTL
- retry transient failures

Policy:

- NXDOMAIN or unusable mail target: invalid
- temporary DNS errors: unknown/retry
- no MX with A/AAAA fallback: risky/unknown

### Layer 6: SMTP Validation

Use sparingly and asynchronously:

- never in the request/response path for SuppliKit webhook
- run in worker queue
- low concurrency
- per-domain rate limits
- provider-specific timeouts
- cache results

Policy:

- positive SMTP response: strong signal, not absolute truth
- catch-all/accept-all: risky, not safe by default
- timeout/greylist: unknown
- permanent mailbox failure: invalid/bounced

### Layer 7: External Commercial Verification

Use external verification for the highest-confidence sending decisions.

NeverBounce:

- single endpoint supports `valid`, `invalid`, `disposable`, `catchall`, `unknown`
- flags include DNS, MX, bad syntax, free email host, role account, disposable, spelling mistake, accepts all, spamtrap network and others
- point-of-entry guidance allows `valid`, `catchall`, and `unknown` to proceed, while blocking only `invalid` and `disposable`
- list verification is asynchronous: create job, poll status, retrieve results

ZeroBounce:

- status model includes `valid`, `invalid`, `catch-all`, `unknown`, `spamtrap`, `abuse`, `do_not_mail`
- sub-status model is very useful for internal decisions: `possible_typo`, `role_based`, `disposable`, `mailbox_not_found`, `no_dns_entries`, `global_suppression`, `toxic`, `accept_all`, etc.
- has EU endpoint option
- unknown results do not consume credit according to their docs

Recommended provider strategy:

- implement a provider abstraction, not NeverBounce-specific business logic everywhere
- start with ZeroBounce as the first serious provider candidate because its status/sub-status model is richer for quality decisions
- keep NeverBounce as a fallback/simple-batch provider option
- store raw provider response for audit/debugging

## Recommended MailPal Decision Model

Use separate concepts:

- `intakeDecision`: can this source be stored/linked?
- `validationStatus`: technical/provider result
- `sendEligibility`: can campaigns use it?
- `reviewQueue`: does a human need to fix/approve it?

Suggested statuses:

- `accepted_pending_validation`
- `blocked_invalid_shape`
- `blocked_test`
- `blocked_disposable`
- `blocked_suppressed`
- `needs_typo_review`
- `needs_bounce_review`
- `needs_manual_review`
- `validated_safe`
- `validated_risky`
- `validated_invalid`
- `external_unknown`
- `external_catchall`

Campaign-safe should require:

- not unsubscribed
- not invalid
- not disposable
- not abuse/risky
- not typo pending
- not bounce pending
- local syntax valid
- DNS valid
- external result `valid` or an explicitly allowed trusted state

For quality-first sending, `catchall` and `unknown` should not be automatically campaign-safe. They can remain stored and linked to customers, but should require a deliberate segment rule before sending.

## How This Maps To Existing Code

Current local dependencies already cover useful pieces:

- `email-validator`: syntax profile
- `disposable-email-domains`: disposable list
- `mailcheck`: common typo suggestions
- `deep-email-validator`: can be evaluated as an additional bundled syntax/DNS/SMTP helper, but should not replace our decision model

Current local services already cover part of the stack:

- `SyntaxValidator`
- `DnsValidator`
- `SmtpValidator`
- `FilterValidator`
- `EmailVerifierService`
- `ValidationIntakeGateService`
- `SendEligibilityService`

What is missing for commercial-grade behavior:

- provider abstraction for NeverBounce/ZeroBounce-like results
- per-domain validation cache
- per-domain SMTP rate limits if we keep SMTP checks
- bounce parser that extracts failed recipient and links it to customer/email
- UI that separates validation from typo resolution and external-provider operations

Already prepared locally:

- tracked external validation batches
- raw external response storage on validation events
- explicit `sendEligibility`
- `doNotSendReason`
- `lastValidationSource`
- `lastValidationAt`

## Recommended Implementation Roadmap

### Step 1: Harden Local Gate

- keep SuppliKit auto-add behind `ValidationIntakeGateService`
- add reason codes instead of only free-text reasons - done locally
- keep typo/test/suppressed decisions out of customer auto-add
- enqueue accepted emails for internal validation

### Step 2: Add Validation Result Model

Add a small audit/batch model:

- `email_validation_events` - done locally
- `email_validation_batches` - done locally
- provider
- provider job id
- source segment
- input email
- result status
- result sub-status
- raw response
- validated at

### Step 3: Add Send Eligibility

Add an explicit computed or stored field - done locally:

- `sendEligibility`
- `do_not_send_reason`
- `last_validation_source`
- `last_validation_at`

Never let UI infer sendability only from `verificationStatus`.

Current local policy:

- unsubscribed, invalid, bounced, disposable and ignored typo rows are `do_not_send`
- abuse/risky, role-based, typo pending, accepted typo awaiting external validation, unknown provider result and low score rows are `review`
- valid rows with acceptable quality are `safe_to_send`
- unverified rows remain `pending`

### Step 4: External Provider Adapter

Build provider interface:

```text
validateSingle(email)
createBatch(rows)
getBatchStatus(batchId)
getBatchResults(batchId)
mapProviderResult(raw)
```

Start with ZeroBounce as the first provider candidate, but keep the adapter interface provider-neutral.

### Step 5: Existing List Cleanup

Run in this order:

1. typo scan over `emails`
2. typo scan over `customers`
3. resolve obvious typo candidates
4. validate resolved typo candidates
5. validate commercial domain batches
6. import provider results
7. update send eligibility

### Step 6: Bounce Recovery

Use Gmail historical scan to extract failed recipients:

- mark bounced observed emails
- match to customers
- create bounce recovery candidates
- cross-check candidates against typo resolver and external provider

### Step 7: Transactional Provider Feedback

Use Elastic Email as a validation signal because SuppliKit already sends transactional messages through it.

Rules:

- Store every Elastic Email event as provider evidence.
- Apply events that map to a known `emails` row.
- Negative events for unknown recipients create suppression-only `emails` rows with `sendEligibility = do_not_send`.
- Positive or neutral events for unknown recipients stay audit-only and do not create contacts.
- Treat bounce/error/suppressed as invalid and `do_not_send`.
- Treat unsubscribe as `do_not_send`.
- Treat abuse/complaint as `do_not_send`, even if the current local status is only risky.
- Treat delivered/sent/open/click as positive evidence, but never promote protected rows such as unsubscribed, invalid, disposable, manual do-not-send, or unresolved typo candidates.
- Keep Gmail bounce scan as a second source of truth for historical data and non-Elastic messages.

This gives three validation layers before ZeroBounce/NeverBounce:

1. Local quality gate and typo scanner.
2. Real transactional delivery feedback from Elastic Email.
3. Gmail mail-daemon/backscatter recovery for historical failures.

## Practical Policy For SuppliKit Auto-Add

SuppliKit should do this:

1. Receive order/customer email.
2. Store source context.
3. Run intake gate.
4. If typo/test/disposable/suppressed: do not create sendable customer.
5. If accepted: create/link customer and email as pending/risky, not safe.
6. Queue internal validation.
7. External validation can later promote to safe-to-send.

This gives us automatic customer growth without poisoning campaign lists.
