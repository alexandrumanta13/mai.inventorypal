# API Documentation

Base URL: `http://localhost:3001/api`

---

## Emails API

### List Emails
```
GET /emails
```

Returns a paginated list of emails with filtering capabilities.

**Query Parameters:**
| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| page | number | No | 1 | Page number |
| limit | number | No | 100 | Items per page (max 1000) |
| status | string | No | - | Filter by verification status |
| emailDomain | string | No | - | Filter by email domain |
| search | string | No | - | Search in email address (LIKE) |
| minScore | number | No | - | Minimum quality score (0-100) |

**Status Values:**
- `pending` - Not yet verified
- `valid` - All checks passed
- `invalid` - Failed validation
- `risky` - Suspicious patterns
- `disposable` - Temporary email service
- `unsubscribed` - User opted out

**Example Request:**
```bash
curl "http://localhost:3001/api/emails?page=1&limit=10&status=valid&emailDomain=gmail.com"
```

**Example Response:**
```json
{
  "data": [
    {
      "id": "1949996",
      "email": "john@example.com",
      "emailDomain": "example.com",
      "customerId": "75463",
      "firstName": "John",
      "lastName": "Doe",
      "phone": "0730566440",
      "country": "RO",
      "city": "Bucharest",
      "acquisitionSource": "csv_import_lenjeriiieftine-comenzi",
      "acquisitionDate": "2026-04-29",
      "funnelStage": null,
      "hasValidSyntax": true,
      "hasValidDns": true,
      "hasValidSmtp": true,
      "isDisposable": false,
      "isRoleBased": false,
      "hasTypo": false,
      "typoSuggestion": null,
      "verificationStatus": "valid",
      "qualityScore": "85.50",
      "smtpResultCode": "250",
      "smtpErrorMessage": null,
      "lastVerifiedAt": "2026-04-29T10:30:00.000Z",
      "createdAt": "2026-04-29T14:36:10.000Z",
      "updatedAt": "2026-04-29T16:27:30.000Z"
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 10,
    "total": 1932834,
    "totalPages": 193284
  }
}
```

### Get Email by ID
```
GET /emails/:id
```

Returns a single email with all details and sources.

**Example Request:**
```bash
curl "http://localhost:3001/api/emails/1949996"
```

**Example Response:**
```json
{
  "id": "1949996",
  "email": "john@example.com",
  "emailDomain": "example.com",
  "customerId": "75463",
  // ... all email fields
  "sources": [
    {
      "id": 1,
      "emailId": 1949996,
      "sourceType": "csv_import",
      "sourceIdentifier": "lenjeriiieftine-comenzi.csv",
      "consentGiven": true,
      "consentTimestamp": "2026-04-29T14:36:10.000Z",
      "createdAt": "2026-04-29T14:36:10.000Z"
    }
  ]
}
```

### Get Email Statistics
```
GET /emails/stats
```

Returns email counts by verification status.

**Example Response:**
```json
{
  "total": 1932834,
  "byStatus": {
    "pending": 1850000,
    "valid": 45000,
    "invalid": 25000,
    "risky": 8000,
    "disposable": 3500,
    "unsubscribed": 1334
  }
}
```

### Get Email Domains
```
GET /emails/domains
```

Returns list of email domains with counts.

**Query Parameters:**
| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| limit | number | No | 100 | Max domains to return |

**Example Response:**
```json
[
  {
    "domain": "yahoo.com",
    "count": 1016617
  },
  {
    "domain": "gmail.com",
    "count": 733449
  },
  {
    "domain": "yahoo.ro",
    "count": 28190
  }
]
```

### Update Email Status
```
PATCH /emails/:id/status
```

Updates the verification status of an email.

**Request Body:**
```json
{
  "status": "risky"
}
```

**Valid Status Values:**
- `pending`, `valid`, `invalid`, `risky`, `disposable`, `unsubscribed`

**Example Request:**
```bash
curl -X PATCH "http://localhost:3001/api/emails/1949996/status" \
  -H "Content-Type: application/json" \
  -d '{"status": "risky"}'
```

