# Gmail API Setup Guide

This guide will help you configure Gmail API integration to automatically detect unsubscribe requests and bounced emails.

## Features

The Gmail integration scans your Gmail inbox for:

### Unsubscribe Detection (Romanian & English)
- "unsubscribe", "dezabonare", "oprește", "stop"
- "remove me", "do not send", "nu mai trimite"
- "vreau sa ma dezabonez", "opt-out"

### Bounce-back Detection
- "Out of Office", "Away from Office"
- "Delivery failed", "Delivery status notification"
- "Mailer-Daemon", "Postmaster"
- "Address not found", "User not found"
- "550 User unknown", "550 No such user"
- "Mailbox unavailable", "Mailbox full"
- "Permanent error", "Undelivered mail"

## Setup Instructions

### Step 1: Create Google Cloud Project

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Click "Select a project" → "New Project"
3. Enter project name: "InventoryPal Email"
4. Click "Create"

### Step 2: Enable Gmail API

1. In the Cloud Console, go to "APIs & Services" → "Library"
2. Search for "Gmail API"
3. Click "Gmail API" → "Enable"

### Step 3: Configure OAuth Consent Screen

1. Go to "APIs & Services" → "OAuth consent screen"
2. Select "External" user type → Click "Create"
3. Fill in the required fields:
   - App name: "InventoryPal Email Scanner"
   - User support email: your email
   - Developer contact: your email
4. Click "Save and Continue"
5. On "Scopes" page, click "Add or Remove Scopes"
6. Add this scope: `https://www.googleapis.com/auth/gmail.readonly`
7. Click "Update" → "Save and Continue"
8. On "Test users" page, add your Gmail address
9. Click "Save and Continue" → "Back to Dashboard"

### Step 4: Create OAuth2 Credentials

1. Go to "APIs & Services" → "Credentials"
2. Click "Create Credentials" → "OAuth client ID"
3. Choose "Web application"
4. Name: "InventoryPal Email Scanner"
5. Under "Authorized redirect URIs", add:
   ```
   http://localhost:3001/api/gmail/oauth2callback
   ```
6. Click "Create"
7. **IMPORTANT**: Copy the "Client ID" and "Client Secret" that appear

### Step 5: Add Credentials to .env File

Add these lines to your `.env` file:

```bash
# Gmail API Configuration
GMAIL_CLIENT_ID=your_client_id_here
GMAIL_CLIENT_SECRET=your_client_secret_here
GMAIL_REDIRECT_URI=http://localhost:3001/api/gmail/oauth2callback
```

Replace `your_client_id_here` and `your_client_secret_here` with the values from Step 4.

### Step 6: Restart Backend

```bash
npm run start:dev
```

### Step 7: Authorize Gmail Access

1. Get the authorization URL:
   ```bash
   curl http://localhost:3001/api/gmail/auth-url
   ```

2. Open the `authUrl` in your browser
3. Sign in with your Gmail account
4. Click "Allow" to grant access
5. You'll be redirected to a page showing your refresh token
6. Copy the `GMAIL_REFRESH_TOKEN` value

### Step 8: Add Refresh Token to .env

Add this line to your `.env` file:

```bash
GMAIL_REFRESH_TOKEN=your_refresh_token_here
```

### Step 9: Restart Backend Again

```bash
lsof -ti:3001 | xargs kill -9
npm run start:dev
```

### Step 10: Verify Configuration

Check that everything is configured:

```bash
curl http://localhost:3001/api/gmail/status | python3 -m json.tool
```

You should see:
```json
{
  "configured": true,
  "hasRefreshToken": true,
  "message": "Gmail API is fully configured"
}
```

## Usage

### Dry Run (No Database Updates)

Test the scanner without making any database changes:

```bash
curl -X POST http://localhost:3001/api/gmail/scan/dry-run \
  -H "Content-Type: application/json" \
  -d '{
    "maxResults": 100,
    "daysBack": 90
  }' | python3 -m json.tool
```

### Full Scan (With Database Updates)

Scan and automatically update the database:

```bash
curl -X POST http://localhost:3001/api/gmail/scan \
  -H "Content-Type: application/json" \
  -d '{
    "maxResults": 500,
    "daysBack": 90,
    "autoUpdate": true
  }' | python3 -m json.tool
```

### Parameters

- `maxResults`: Number of emails to scan (default: 500)
- `daysBack`: How many days back to search (default: 90)
- `autoUpdate`: Whether to update the database (default: true for `/scan`, false for `/dry-run`)

### Response Example

```json
{
  "message": "Gmail scan completed successfully",
  "result": {
    "scanned": 245,
    "unsubscribeDetected": 12,
    "bounceDetected": 8,
    "updated": 20,
    "errors": 0
  }
}
```

## Available Endpoints

### GET /api/gmail/status
Check Gmail API configuration status

### GET /api/gmail/auth-url
Get OAuth2 authorization URL

### GET /api/gmail/oauth2callback?code=...
OAuth2 callback (used automatically after authorization)

### POST /api/gmail/scan/dry-run
Scan emails without database updates (testing)

### POST /api/gmail/scan
Scan emails and update database

## How It Works

1. **Pattern Matching**: The scanner uses regex patterns to detect unsubscribe keywords and bounce indicators in email subject and body
2. **Email Extraction**: Extracts sender email addresses from "From" header
3. **Database Lookup**: Checks if the email exists in your database
4. **Status Update**:
   - Unsubscribe detected → marks email as `UNSUBSCRIBED`
   - Bounce detected → marks email as `INVALID` with error message
5. **Logging**: All actions are logged for audit purposes

## Security Notes

- OAuth2 tokens are stored in `.env` file (never commit to git!)
- The scanner has read-only access to Gmail
- Only emails in your database are updated
- All API calls are logged

## Troubleshooting

### "Gmail API is not configured"
- Check that all environment variables are set in `.env`
- Restart the backend after adding credentials

### "Invalid authentication credentials"
- Your refresh token may have expired
- Re-authorize using Step 7

### "Quota exceeded"
- Gmail API has daily quotas
- Reduce `maxResults` or wait 24 hours

### "No emails detected"
- Check that you have emails matching the search patterns
- Try increasing `daysBack` parameter

## Next Steps

1. Run a dry-run scan to see what would be detected
2. If results look good, run a full scan with `autoUpdate: true`
3. Schedule regular scans (e.g., daily cron job)
4. Monitor logs for any issues

## Support

If you encounter any issues, check the backend logs:

```bash
tail -f /tmp/backend.log
```
