import { MigrationInterface, QueryRunner, Table, TableForeignKey, TableIndex } from 'typeorm';

export class CreateEmailValidationTables1777650500000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    if (!(await queryRunner.hasTable('email_validation_batches'))) {
      await queryRunner.createTable(
        new Table({
          name: 'email_validation_batches',
          columns: [
            {
              name: 'id',
              type: 'bigint',
              isPrimary: true,
              isGenerated: true,
              generationStrategy: 'increment',
            },
            {
              name: 'provider',
              type: 'enum',
              enum: ['internal', 'zerobounce', 'neverbounce', 'elastic_email', 'manual', 'unknown'],
              default: "'unknown'",
            },
            {
              name: 'status',
              type: 'enum',
              enum: ['draft', 'queued', 'submitted', 'running', 'completed', 'failed', 'cancelled'],
              default: "'draft'",
            },
            {
              name: 'sourceSegment',
              type: 'enum',
              enum: [
                'supplikit_intake',
                'existing_domain',
                'typo_resolved',
                'bounce_recovery',
                'manual',
                'csv_import',
                'unknown',
              ],
              default: "'unknown'",
            },
            {
              name: 'name',
              type: 'varchar',
              length: '255',
              isNullable: true,
            },
            {
              name: 'providerJobId',
              type: 'varchar',
              length: '255',
              isNullable: true,
            },
            {
              name: 'sourceDomain',
              type: 'varchar',
              length: '100',
              isNullable: true,
            },
            {
              name: 'sourceFilter',
              type: 'json',
              isNullable: true,
            },
            {
              name: 'totalRecords',
              type: 'int',
              default: 0,
            },
            {
              name: 'submittedRecords',
              type: 'int',
              default: 0,
            },
            {
              name: 'processedRecords',
              type: 'int',
              default: 0,
            },
            {
              name: 'validCount',
              type: 'int',
              default: 0,
            },
            {
              name: 'invalidCount',
              type: 'int',
              default: 0,
            },
            {
              name: 'riskyCount',
              type: 'int',
              default: 0,
            },
            {
              name: 'unknownCount',
              type: 'int',
              default: 0,
            },
            {
              name: 'catchAllCount',
              type: 'int',
              default: 0,
            },
            {
              name: 'disposableCount',
              type: 'int',
              default: 0,
            },
            {
              name: 'metadata',
              type: 'json',
              isNullable: true,
            },
            {
              name: 'errorMessage',
              type: 'text',
              isNullable: true,
            },
            {
              name: 'submittedAt',
              type: 'timestamp',
              isNullable: true,
            },
            {
              name: 'completedAt',
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

      await this.ensureIndex(queryRunner, 'email_validation_batches', 'idx_email_validation_batch_provider', [
        'provider',
      ]);
      await this.ensureIndex(queryRunner, 'email_validation_batches', 'idx_email_validation_batch_status', [
        'status',
      ]);
      await this.ensureIndex(queryRunner, 'email_validation_batches', 'idx_email_validation_batch_segment', [
        'sourceSegment',
      ]);
      await this.ensureIndex(
        queryRunner,
        'email_validation_batches',
        'idx_email_validation_batch_provider_job',
        ['provider', 'providerJobId'],
      );
    }

    if (!(await queryRunner.hasTable('email_validation_events'))) {
      await queryRunner.createTable(
        new Table({
          name: 'email_validation_events',
          columns: [
            {
              name: 'id',
              type: 'bigint',
              isPrimary: true,
              isGenerated: true,
              generationStrategy: 'increment',
            },
            {
              name: 'batchId',
              type: 'bigint',
              isNullable: true,
            },
            {
              name: 'emailId',
              type: 'bigint',
              isNullable: true,
            },
            {
              name: 'provider',
              type: 'enum',
              enum: ['internal', 'zerobounce', 'neverbounce', 'elastic_email', 'manual', 'unknown'],
              default: "'unknown'",
            },
            {
              name: 'inputEmail',
              type: 'varchar',
              length: '255',
            },
            {
              name: 'normalizedEmail',
              type: 'varchar',
              length: '255',
            },
            {
              name: 'correctedEmail',
              type: 'varchar',
              length: '255',
              isNullable: true,
            },
            {
              name: 'providerStatus',
              type: 'varchar',
              length: '100',
              isNullable: true,
            },
            {
              name: 'providerSubStatus',
              type: 'varchar',
              length: '100',
              isNullable: true,
            },
            {
              name: 'mappedStatus',
              type: 'enum',
              enum: [
                'pending',
                'valid',
                'invalid',
                'risky',
                'disposable',
                'unknown',
                'catch_all',
                'do_not_mail',
                'spamtrap',
                'abuse',
              ],
              default: "'pending'",
            },
            {
              name: 'sendEligibility',
              type: 'enum',
              enum: ['pending', 'safe_to_send', 'review', 'do_not_send'],
              default: "'pending'",
            },
            {
              name: 'reasonCode',
              type: 'varchar',
              length: '100',
              isNullable: true,
            },
            {
              name: 'confidenceScore',
              type: 'decimal',
              precision: 5,
              scale: 2,
              isNullable: true,
            },
            {
              name: 'rawResponse',
              type: 'json',
              isNullable: true,
            },
            {
              name: 'validatedAt',
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

      await this.ensureIndex(queryRunner, 'email_validation_events', 'idx_email_validation_event_batch', [
        'batchId',
      ]);
      await this.ensureIndex(queryRunner, 'email_validation_events', 'idx_email_validation_event_email', [
        'emailId',
      ]);
      await this.ensureIndex(
        queryRunner,
        'email_validation_events',
        'idx_email_validation_event_provider_status',
        ['provider', 'providerStatus'],
      );
      await this.ensureIndex(
        queryRunner,
        'email_validation_events',
        'idx_email_validation_event_normalized',
        ['normalizedEmail'],
      );
      await this.ensureIndex(
        queryRunner,
        'email_validation_events',
        'idx_email_validation_event_eligibility',
        ['sendEligibility'],
      );
      await this.ensureIndex(
        queryRunner,
        'email_validation_events',
        'idx_email_validation_event_validated_at',
        ['validatedAt'],
      );

      if (await queryRunner.hasTable('email_validation_batches')) {
        await queryRunner.createForeignKey(
          'email_validation_events',
          new TableForeignKey({
            columnNames: ['batchId'],
            referencedColumnNames: ['id'],
            referencedTableName: 'email_validation_batches',
            onDelete: 'SET NULL',
          }),
        );
      }

      if (await queryRunner.hasTable('emails')) {
        await queryRunner.createForeignKey(
          'email_validation_events',
          new TableForeignKey({
            columnNames: ['emailId'],
            referencedColumnNames: ['id'],
            referencedTableName: 'emails',
            onDelete: 'SET NULL',
          }),
        );
      }
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    if (await queryRunner.hasTable('email_validation_events')) {
      await queryRunner.dropTable('email_validation_events');
    }

    if (await queryRunner.hasTable('email_validation_batches')) {
      await queryRunner.dropTable('email_validation_batches');
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
}