**Example Response:**
```json
{
  "success": true
}
```

---

## Import API

### Start JSON Pages Import
```
POST /imports/json-pages
```

Starts a background job to import emails from JSON page files.

**Example Request:**
```bash
curl -X POST "http://localhost:3001/api/imports/json-pages"
```

**Example Response:**
```json
{
  "success": true,
  "jobId": 1,
  "message": "JSON import job started",
  "status": "pending"
}
```

### Start CSV Import
```
POST /imports/csv
```

Starts a background job to import emails from CSV files and create customers.

**Example Request:**
```bash
curl -X POST "http://localhost:3001/api/imports/csv"
```

**Example Response:**
```json
{
  "success": true,
  "jobId": 2,
  "message": "CSV import job started",
  "status": "pending"
}
```

### Start WooCommerce Import (All Domains)
```
POST /imports/woocommerce
```

Imports customers from all active WooCommerce domains.

**Example Request:**
```bash
curl -X POST "http://localhost:3001/api/imports/woocommerce"
```

**Example Response:**
```json
{
  "success": true,
  "results": [
    {
      "domain": "fabricadeasternuturi.ro",
      "customersImported": 66200,
      "customersUpdated": 0,
      "emailsLinked": 48543,
      "errors": 0
    },
    {
      "domain": "fabrica-pucioasa.ro",
      "customersImported": 6934,
      "customersUpdated": 0,
      "emailsLinked": 5102,
      "errors": 0
    },
    {
      "domain": "asternuturi-pucioasa.ro",
      "customersImported": 2391,
      "customersUpdated": 0,
      "emailsLinked": 1792,
      "errors": 0
    }
  ]
}
```

### Start WooCommerce Import (Specific Domain)
```
POST /imports/woocommerce/:domainId
```

Imports customers from a specific WooCommerce domain.

**Path Parameters:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| domainId | number | Yes | Domain ID (1-6) |

**Example Request:**
```bash
curl -X POST "http://localhost:3001/api/imports/woocommerce/1"
```

**Example Response:**
```json
{
  "success": true,
  "result": {
    "customersImported": 66200,
    "customersUpdated": 0,
    "emailsLinked": 48543,
    "errors": 0
  }
}
```

### Get All Import Jobs
```
GET /imports/jobs
```

Returns a list of recent import jobs.

**Example Response:**
```json
{
  "success": true,
  "jobs": [
    {
      "id": 5,
      "sourceType": "csv",
      "status": "completed",
      "importedEmails": 0,
      "duplicateEmails": 51587,
      "createdAt": "2026-04-29T16:15:00.000Z",
      "completedAt": "2026-04-29T16:27:30.000Z"
    },
    {
      "id": 4,
      "sourceType": "json_pages",
      "status": "completed",
      "importedEmails": 1873247,
      "duplicateEmails": 0,
      "createdAt": "2026-04-28T10:00:00.000Z",
      "completedAt": "2026-04-28T12:45:30.000Z"
    }
  ]
}
```

### Get Import Job Status
```
GET /imports/jobs/:id
```

Returns detailed status of a specific import job.

**Path Parameters:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| id | number | Yes | Import job ID |

**Example Request:**
```bash
curl "http://localhost:3001/api/imports/jobs/5"
```

**Example Response:**
```json
{
  "success": true,
  "job": {
    "id": 5,
    "sourceType": "csv",
    "status": "completed",
    "progress": {
      "percentage": 100,
      "filesProcessed": 4,
      "totalFiles": 4,
      "recordsProcessed": 51587,
      "totalRecords": 51587
    },
    "results": {
      "importedEmails": 0,
      "duplicateEmails": 51587,
      "invalidEmails": 0
    },
    "timestamps": {
      "createdAt": "2026-04-29T16:15:00.000Z",
      "startedAt": "2026-04-29T16:15:01.000Z",
      "completedAt": "2026-04-29T16:27:30.000Z"
    },
    "errorMessage": null
  }
}
```

---

## Domains API

### List All Domains
```
GET /domains
```

Returns all configured domains.

