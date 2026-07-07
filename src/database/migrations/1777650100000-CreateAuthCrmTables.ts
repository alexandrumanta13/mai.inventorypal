import {
  MigrationInterface,
  QueryRunner,
  Table,
  TableForeignKey,
  TableIndex,
} from 'typeorm';

export class CreateAuthCrmTables1777650100000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    if (!(await queryRunner.hasTable('users'))) {
      await queryRunner.createTable(
        new Table({
          name: 'users',
          columns: [
            {
              name: 'id',
              type: 'int',
              isPrimary: true,
              isGenerated: true,
              generationStrategy: 'increment',
            },
            {
              name: 'email',
              type: 'varchar',
              length: '255',
              isUnique: true,
            },
            {
              name: 'password',
              type: 'varchar',
              length: '255',
            },
            {
              name: 'role',
              type: 'enum',
              enum: ['admin', 'user'],
              default: "'user'",
            },
            {
              name: 'isActive',
              type: 'boolean',
              default: true,
            },
            {
              name: 'createdAt',
              type: 'timestamp',
              default: 'CURRENT_TIMESTAMP',
            },
            {
              name: 'updatedAt',
              type: 'timestamp',
              default: 'CURRENT_TIMESTAMP',
              onUpdate: 'CURRENT_TIMESTAMP',
            },
          ],
        }),
        true,
      );
    }

    if (!(await queryRunner.hasTable('domains'))) {
      await queryRunner.createTable(
        new Table({
          name: 'domains',
          columns: [
            {
              name: 'id',
              type: 'bigint',
              isPrimary: true,
              isGenerated: true,
              generationStrategy: 'increment',
            },
            {
              name: 'domain_name',
              type: 'varchar',
              length: '100',
              isUnique: true,
            },
            {
              name: 'display_name',
              type: 'varchar',
              length: '100',
            },
            {
              name: 'is_active',
              type: 'boolean',
              default: false,
            },
            {
              name: 'db_host',
              type: 'varchar',
              length: '255',
              isNullable: true,
            },
            {
              name: 'db_user',
              type: 'varchar',
              length: '255',
              isNullable: true,
            },
            {
              name: 'db_password',
              type: 'varchar',
              length: '255',
              isNullable: true,
            },
            {
              name: 'db_name',
              type: 'varchar',
              length: '255',
              isNullable: true,
            },
            {
              name: 'db_prefix',
              type: 'varchar',
              length: '20',
              default: "'wp_'",
            },
            {
              name: 'woo_consumer_key',
              type: 'varchar',
              length: '255',
              isNullable: true,
            },
            {
              name: 'woo_consumer_secret',
              type: 'varchar',
              length: '255',
              isNullable: true,
            },
            {
              name: 'created_at',
              type: 'timestamp',
              default: 'CURRENT_TIMESTAMP',
            },
            {
              name: 'updated_at',
              type: 'timestamp',
              default: 'CURRENT_TIMESTAMP',
              onUpdate: 'CURRENT_TIMESTAMP',
            },
          ],
        }),
        true,
      );
    }

    if (!(await queryRunner.hasTable('customers'))) {
      await queryRunner.createTable(
        new Table({
          name: 'customers',
          columns: [
            {
              name: 'id',
              type: 'bigint',
              isPrimary: true,
              isGenerated: true,
              generationStrategy: 'increment',
            },
            {
              name: 'email',
              type: 'varchar',
              length: '255',
              isUnique: true,
            },
            {
              name: 'first_name',
              type: 'varchar',
              length: '100',
              isNullable: true,
            },
            {
              name: 'last_name',
              type: 'varchar',
              length: '100',
              isNullable: true,
            },
            {
              name: 'phone',
              type: 'varchar',
              length: '50',
              isNullable: true,
            },
            {
              name: 'company',
              type: 'varchar',
              length: '100',
              isNullable: true,
            },
            {
              name: 'address_1',
              type: 'varchar',
              length: '255',
              isNullable: true,
            },
            {
              name: 'address_2',
              type: 'varchar',
              length: '255',
              isNullable: true,
            },
            {
              name: 'city',
              type: 'varchar',
              length: '100',
              isNullable: true,
            },
            {
              name: 'state',
              type: 'varchar',
              length: '100',
              isNullable: true,
            },
            {
              name: 'postcode',
              type: 'varchar',
              length: '20',
              isNullable: true,
            },
            {
              name: 'country',
              type: 'varchar',
              length: '10',
              isNullable: true,
            },
            {
              name: 'preferred_payment_method',
              type: 'enum',
              enum: ['card', 'cash_on_delivery', 'bank_transfer', 'unknown'],
              default: "'unknown'",
            },
            {
              name: 'primary_domain_id',
              type: 'bigint',
              isNullable: true,
            },
            {
              name: 'woocommerce_customer_id',
              type: 'varchar',
              length: '255',
              isNullable: true,
            },
            {
              name: 'total_orders',
              type: 'int',
              default: 0,
            },
            {
              name: 'total_spent',
              type: 'decimal',
              precision: 10,
              scale: 2,
              default: 0,
            },
            {
              name: 'last_order_date',
              type: 'date',
              isNullable: true,
            },
            {
              name: 'created_at',
              type: 'timestamp',
              default: 'CURRENT_TIMESTAMP',
            },
            {
              name: 'updated_at',
              type: 'timestamp',
              default: 'CURRENT_TIMESTAMP',
              onUpdate: 'CURRENT_TIMESTAMP',
            },
          ],
        }),
        true,
      );

      await queryRunner.createIndex(
        'customers',
        new TableIndex({
          name: 'idx_customer_email',
          columnNames: ['email'],
        }),
      );
      await queryRunner.createIndex(
        'customers',
        new TableIndex({
          name: 'idx_customer_primary_domain',
          columnNames: ['primary_domain_id'],
        }),
      );
      await queryRunner.createIndex(
        'customers',
        new TableIndex({
          name: 'idx_customer_city',
          columnNames: ['city'],
        }),
      );
      await queryRunner.createIndex(
        'customers',
        new TableIndex({
          name: 'idx_customer_state',
          columnNames: ['state'],
        }),
      );
    }

    if (!(await queryRunner.hasTable('customer_domains'))) {
      await queryRunner.createTable(
        new Table({
          name: 'customer_domains',
          columns: [
            {
              name: 'id',
              type: 'bigint',
              isPrimary: true,
              isGenerated: true,
              generationStrategy: 'increment',
            },
            {
              name: 'customer_id',
              type: 'bigint',
            },
            {
              name: 'domain_id',
              type: 'bigint',
            },
            {
              name: 'woocommerce_customer_id',
              type: 'varchar',
              length: '255',
              isNullable: true,
            },
            {
              name: 'order_count',
              type: 'int',
              default: 0,
            },
            {
              name: 'total_spent',
              type: 'decimal',
              precision: 10,
              scale: 2,
              default: 0,
            },
            {
              name: 'first_order_date',
              type: 'date',
              isNullable: true,
            },
            {
              name: 'last_order_date',
              type: 'date',
              isNullable: true,
            },
            {
              name: 'created_at',
              type: 'timestamp',
              default: 'CURRENT_TIMESTAMP',
            },
          ],
        }),
        true,
      );

      await queryRunner.createIndex(
        'customer_domains',
        new TableIndex({
          name: 'idx_customer_domain_unique',
          columnNames: ['customer_id', 'domain_id'],
          isUnique: true,
        }),
      );
    }

    await this.ensureForeignKey(queryRunner, 'customers', ['primary_domain_id'], 'domains', ['id'], 'SET NULL');
    await this.ensureForeignKey(queryRunner, 'customer_domains', ['customer_id'], 'customers', ['id'], 'CASCADE');
    await this.ensureForeignKey(queryRunner, 'customer_domains', ['domain_id'], 'domains', ['id'], 'CASCADE');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    if (await queryRunner.hasTable('customer_domains')) {
      await queryRunner.dropTable('customer_domains');
    }

    if (await queryRunner.hasTable('customers')) {
      await queryRunner.dropTable('customers');
    }

    if (await queryRunner.hasTable('domains')) {
      await queryRunner.dropTable('domains');
    }

    if (await queryRunner.hasTable('users')) {
      await queryRunner.dropTable('users');
    }
  }

  private async ensureForeignKey(
    queryRunner: QueryRunner,
    tableName: string,
    columnNames: string[],
    referencedTableName: string,
    referencedColumnNames: string[],
    onDelete: 'CASCADE' | 'SET NULL',
  ): Promise<void> {
    const table = await queryRunner.getTable(tableName);
    if (!table) {
      return;
    }

    const exists = table.foreignKeys.some((foreignKey) => {
      return (
        foreignKey.columnNames.join(',') === columnNames.join(',') &&
        foreignKey.referencedTableName === referencedTableName
      );
    });

    if (exists) {
      return;
    }

    await queryRunner.createForeignKey(
      tableName,
      new TableForeignKey({
        columnNames,
        referencedColumnNames,
        referencedTableName,
        onDelete,
      }),
    );
  }
}
