# SuppliKit Customer Import

The Import page can sync customers from SuppliKit while preserving the existing CSV, JSON and WooCommerce import paths.

## Preferred Integration

MailPal should read customers through the SuppliKit service API:

```env
INVENTORYPAL_SYNC_API_URL=https://<supplikit-host>/api/integrations/inventorypal
INVENTORYPAL_SYNC_API_TOKEN=<shared service token>
```

SuppliKit exposes:

```text
GET /api/integrations/inventorypal/customers/overview?daysBack=7
GET /api/integrations/inventorypal/customers?daysBack=30&limit=500&offset=0
```

Both endpoints require either:

```text
Authorization: Bearer <shared service token>
```

or:

```text
x-inventorypal-service-token: <shared service token>
```

## Customer Shape

The customer export is aggregated by:

```text
normalized email + authorizedDomainId
```

This means MailPal keeps one customer per email, but still tracks every source domain where that customer appeared. Secondary domains are useful provenance, not duplicate customers.

The export includes domain, platform, order count, total spent, first order date, last order date and latest order customer details.

## Fallback Integration

Direct SuppliKit DB polling still works as a fallback:

```env
INVENTORYPAL_DB_HOST=
INVENTORYPAL_DB_PORT=3306
INVENTORYPAL_DB_USERNAME=
INVENTORYPAL_DB_PASSWORD=
INVENTORYPAL_DB_DATABASE=
```

When `INVENTORYPAL_SYNC_API_URL` and `INVENTORYPAL_SYNC_API_TOKEN` are set, MailPal uses the API. Otherwise it falls back to DB polling if `INVENTORYPAL_DB_*` is configured.

## Manual Import

Use the Import page and the `SuppliKit live orders` card.

MailPal endpoints:

```text
GET  /api/imports/inventorypal/overview?daysBack=7
POST /api/imports/inventorypal
```

`POST /api/imports/inventorypal` accepts:

```json
{
  "daysBack": 7,
  "limit": 5000
}
```

## Automatic Import

Automatic import is off by default:

```env
INVENTORYPAL_AUTO_IMPORT_ENABLED=true
INVENTORYPAL_AUTO_IMPORT_DAYS_BACK=1
INVENTORYPAL_AUTO_IMPORT_LIMIT=5000
INVENTORYPAL_RECONCILIATION_OVERLAP_DAYS=7
INVENTORYPAL_RECONCILIATION_MAX_DAYS=365
```

When enabled, MailPal runs the SuppliKit customer import every 15 minutes and skips overlapping runs.

The configured `INVENTORYPAL_AUTO_IMPORT_DAYS_BACK` is the minimum cron window, not the only recovery window. MailPal stores a persistent sync watermark in `sync_states` and expands the next cron/import window when the last successful sync is older than the configured window:

```text
effective days back = max(configured days back, days since last successful sync + overlap days)
```

This protects against SuppliKit downtime, MailPal deploy/restart interruptions, failed webhooks, and short API outages. The window is capped by `INVENTORYPAL_RECONCILIATION_MAX_DAYS`.

The Import page shows this state in the `SuppliKit live orders` card:

- sync status
- last successful sync
- newest SuppliKit order seen by sync
- next import window

Stale `pending` or `running` import jobs older than 120 minutes are reconciled to `failed` before listing jobs or starting new imports. This prevents orphaned jobs from blocking future webhook/cron imports after an API restart.

## Non-Blocking Webhook Signal

SuppliKit can notify MailPal after an order is saved:

```text
POST /api/imports/inventorypal/webhook
x-inventorypal-webhook-secret: <shared secret>
```

MailPal environment:

```env
INVENTORYPAL_WEBHOOK_SECRET=
INVENTORYPAL_WEBHOOK_IMPORT_DAYS_BACK=2
INVENTORYPAL_WEBHOOK_IMPORT_LIMIT=5000
```

SuppliKit environment:

```env
INVENTORYPAL_WEBHOOK_ENABLED=true
INVENTORYPAL_WEBHOOK_URL=https://mailpal.inventorypal.ro/api/imports/inventorypal/webhook
INVENTORYPAL_WEBHOOK_SECRET=
INVENTORYPAL_WEBHOOK_TIMEOUT_MS=3000
INVENTORYPAL_EXPORT_TOKEN=
```

The webhook is intentionally non-blocking:

- SuppliKit fire-and-forgets the notification after `OrdersService.upsertOrder` saves an order.
- MailPal returns `202 Accepted`.
- MailPal starts one background import only when no SuppliKit import is already pending or running.
- If an import is already active, MailPal returns success with `skipped: true` and `reason: "already_running"`.

The webhook is a speed layer, not the only source of truth. The scheduled cron with sync-state reconciliation is the recovery layer that catches missed webhook notifications or periods where SuppliKit could not reach MailPal.
