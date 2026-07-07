# Gmail Full Scan - Documentație Completă

## Prezentare Generală

Sistemul de scanare Gmail este o funcționalitate completă pentru detectarea automată a:
- **Cereri de dezabonare** (unsubscribe requests)
- **Email-uri returnate** (bounces)
- **Confirmări de comenzi** (orders)
- **Mesaje abuzive** (abuse/offensive emails)

### Caracteristici Principale

✅ **Extragere Date Client**
- Nume complet (firstName, lastName, fullName) din header-ul "From"
- Data când a fost trimis email-ul (`gmailMessageDate`) - **CRUCIAL pentru campanii de win-back**
- Categorizare automată (unsubscribe, order, abuse, bounce, clean)

✅ **Rate Limiting Adaptiv**
- Delay de bază: 200ms între cereri (max 5 req/sec)
- Exponential backoff pe erori de rate limit
- Auto-reset la cereri reușite
- Protecție împotriva depășirii cotei Gmail API

✅ **Scanare Zilnică Automată**
- Cron job la 2:00 AM (timezone București)
- Scanează ultimele 90 de zile
- Procesare în fundal cu BullMQ
- Păstrare rezultate pentru 7 zile

## Endpoints API

### 1. Scanare Completă (Full Scan)
```http
POST /api/gmail/scan/full
Content-Type: application/json

{
  "maxResults": 500,    // Optional, default: 500
  "daysBack": 90,       // Optional, default: 90
  "autoUpdate": true    // Optional, default: true
}
```

**Răspuns**:
```json
{
  "message": "Full Gmail scan completed successfully",
  "stats": {
    "totalScanned": 1500,
    "totalUpdated": 1200,
    "totalCreated": 300,
    "totalErrors": 0,
    "unsubscribes": 45,
    "bounces": 23,
    "orders": 1200,
    "abuse": 5,
    "durationSeconds": "125.45"
  },
  "details": {
    "unsubscribeScan": { ... },
    "ordersScan": { ... },
    "abuseScan": { ... }
  }
}
```

### 2. Statistici Gmail
```http
GET /api/gmail/scan/stats
```

**Răspuns**:
```json
{
  "message": "Gmail scan statistics retrieved successfully",
  "stats": {
    "total": 1900000,
    "scanned": 150000,
    "notScanned": 1750000,
    "byCategory": {
      "unsubscribe": 1250,
      "order": 125000,
      "abuse": 45,
      "bounce": 3500,
      "clean": 20205
    },
    "withNames": 148000,
    "withMessageDate": 149500,
    "recentScans": {
      "last24h": 500,
      "last7days": 2500,
      "last30days": 15000
    }
  }
}
```

### 3. Scanare Individuală

**Unsubscribe/Bounce**:
```http
POST /api/gmail/scan
```

**Orders**:
```http
POST /api/gmail/scan/orders
```

**Abuse**:
```http
POST /api/gmail/scan/abuse
```

### 4. Queue Management (Scanări Mari)

**Start Job**:
```http
POST /api/gmail/scan/queue/start
{
  "scanType": "unsubscribe" | "orders" | "abuse",
  "maxResults": null,  // null = ALL emails
  "daysBack": 90,
  "autoUpdate": true
}
```

**Check Status**:
```http
GET /api/gmail/scan/queue/status/:jobId
```

**List All Jobs**:
```http
GET /api/gmail/scan/queue/jobs
```

## Structura Bazei de Date

### Coloane Noi în Tabela `emails`

| Coloană | Tip | Descriere |
|---------|-----|-----------|
| `fullName` | VARCHAR(255) | Numele complet extras din From header |
| `lastGmailScanDate` | TIMESTAMP | Data ultimei scanări Gmail |
| `gmailMessageDate` | TIMESTAMP | **Data când clientul a trimis emailul (pentru win-back!)** |
| `gmailCategory` | ENUM | Categorie: unsubscribe, order, abuse, bounce, clean |

### Indecși Creați
- `idx_gmail_category` pe `gmailCategory`
- `idx_gmail_message_date` pe `gmailMessageDate`

