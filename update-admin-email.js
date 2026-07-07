const bcrypt = require('bcrypt');
require('dotenv').config({
  path: process.env.NODE_ENV === 'production' ? '.env.production' : '.env',
});

async function updateAdminEmail() {
  // Use MySQL connection (TypeORM uses mysql2)
  const mysql = require('mysql2/promise');
  const oldAdminEmail = process.env.OLD_ADMIN_EMAIL;
  const newAdminEmail = process.env.ADMIN_EMAIL;
  const adminPassword = process.env.ADMIN_PASSWORD;

  if (!oldAdminEmail || !newAdminEmail) {
    throw new Error('OLD_ADMIN_EMAIL and ADMIN_EMAIL environment variables are required');
  }

  const connection = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '3306', 10),
    user: process.env.DB_USERNAME,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_DATABASE,
  });

  try {
    console.log('Connected to database');

    // Check if old email exists
    const [oldUsers] = await connection.execute(
      'SELECT * FROM users WHERE email = ?',
      [oldAdminEmail]
    );

    if (oldUsers.length > 0) {
      console.log('Found user with old email, updating...');
      await connection.execute(
        'UPDATE users SET email = ? WHERE email = ?',
        [newAdminEmail, oldAdminEmail]
      );
      console.log('✓ Email updated successfully');
    } else {
      console.log('Old email not found, checking for correct email...');
      const [correctUsers] = await connection.execute(
        'SELECT * FROM users WHERE email = ?',
        [newAdminEmail]
      );

      if (correctUsers.length > 0) {
        console.log('✓ User with correct email already exists');
      } else {
        if (!adminPassword) {
          throw new Error('ADMIN_PASSWORD is required to create a new admin user');
        }

        console.log('Creating new admin user with correct email...');
        const hashedPassword = await bcrypt.hash(adminPassword, 10);

        await connection.execute(
          'INSERT INTO users (email, password, role, createdAt, updatedAt) VALUES (?, ?, ?, NOW(), NOW())',
          [newAdminEmail, hashedPassword, 'admin']
        );
        console.log('✓ New admin user created');
      }
    }

    // Verify final state
    const [finalUsers] = await connection.execute(
      'SELECT id, email, role FROM users WHERE email = ?',
      [newAdminEmail]
    );

    console.log('\nFinal admin user:');
    console.log(finalUsers[0]);

  } catch (error) {
    console.error('Error:', error);
  } finally {
    await connection.end();
  }
}

updateAdminEmail();
