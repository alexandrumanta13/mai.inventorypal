import {
  MigrationInterface,
  QueryRunner,
  TableColumn,
  TableForeignKey,
  TableIndex,
} from 'typeorm';

export class AlignEmailsWithCrmSchema1777650200000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    if (!(await queryRunner.hasTable('emails'))) {
      return;
    }

    await queryRunner.query(`
      ALTER TABLE emails
      MODIFY COLUMN verificationStatus ENUM(
        'pending',
        'valid',
        'invalid',
        'risky',
        'disposable',
        'unknown',
        'unsubscribed'
      ) NOT NULL DEFAULT 'pending'
    `);

    if (!(await queryRunner.hasColumn('emails', 'email_domain'))) {
      await queryRunner.addColumn(
        'emails',
        new TableColumn({
          name: 'email_domain',
          type: 'varchar',
          length: '100',
          isNullable: true,
        }),
      );
    }

    if (!(await queryRunner.hasColumn('emails', 'customer_id'))) {
      await queryRunner.addColumn(
        'emails',
        new TableColumn({
          name: 'customer_id',
          type: 'bigint',
          isNullable: true,
        }),
      );
    }

    await this.ensureIndex(queryRunner, 'emails', 'idx_email_domain', ['email_domain']);
    await this.ensureIndex(queryRunner, 'emails', 'idx_email_customer', ['customer_id']);
    await this.ensureEmailCustomerForeignKey(queryRunner);

    if (await queryRunner.hasTable('verification_history')) {
      await queryRunner.query(`
        ALTER TABLE verification_history
        MODIFY COLUMN finalStatus ENUM(
          'pending',
          'valid',
          'invalid',
          'risky',
          'disposable',
          'unknown',
          'unsubscribed'
        ) NOT NULL
      `);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    if (!(await queryRunner.hasTable('emails'))) {
      return;
    }

    const emailsTable = await queryRunner.getTable('emails');
    const customerForeignKey = emailsTable?.foreignKeys.find((foreignKey) => {
      return (
        foreignKey.columnNames.length === 1 &&
        foreignKey.columnNames[0] === 'customer_id' &&
        foreignKey.referencedTableName === 'customers'
      );
    });

    if (customerForeignKey) {
      await queryRunner.dropForeignKey('emails', customerForeignKey);
    }

    await this.dropIndexIfExists(queryRunner, 'emails', 'idx_email_customer');
    await this.dropIndexIfExists(queryRunner, 'emails', 'idx_email_domain');

    if (await queryRunner.hasColumn('emails', 'customer_id')) {
      await queryRunner.dropColumn('emails', 'customer_id');
    }

    if (await queryRunner.hasColumn('emails', 'email_domain')) {
      await queryRunner.dropColumn('emails', 'email_domain');
    }

    await queryRunner.query(`
      UPDATE emails
      SET verificationStatus = 'unknown'
      WHERE verificationStatus = 'unsubscribed'
    `);

    await queryRunner.query(`
      ALTER TABLE emails
      MODIFY COLUMN verificationStatus ENUM(
        'pending',
        'valid',
        'invalid',
        'risky',
        'disposable',
        'unknown'
      ) NOT NULL DEFAULT 'pending'
    `);

    if (await queryRunner.hasTable('verification_history')) {
      await queryRunner.query(`
        UPDATE verification_history
        SET finalStatus = 'unknown'
        WHERE finalStatus IN ('pending', 'unsubscribed')
      `);

      await queryRunner.query(`
        ALTER TABLE verification_history
        MODIFY COLUMN finalStatus ENUM(
          'valid',
          'invalid',
          'risky',
          'disposable',
          'unknown'
        ) NOT NULL
      `);
    }
  }

  private async ensureIndex(
    queryRunner: QueryRunner,
    tableName: string,
    indexName: string,
    columnNames: string[],
  ): Promise<void> {
    const table = await queryRunner.getTable(tableName);
    if (!table || table.indices.some((index) => index.name === indexName)) {
      return;
    }

    await queryRunner.createIndex(
      tableName,
      new TableIndex({
        name: indexName,
        columnNames,
      }),
    );
  }

  private async dropIndexIfExists(
    queryRunner: QueryRunner,
    tableName: string,
    indexName: string,
  ): Promise<void> {
    const table = await queryRunner.getTable(tableName);
    const index = table?.indices.find((existingIndex) => existingIndex.name === indexName);

    if (index) {
      await queryRunner.dropIndex(tableName, index);
    }
  }

  private async ensureEmailCustomerForeignKey(queryRunner: QueryRunner): Promise<void> {
    if (!(await queryRunner.hasTable('customers'))) {
      return;
    }

    const table = await queryRunner.getTable('emails');
    if (!table) {
      return;
    }

    const exists = table.foreignKeys.some((foreignKey) => {
      return (
        foreignKey.columnNames.length === 1 &&
        foreignKey.columnNames[0] === 'customer_id' &&
        foreignKey.referencedTableName === 'customers'
      );
    });

    if (exists) {
      return;
    }

    await queryRunner.createForeignKey(
      'emails',
      new TableForeignKey({
        columnNames: ['customer_id'],
        referencedColumnNames: ['id'],
        referencedTableName: 'customers',
        onDelete: 'SET NULL',
      }),
    );
  }
}