**Example Response:**
```json
[
  {
    "id": 1,
    "domain_name": "fabricadeasternuturi.ro",
    "is_active": true,
    "db_host": "209.250.236.158",
    "db_name": "fabrica_wp_db",
    "db_user": "fabrica_user",
    "db_prefix": "wp_",
    "created_at": "2026-04-28T10:00:00.000Z",
    "updated_at": "2026-04-28T10:00:00.000Z"
  },
  {
    "id": 4,
    "domain_name": "fabricapucioasa.ro",
    "is_active": false,
    "db_host": null,
    "db_name": null,
    "db_user": null,
    "db_prefix": null,
    "created_at": "2026-04-28T10:00:00.000Z",
    "updated_at": "2026-04-28T10:00:00.000Z"
  }
]
```

### List Active Domains
```
GET /domains/active
```

Returns only active (WooCommerce-connected) domains.

**Example Response:**
```json
[
  {
    "id": 1,
    "domain_name": "fabricadeasternuturi.ro",
    "is_active": true,
    "db_host": "209.250.236.158",
    "db_name": "fabrica_wp_db",
    "db_user": "fabrica_user",
    "db_prefix": "wp_",
    "created_at": "2026-04-28T10:00:00.000Z",
    "updated_at": "2026-04-28T10:00:00.000Z"
  }
]
```

### Get Domain by ID
```
GET /domains/:id
```

Returns a single domain.

**Example Response:**
```json
{
  "id": 1,
  "domain_name": "fabricadeasternuturi.ro",
  "is_active": true,
  "db_host": "209.250.236.158",
  "db_name": "fabrica_wp_db",
  "db_user": "fabrica_user",
  "db_prefix": "wp_",
  "created_at": "2026-04-28T10:00:00.000Z",
  "updated_at": "2026-04-28T10:00:00.000Z"
}
```

---

## Customers API

### List Customers
```
GET /customers
```

Returns a list of customers.

**Query Parameters:**
| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| page | number | No | 1 | Page number |
| limit | number | No | 100 | Items per page |

**Example Response:**
```json
{
  "data": [
    {
      "id": 75463,
      "email": "john@example.com",
      "first_name": "John",
      "last_name": "Doe",
      "phone": "0730566440",
      "city": "Bucharest",
      "country": "RO",
      "primary_domain_id": 6,
      "created_at": "2026-04-29T16:27:30.000Z",
      "updated_at": "2026-04-29T16:27:30.000Z"
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 100,
    "total": 75436,
    "totalPages": 755
  }
}
```

---

## Error Responses

All API endpoints follow a consistent error response format:

### 400 Bad Request
```json
{
  "statusCode": 400,
  "message": "Validation failed",
  "error": "Bad Request"
}
```

### 404 Not Found
```json
{
  "statusCode": 404,
  "message": "Resource not found",
  "error": "Not Found"
}
```

### 500 Internal Server Error
```json
{
  "statusCode": 500,
  "message": "Internal server error",
  "error": "Internal Server Error"
}
```

---

## Rate Limiting

Currently not implemented. Future consideration:
- 100 requests per minute per IP
- 1000 requests per hour per IP
- Burst allowance: 20 requests

---

## Authentication

Currently not implemented. All endpoints are public.

Future implementation will use:
- JWT tokens
- API keys for external integrations
- Role-based access control (admin, user, readonly)

---

## Pagination

All list endpoints follow the same pagination pattern:

**Request:**
- `page`: Page number (1-indexed)
- `limit`: Items per page (max varies by endpoint)

**Response:**
```json
{
  "data": [...],
  "pagination": {
    "page": 1,
    "limit": 100,
    "total": 1932834,
    "totalPages": 19329
  }
}
```

---

## Filtering

Filters are applied as query parameters:

```
GET /emails?status=valid&emailDomain=gmail.com&minScore=80
```

Multiple filters are combined with AND logic.

---

## Sorting

Currently not implemented. Future consideration:
```
GET /emails?sortBy=createdAt&sortOrder=desc
```

---

**Last Updated**: 2026-04-29
**Version**: 0.1.0 (Alpha)