## Migrație Database

Fișier: `src/database/migrations/1777650000000-AddGmailScanFields.ts`

**Rulare migrație**:
```bash
npm run typeorm migration:run
```

**Revert migrație**:
```bash
npm run typeorm migration:revert
```

## Cron Job Zilnic

**Configurare**: [gmail-scheduled-task.service.ts](src/modules/gmail/services/gmail-scheduled-task.service.ts)

**Program**: Zilnic la 2:00 AM (timezone București)

**Ce face**:
1. Scanează ultimele 90 de zile
2. Adaugă 3 job-uri în queue (unsubscribe, orders, abuse)
3. Procesare paralelă cu rate limiting
4. Rezultate păstrate 7 zile

**Logs**:
```
🕒 Starting daily Gmail full scan (scheduled at 2:00 AM)
✅ Daily Gmail scan jobs queued successfully:
   - Unsubscribe scan (Job ID: 12345)
   - Orders scan (Job ID: 12346)
   - Abuse scan (Job ID: 12347)
```

## Cazuri de Utilizare

### 1. Win-back Campaigns (PRINCIPAL!)

Identifică clienți care au comandat acum 1 an:

```sql
SELECT email, fullName, gmailMessageDate
FROM emails
WHERE gmailCategory = 'order'
  AND gmailMessageDate BETWEEN DATE_SUB(NOW(), INTERVAL 13 MONTH)
                            AND DATE_SUB(NOW(), INTERVAL 11 MONTH)
  AND verificationStatus = 'VALID'
ORDER BY gmailMessageDate DESC;
```

### 2. Curățare Listă Email

Exclude unsubscribe și bounces:

```sql
SELECT email FROM emails
WHERE gmailCategory NOT IN ('unsubscribe', 'bounce', 'abuse')
  AND verificationStatus = 'VALID';
```

### 3. Segmentare Clienți

Clienți activi care au comandat recent:

```sql
SELECT email, fullName
FROM emails
WHERE gmailCategory = 'order'
  AND gmailMessageDate > DATE_SUB(NOW(), INTERVAL 6 MONTH);
```

## Rate Limiting - Detalii Tehnice

### Configurare
```typescript
{
  baseDelayMs: 200,          // 200ms între cereri
  currentDelayMs: 200,       // Delay curent (se adaptează)
  maxDelayMs: 5000,          // Max 5s pe retry
  backoffMultiplier: 2,      // Dublare delay pe eroare
  consecutiveErrors: 0,      // Tracking erori consecutive
  maxConsecutiveErrors: 5    // Reset după 5 erori
}
```

### Comportament
1. **Cerere reușită** → Reset la 200ms
2. **Rate limit error (429/403)** → Dublare delay (200 → 400 → 800 → 1600 → 3200ms)
3. **5 erori consecutive** → Pauză 10s + reset la 200ms

### Limite Gmail API
- **1 billion** quota units/zi
- **250** quota units/user/second
- **users.messages.list**: 5 quota units
- **users.messages.get**: 5 quota units
→ Max **50 requests/second** teoretic, limitat la **5/second** pentru siguranță

## Teste Locale

### 1. Test Dry Run (fără update DB)
```bash
curl -X POST http://localhost:3001/api/gmail/scan/dry-run \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -d '{"maxResults": 10}'
```

### 2. Test Full Scan
```bash
curl -X POST http://localhost:3001/api/gmail/scan/full \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -d '{
    "maxResults": 100,
    "daysBack": 30,
    "autoUpdate": true
  }'
```

