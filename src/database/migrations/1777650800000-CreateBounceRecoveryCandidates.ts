import { MigrationInterface, QueryRunner, Table, TableForeignKey, TableIndex } from 'typeorm';

export class CreateBounceRecoveryCandidates1777650800000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    if (!(await queryRunner.hasTable('bounce_recovery_candidates'))) {
      await queryRunner.createTable(
        new Table({
          name: 'bounce_recovery_candidates',
          columns: [
            {
              name: 'id',
              type: 'bigint',
              isPrimary: true,
              isGenerated: true,
              generationStrategy: 'increment',
            },
            {
              name: 'emailId',
              type: 'bigint',
              isNullable: true,
            },
            {
              name: 'customerId',
              type: 'bigint',
              isNullable: true,
            },
            {
              name: 'bouncedEmail',
              type: 'varchar',
              length: '255',
            },
            {
              name: 'suggestedEmail',
              type: 'varchar',
              length: '255',
            },
            {
              name: 'reason',
              type: 'enum',
              enum: ['domain_typo', 'name_localpart_typo'],
            },
            {
              name: 'confidence',
              type: 'enum',
              enum: ['high', 'medium'],
              default: "'medium'",
            },
            {
              name: 'status',
              type: 'enum',
              enum: ['pending', 'approved', 'ignored'],
              default: "'pending'",
            },
            {
              name: 'source',
              type: 'varchar',
              length: '100',
              default: "'gmail_bounce'",
            },
            {
              name: 'bouncedAt',
              type: 'timestamp',
              isNullable: true,
            },
            {
              name: 'metadata',
              type: 'json',
              isNullable: true,
            },
            {
              name: 'note',
              type: 'text',
              isNullable: true,
            },
            {
              name: 'resolvedAt',
              type: 'timestamp',
              isNullable: true,
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

    const table = await queryRunner.getTable('bounce_recovery_candidates');
    if (table) {
      const addIndex = async (index: TableIndex) => {
        if (!table.indices.some((existing) => existing.name === index.name)) {
          await queryRunner.createIndex('bounce_recovery_candidates', index);
        }
      };

      await addIndex(new TableIndex({
        name: 'idx_bounce_recovery_status',
        columnNames: ['status'],
      }));
      await addIndex(new TableIndex({
        name: 'idx_bounce_recovery_bounced_email',
        columnNames: ['bouncedEmail'],
      }));
      await addIndex(new TableIndex({
        name: 'idx_bounce_recovery_suggested_email',
        columnNames: ['suggestedEmail'],
      }));
      await addIndex(new TableIndex({
        name: 'idx_bounce_recovery_email',
        columnNames: ['emailId'],
      }));
      await addIndex(new TableIndex({
        name: 'idx_bounce_recovery_customer',
        columnNames: ['customerId'],
      }));
      await addIndex(new TableIndex({
        name: 'idx_bounce_recovery_unique_pending',
        columnNames: ['bouncedEmail', 'suggestedEmail', 'status'],
        isUnique: true,
      }));

      if (!table.foreignKeys.some((fk) => fk.columnNames.includes('emailId'))) {
        await queryRunner.createForeignKey(
          'bounce_recovery_candidates',
          new TableForeignKey({
            columnNames: ['emailId'],
            referencedTableName: 'emails',
            referencedColumnNames: ['id'],
            onDelete: 'SET NULL',
          }),
        );
      }

      if (!table.foreignKeys.some((fk) => fk.columnNames.includes('customerId'))) {
        await queryRunner.createForeignKey(
          'bounce_recovery_candidates',
          new TableForeignKey({
            columnNames: ['customerId'],
            referencedTableName: 'customers',
            referencedColumnNames: ['id'],
            onDelete: 'SET NULL',
          }),
        );
      }
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    if (await queryRunner.hasTable('bounce_recovery_candidates')) {
      await queryRunner.dropTable('bounce_recovery_candidates', true, true, true);
    }
  }
}
