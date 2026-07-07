/**
 * Cleanup Script: Remove Marketing Emails from Database
 *
 * Problem: Gmail scan accidentally added marketing emails we received
 * (newsletters, promotions) to the customer database with VALID status.
 *
 * Solution: Identify and DELETE these marketing emails from the database.
 *
 * Marketing email patterns:
 * - From: newsletter@, news@, hello@, team@, support@, etc.
 * - Domains: @substack.com, @e.*, @mail.*, etc.
 * - NOT customer replies (no In-Reply-To header)
 */

const mysql = require('mysql2/promise');
require('dotenv').config({
  path: process.env.NODE_ENV === 'production' ? '.env.production' : '.env',
});

const MARKETING_PATTERNS = [
  'newsletter@',
  'news@',
  'hello@',
  'hi@',
  'team@',
  'support@',
  'info@',
  'contact@',
  '@substack.com',
  '@e.',
  '@mail.',
  '@updates.',
  '@notification.',
  'marketing@',
  'promo@',
  'offers@',
  'deals@',
];

async function main() {
  console.log('\n🧹 CLEANUP: Removing Marketing Emails from Database\n');
  console.log('='.repeat(80));

  // Connect to production database
  const connection = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT || '3306', 10),
    user: process.env.DB_USERNAME,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_DATABASE,
  });

  console.log('✅ Connected to production database\n');

  // Build WHERE clause for marketing patterns
  const whereConditions = MARKETING_PATTERNS.map((pattern) => `email LIKE '%${pattern}%'`).join(
    ' OR ',
  );

  // Count marketing emails before deletion
  const [countResult] = await connection.execute(`
    SELECT COUNT(*) as count
    FROM emails
    WHERE (${whereConditions})
      AND gmailCategory IS NOT NULL
  `);

  const totalToDelete = countResult[0].count;

  console.log(`📊 Found ${totalToDelete} marketing emails to delete\n`);

  if (totalToDelete === 0) {
    console.log('✅ No marketing emails found. Database is clean!\n');
    await connection.end();
    return;
  }

  // Show sample of what will be deleted
  const [samples] = await connection.execute(
    `
    SELECT email, verificationStatus, gmailCategory, gmailMessageDate
    FROM emails
    WHERE (${whereConditions})
      AND gmailCategory IS NOT NULL
    ORDER BY updatedAt DESC
    LIMIT 20
  `,
  );

  console.log('📧 Sample of emails to be deleted:');
  console.log('-'.repeat(80));
  samples.forEach((row, i) => {
    console.log(
      `${i + 1}. ${row.email} | ${row.verificationStatus} | ${row.gmailCategory} | ${row.gmailMessageDate || 'N/A'}`,
    );
  });
  console.log('-'.repeat(80));
  console.log();

  // Perform deletion
  console.log(`🗑️  Deleting ${totalToDelete} marketing emails...\n`);

  const [deleteResult] = await connection.execute(`
    DELETE FROM emails
    WHERE (${whereConditions})
      AND gmailCategory IS NOT NULL
  `);

  console.log(`✅ Deleted ${deleteResult.affectedRows} marketing emails from database\n`);

  // Show final statistics
  const [statsAfter] = await connection.execute(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN gmailCategory IS NOT NULL THEN 1 ELSE 0 END) as gmailScanned,
      SUM(CASE WHEN gmailCategory = 'order' THEN 1 ELSE 0 END) as orders,
      SUM(CASE WHEN gmailCategory = 'unsubscribe' THEN 1 ELSE 0 END) as unsubscribes,
      SUM(CASE WHEN gmailCategory = 'bounce' THEN 1 ELSE 0 END) as bounces,
      SUM(CASE WHEN gmailCategory = 'abuse' THEN 1 ELSE 0 END) as abuse
    FROM emails
  `);

  console.log('📊 Database Statistics After Cleanup:');
  console.log('-'.repeat(80));
  console.log(`Total emails:           ${statsAfter[0].total.toLocaleString()}`);
  console.log(`Gmail scanned emails:   ${statsAfter[0].gmailScanned.toLocaleString()}`);
  console.log(`  - Orders:             ${statsAfter[0].orders.toLocaleString()}`);
  console.log(`  - Unsubscribes:       ${statsAfter[0].unsubscribes.toLocaleString()}`);
  console.log(`  - Bounces:            ${statsAfter[0].bounces.toLocaleString()}`);
  console.log(`  - Abuse:              ${statsAfter[0].abuse.toLocaleString()}`);
  console.log('-'.repeat(80));
  console.log();

  console.log('✅ Cleanup completed successfully!\n');

  await connection.end();
}

main().catch((error) => {
  console.error('❌ Cleanup failed:', error.message);
  console.error(error);
  process.exit(1);
});