### 3. Verificare Statistici
```bash
curl http://localhost:3001/api/gmail/scan/stats \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

## Deployment în Producție

### 1. Instalare Dependențe
```bash
npm install @nestjs/schedule --legacy-peer-deps
```

### 2. Build
```bash
npm run build
```

### 3. Rulare Migrație
```bash
npm run typeorm migration:run
```

### 4. Verificare Variabile Env
```bash
# În .env.production
GMAIL_CLIENT_ID=...
GMAIL_CLIENT_SECRET=...
GMAIL_REDIRECT_URI=https://mailpal.inventorypal.ro/api/gmail/oauth2callback
GMAIL_REFRESH_TOKEN=...
```

### 5. Restart PM2
```bash
pm2 restart inventorypal-email
pm2 logs inventorypal-email
```

### 6. Verificare Cron Job
Monitorizează logs la 2:00 AM următoarea zi:
```bash
pm2 logs inventorypal-email --lines 100
```

## Troubleshooting

### Eroare: "Rate limit exceeded"
- **Cauză**: Prea multe cereri la Gmail API
- **Soluție**: Crește `baseDelayMs` în `gmail.service.ts` (de la 200ms la 500ms)

### Eroare: "OAuth token expired"
- **Cauză**: Refresh token invalid
- **Soluție**: Re-autentifică via `/api/gmail/auth-url`

### Cron job nu rulează
- **Verifică**: Timezone corect în `gmail-scheduled-task.service.ts`
- **Verifică**: ScheduleModule.forRoot() în `gmail.module.ts`
- **Logs**: `pm2 logs | grep "daily-gmail-full-scan"`

### Nume nu se extrag
- **Cauză**: Format header "From" nerecunoscut
- **Verifică**: Logs pentru pattern-uri nesuportate
- **Extinde**: `parseNameFromHeader()` cu noi formate

## Performanță

### Estimări pentru 7M Emails

**Scanare completă (7M emails)**:
- Timp estimat: ~389 ore (16 zile) cu rate limiting 200ms
- Rate limiting necesar pentru protecție API
- Recomandare: Rulare în multiple job-uri BullMQ pe parcursul a 2-4 săptămâni

**Scanare zilnică (ultimele 90 zile)**:
- Volume nou: ~10,000 emails/zi (estimare conservativă)
- Timp scanare: ~33 minute/zi
- Window optim: 2:00 AM - 3:00 AM

### Optimizări Recomandate

1. **Batch Processing**: Folosește queue pentru scanări mari
2. **Incremental Scans**: Scanează doar email-uri noi (nu re-scanare)
3. **Category Caching**: Nu re-categoriza email-uri deja procesate (check `lastGmailScanDate`)

## Monitorizare

### Metrici Cheie
- Total emails scanned/day
- Categorization distribution
- Queue processing time
- API rate limit hits
- Name extraction success rate

### Dashboard Queries

**Activitate zilnică**:
```sql
SELECT DATE(lastGmailScanDate) as scan_date,
       COUNT(*) as emails_scanned
FROM emails
WHERE lastGmailScanDate >= DATE_SUB(NOW(), INTERVAL 7 DAY)
GROUP BY DATE(lastGmailScanDate);
```

**Distribuție categorii**:
```sql
SELECT gmailCategory, COUNT(*) as count
FROM emails
WHERE gmailCategory IS NOT NULL
GROUP BY gmailCategory;
```

**Success rate extragere nume**:
```sql
SELECT
  COUNT(*) as total_scanned,
  SUM(CASE WHEN fullName IS NOT NULL THEN 1 ELSE 0 END) as with_name,
  ROUND(SUM(CASE WHEN fullName IS NOT NULL THEN 1 ELSE 0 END) * 100.0 / COUNT(*), 2) as success_rate
FROM emails
WHERE lastGmailScanDate IS NOT NULL;
```

## Următorii Pași

1. ✅ **Testare completă** în staging/development
2. ⏸️ **Rulare migrație** în producție
3. ⏸️ **Deploy** cod nou
4. ⏸️ **Monitorizare** primă scanare zilnică (2 AM)
5. ⏸️ **Validare** date extrase (nume, date, categorii)
6. ⏸️ **Configurare alerte** pentru erori de scanare

## Suport

Pentru întrebări sau probleme:
- Verifică logs: `pm2 logs inventorypal-email`
- Check queue status: `GET /api/gmail/scan/queue/jobs`
- Review stats: `GET /api/gmail/scan/stats`

---

**Versiune**: 1.0.0
**Data**: 2026-05-01
**Autor**: Claude + Alex Manta
