require('dotenv').config({ path: '.env.production' });
const { google } = require('googleapis');

async function main() {
  const oauth2Client = new google.auth.OAuth2(
    process.env.GMAIL_CLIENT_ID,
    process.env.GMAIL_CLIENT_SECRET,
    process.env.GMAIL_REDIRECT_URI,
  );

  oauth2Client.setCredentials({
    refresh_token: process.env.GMAIL_REFRESH_TOKEN,
  });

  const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

  console.log('\n🔍 EXTRAG EMAIL-URI RECENTE DIN GMAIL...\n');

  // Get recent emails
  const response = await gmail.users.messages.list({
    userId: 'me',
    maxResults: 30,
    q: 'after:2026/04/28',
  });

  const messages = response.data.messages || [];
  console.log(`✅ Găsite ${messages.length} email-uri\n`);
  console.log('='.repeat(100));

  let count = 0;
  for (const msg of messages.slice(0, 15)) {
    try {
      const fullMsg = await gmail.users.messages.get({
        userId: 'me',
        id: msg.id,
        format: 'full',
      });

      const headers = fullMsg.data.payload.headers;
      const from = headers.find((h) => h.name === 'From')?.value || '';
      const subject = headers.find((h) => h.name === 'Subject')?.value || '';
      const date = headers.find((h) => h.name === 'Date')?.value || '';

      // Get body
      let body = '';
      if (fullMsg.data.payload.parts) {
        const textPart = fullMsg.data.payload.parts.find(
          (part) => part.mimeType === 'text/plain',
        );
        if (textPart?.body?.data) {
          body = Buffer.from(textPart.body.data, 'base64').toString('utf-8');
        }
      } else if (fullMsg.data.payload.body?.data) {
        body = Buffer.from(fullMsg.data.payload.body.data, 'base64').toString('utf-8');
      }

      // Check for unsubscribe patterns
      const fullText = `${subject} ${body}`.toLowerCase();
      const isUnsubscribe =
        /\b(unsubscribe|dezabon|opt.out|stop.receiv|remove.me|nu.mai.vreau|stop.send)/i.test(
          fullText,
        );
      const isOrder = /\[(.*?)\]:\s*(comand|order)/i.test(subject);

      if (isUnsubscribe && !isOrder) {
        count++;
        console.log(`\n\n📧 EMAIL #${count} - UNSUBSCRIBE REQUEST`);
        console.log(`   From: ${from}`);
        console.log(`   Date: ${date}`);
        console.log(`   Subject: ${subject}`);
        console.log(`\n   📄 BODY (primele 600 caractere):`);
        console.log(`   ${'-'.repeat(96)}`);
        const lines = body.substring(0, 600).split('\n');
        lines.forEach((line) => console.log(`   ${line}`));
        console.log(`   ${'-'.repeat(96)}`);
        console.log(`   ${'='.repeat(96)}`);

        if (count >= 5) break;
      }
    } catch (error) {
      // Skip errors
    }
  }

  if (count === 0) {
    console.log('\n⚠️  Nu am găsit email-uri de dezabonare în ultimele 30 de mesaje.');
    console.log('Încerc să arăt ORICE email pentru referință...\n');

    for (const msg of messages.slice(0, 3)) {
      try {
        const fullMsg = await gmail.users.messages.get({
          userId: 'me',
          id: msg.id,
          format: 'full',
        });

        const headers = fullMsg.data.payload.headers;
        const from = headers.find((h) => h.name === 'From')?.value || '';
        const subject = headers.find((h) => h.name === 'Subject')?.value || '';

        let body = '';
        if (fullMsg.data.payload.parts) {
          const textPart = fullMsg.data.payload.parts.find(
            (part) => part.mimeType === 'text/plain',
          );
          if (textPart?.body?.data) {
            body = Buffer.from(textPart.body.data, 'base64').toString('utf-8');
          }
        }

        console.log(`\n📧 EMAIL SAMPLE`);
        console.log(`   From: ${from}`);
        console.log(`   Subject: ${subject}`);
        console.log(`   Body preview: ${body.substring(0, 200)}...`);
        console.log(`   ${'='.repeat(96)}`);
      } catch (error) {
        // Skip
      }
    }
  }

  console.log(`\n✅ Găsite ${count} email-uri de dezabonare.\n`);
}

main().catch((error) => {
  console.error('❌ Eroare:', error.message);
  process.exit(1);
});
