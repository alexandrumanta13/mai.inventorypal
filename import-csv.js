const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

const CSV_DELIMITER = ';';

async function importCSV() {
  const connection = await mysql.createConnection({
    host: 'localhost',
    user: 'root',
    password: '',
    database: 'inventorypal_email'
  });

  console.log('Connected to database');

  try {
    // Import WooCommerce Orders CSVs
    const woocommerceFiles = [
      'WooCommerce-Orders-Export-2023-November-06-1419.csv',
      'WooCommerce-Orders-Export-2023-November-13-0932.csv',
      'WooCommerce-Orders-depozituldeasternuturi.ro-Export-2023-April-10-1450.csv',
      'WooCommerce-fabricapucioasa.ro-Orders-Export-2023-April-10-1409.csv'
    ];

    for (const file of woocommerceFiles) {
      console.log(`\nProcessing ${file}...`);
      await importWooCommerceFile(connection, file);
    }

    // Import customers-only CSV
    console.log(`\nProcessing customers01.03.2023 2.csv...`);
    await importCustomersOnlyFile(connection, 'customers01.03.2023 2.csv');

  } finally {
    await connection.end();
    console.log('\nAll imports completed!');
  }
}

async function importWooCommerceFile(connection, filename) {
  const filePath = path.join(__dirname, 'imports', filename);
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n').filter(line => line.trim());

  // Skip header
  const dataLines = lines.slice(1);

  let imported = 0;
  let duplicates = 0;
  let errors = 0;

  for (const line of dataLines) {
    const parts = line.split(CSV_DELIMITER);
    if (parts.length < 4) continue;

    const email = parts[0].trim().toLowerCase();
    const phone = parts[1].trim();
    const firstName = parts[2].trim();
    const lastName = parts[3].trim();

    if (!email || !email.includes('@')) continue;

    try {
      // Insert customer
      await connection.query(
        `INSERT INTO customers (email, first_name, last_name, phone, created_at, updated_at)
         VALUES (?, ?, ?, ?, NOW(), NOW())
         ON DUPLICATE KEY UPDATE
           first_name = IF(first_name IS NULL OR first_name = '', VALUES(first_name), first_name),
           last_name = IF(last_name IS NULL OR last_name = '', VALUES(last_name), last_name),
           phone = IF(phone IS NULL OR phone = '', VALUES(phone), phone),
           updated_at = NOW()`,
        [email, firstName || null, lastName || null, phone || null]
      );

      // Insert email
      const emailDomain = email.split('@')[1];
      const [result] = await connection.query(
        `INSERT IGNORE INTO emails (email, email_domain, firstName, lastName, verificationStatus, qualityScore, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, 'pending', 0, NOW(), NOW())`,
        [email, emailDomain, firstName || null, lastName || null]
      );

      if (result.affectedRows > 0) {
        imported++;
      } else {
        duplicates++;
      }
    } catch (error) {
      if (error.code !== 'ER_DUP_ENTRY') {
        console.error(`Error importing ${email}:`, error.message);
        errors++;
      } else {
        duplicates++;
      }
    }
  }

  console.log(`  ${filename}: ${imported} imported, ${duplicates} duplicates, ${errors} errors`);
}

async function importCustomersOnlyFile(connection, filename) {
  const filePath = path.join(__dirname, 'imports', filename);
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n').filter(line => line.trim());

  // Skip header
  const dataLines = lines.slice(1);

  let imported = 0;
  let duplicates = 0;
  let errors = 0;

  for (const line of dataLines) {
    const email = line.trim().toLowerCase();

    if (!email || !email.includes('@')) continue;

    try {
      // Insert customer
      await connection.query(
        `INSERT IGNORE INTO customers (email, created_at, updated_at)
         VALUES (?, NOW(), NOW())`,
        [email]
      );

      // Insert email
      const emailDomain = email.split('@')[1];
      const [result] = await connection.query(
        `INSERT IGNORE INTO emails (email, email_domain, verificationStatus, qualityScore, createdAt, updatedAt)
         VALUES (?, ?, 'pending', 0, NOW(), NOW())`,
        [email, emailDomain]
      );

      if (result.affectedRows > 0) {
        imported++;
      } else {
        duplicates++;
      }
    } catch (error) {
      if (error.code !== 'ER_DUP_ENTRY') {
        console.error(`Error importing ${email}:`, error.message);
        errors++;
      } else {
        duplicates++;
      }
    }
  }

  console.log(`  ${filename}: ${imported} imported, ${duplicates} duplicates, ${errors} errors`);
}

importCSV().catch(console.error);
