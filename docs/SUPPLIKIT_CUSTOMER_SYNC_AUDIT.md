# SuppliKit Customer Sync Audit

## Source Of Truth

SuppliKit persists synced WooCommerce and Shopify orders in its backend database:

- Table: `order`
- Domain table: `authorized_domains`
- Important customer fields: `customerEmail`, `customerPhone`, `customerFirstName`, `customerLastName`, `billingAddress`, `shippingAddress`
- Important provenance fields: `authorizedDomainId`, `store_url`, `store_name`, `platform`

Shopify payloads are adapted into the same order shape before persistence, so SuppliKit orders are the right source for MailPal customer sync.

## Implemented Direction

Use two integration paths:

1. Customer audit/export endpoint in SuppliKit.
2. Non-blocking webhook signal from SuppliKit to MailPal.

The export endpoint is preferred over direct DB access because it keeps MailPal decoupled from SuppliKit schema details.

## SuppliKit Endpoints

```text
GET /api/integrations/inventorypal/customers/overview?daysBack=7
GET /api/integrations/inventorypal/customers?daysBack=30&limit=500&offset=0
```

Security:

```text
Authorization: Bearer <INVENTORYPAL_EXPORT_TOKEN>
```

or:

```text
x-inventorypal-service-token: <INVENTORYPAL_EXPORT_TOKEN>
```

The customer export groups by normalized email and `authorizedDomainId`. MailPal still upserts a single customer by email, then records each matched source domain as customer-domain provenance.

## Secondary Domains

Secondary domains should be included. They should not create duplicate customers, but they answer important business questions:

- where the customer first appeared;
- which domains have overlapping customers;
- which future campaigns can be segmented by source domain;
- whether new domains are generating new customer records after activation.

## MailPal Behavior

MailPal source preference:

1. `INVENTORYPAL_SYNC_API_URL` + `INVENTORYPAL_SYNC_API_TOKEN`
2. fallback `INVENTORYPAL_DB_*`

Manual import remains available from the Import page.

Automatic import remains disabled by default and can be enabled after production configuration is verified:

```env
INVENTORYPAL_AUTO_IMPORT_ENABLED=true
```

## Webhook-Level Integration

SuppliKit calls MailPal after an order is saved in `OrdersService.upsertOrder`:

```text
POST https://mailpal.inventorypal.ro/api/imports/inventorypal/webhook
x-inventorypal-webhook-secret: <shared secret>
```

This webhook does not process a customer inline. It only signals MailPal to start or reuse a background import job. This keeps WooCommerce/Shopify webhook handling fast and resilient.
