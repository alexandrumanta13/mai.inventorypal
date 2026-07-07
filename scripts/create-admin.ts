#!/usr/bin/env ts-node-script

import { DataSource } from 'typeorm';
import * as bcrypt from 'bcrypt';
import { User, UserRole } from '../src/modules/auth/entities/user.entity';
import * as dotenv from 'dotenv';
import * as path from 'path';

// Load environment variables
const envPath = process.env.NODE_ENV === 'production'
  ? path.resolve(process.cwd(), '.env.production')
  : path.resolve(process.cwd(), '.env');

dotenv.config({ path: envPath });

async function createAdminUser() {
  console.log('\n🔐 Admin User Creation Script');
  console.log('================================\n');

  // Admin credentials
  const ADMIN_EMAIL = process.env.ADMIN_EMAIL;
  const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

  if (!ADMIN_EMAIL || !ADMIN_PASSWORD) {
    console.error('Missing ADMIN_EMAIL or ADMIN_PASSWORD environment variables.');
    process.exit(1);
  }

  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`Database: ${process.env.DB_DATABASE || 'Not found'}`);
  console.log(`Creating admin user: ${ADMIN_EMAIL}\n`);

  // Create database connection
  const dataSource = new DataSource({
    type: 'mysql',
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '3306', 10),
    username: process.env.DB_USERNAME || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_DATABASE || 'inventorypal_email',
    entities: [User],
    synchronize: false, // Don't auto-sync in production
  });

  try {
    await dataSource.initialize();
    console.log('✓ Database connection established\n');

    const userRepository = dataSource.getRepository(User);

    // Check if users table exists, create if not
    const queryRunner = dataSource.createQueryRunner();
    const tableExists = await queryRunner.hasTable('users');

    if (!tableExists) {
      console.log('Creating users table...');
      await queryRunner.query(`
        CREATE TABLE users (
          id INT AUTO_INCREMENT PRIMARY KEY,
          email VARCHAR(255) NOT NULL UNIQUE,
          password VARCHAR(255) NOT NULL,
          role ENUM('admin', 'user') NOT NULL DEFAULT 'user',
          isActive BOOLEAN NOT NULL DEFAULT true,
          createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updatedAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        )
      `);
      console.log('✓ Users table created\n');
    }
    await queryRunner.release();

    // Check if admin user already exists
    const existingAdmin = await userRepository.findOne({
      where: { email: ADMIN_EMAIL },
    });

    if (existingAdmin) {
      console.log('⚠️  Admin user already exists!');
      console.log('   Updating password...\n');

      // Update password
      const hashedPassword = await bcrypt.hash(ADMIN_PASSWORD, 10);
      existingAdmin.password = hashedPassword;
      existingAdmin.role = UserRole.ADMIN;
      existingAdmin.isActive = true;

      await userRepository.save(existingAdmin);
      console.log('✓ Admin user password updated successfully!\n');
    } else {
      // Create new admin user
      const hashedPassword = await bcrypt.hash(ADMIN_PASSWORD, 10);

      const adminUser = userRepository.create({
        email: ADMIN_EMAIL,
        password: hashedPassword,
        role: UserRole.ADMIN,
        isActive: true,
      });

      await userRepository.save(adminUser);
      console.log('✓ Admin user created successfully!\n');
    }

    console.log('================================');
    console.log('Admin Credentials:');
    console.log('================================');
    console.log(`Email:    ${ADMIN_EMAIL}`);
    console.log('Password: [set from ADMIN_PASSWORD]');
    console.log('================================\n');
    console.log('⚠️  IMPORTANT: Keep ADMIN_PASSWORD in your secret store only.');
    console.log('   Change the password after first login.\n');

    await dataSource.destroy();
    process.exit(0);
  } catch (error) {
    console.error('❌ Error creating admin user:', error);
    await dataSource.destroy();
    process.exit(1);
  }
}

createAdminUser();
