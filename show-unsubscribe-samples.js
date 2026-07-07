const mysql = require('mysql2/promise');
const { google } = require('googleapis');
require('dotenv').config({
  path: process.env.NODE_ENV === 'production' ? '.env.production' : '.env',
});

async function main() {
  // Connect to production DB
  const connection = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT || '3306', 10),
    user: process.env.DB_USERNAME,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_DATABASE,
  });

  // Get unsubscribed emails
  const [rows] = await connection.execute(`
    SELECT email, gmailMessageId, gmailCategory, gmailMessageDate
    FROM emails
    WHERE verificationStatus = 'UNSUBSCRIBED'
      AND gmailMessageId IS NOT NULL
      AND updatedAt >= DATE_SUB(NOW(), INTERVAL 2 HOURS)
    ORDER BY gmailMessageDate DESC
    LIMIT 5
  `);

  console.log(`\n🔍 EXEMPLE REALE DE EMAIL-URI DE DEZABONARE\n${'='.repeat(80)}\n`);

  if (rows.length === 0) {
    console.log('Nu s-au găsit email-uri de dezabonare recente.');
    await connection.end();
    return;
  }

  // Setup Gmail API
  const oauth2Client = new google.auth.OAuth2(
    process.env.GMAIL_CLIENT_ID,
    process.env.GMAIL_CLIENT_SECRET,
    process.env.GMAIL_REDIRECT_URI,
  );

  oauth2Client.setCredentials({
    refresh_token: process.env.GMAIL_REFRESH_TOKEN,
  });

  const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    console.log(`\n📧 EMAIL #${i + 1}: ${row.email}`);
    console.log(`   Category: ${row.gmailCategory}`);
    console.log(`   Date: ${row.gmailMessageDate}`);
    console.log(`   Message ID: ${row.gmailMessageId}`);

    try {
      // Fetch full email from Gmail
      const message = await gmail.users.messages.get({
        userId: 'me',
        id: row.gmailMessageId,
        format: 'full',
      });

      const headers = message.data.payload.headers;
      const subject = headers.find((h) => h.name === 'Subject')?.value || 'N/A';
      const from = headers.find((h) => h.name === 'From')?.value || 'N/A';

      // Get body
      let body = '';
      if (message.data.payload.parts) {
        const textPart = message.data.payload.parts.find(
          (part) => part.mimeType === 'text/plain',
        );
        if (textPart?.body?.data) {
          body = Buffer.from(textPart.body.data, 'base64').toString('utf-8');
        }
      } else if (message.data.payload.body?.data) {
        body = Buffer.from(message.data.payload.body.data, 'base64').toString('utf-8');
      }

      console.log(`\n   ✉️  FROM: ${from}`);
      console.log(`   📝 SUBJECT: ${subject}`);
      console.log(`\n   📄 BODY (primele 500 caractere):`);
      console.log(`   ${'-'.repeat(76)}`);
      console.log(`   ${body.substring(0, 500).replace(/\n/g, '\n   ')}`);
      console.log(`   ${'-'.repeat(76)}`);
    } catch (error) {
      console.log(`   ❌ Eroare la citirea email-ului: ${error.message}`);
    }

    console.log(`\n${'='.repeat(80)}`);
  }

  await connection.end();
}

main().catch(console.error);
