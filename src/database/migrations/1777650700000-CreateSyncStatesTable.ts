import { MigrationInterface, QueryRunner, Table, TableIndex } from 'typeorm';

export class CreateSyncStatesTable1777650700000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    if (await queryRunner.hasTable('sync_states')) {
      return;
    }

    await queryRunner.createTable(
      new Table({
        name: 'sync_states',
        columns: [
          {
            name: 'id',
            type: 'int',
            isPrimary: true,
            isGenerated: true,
            generationStrategy: 'increment',
          },
          {
            name: 'syncKey',
            type: 'varchar',
            length: '100',
          },
          {
            name: 'sourceType',
            type: 'varchar',
            length: '50',
          },
          {
            name: 'status',
            type: 'enum',
            enum: ['idle', 'running', 'failed'],
            default: "'idle'",
          },
          {
            name: 'lastAttemptedSyncAt',
            type: 'timestamp',
            isNullable: true,
          },
          {
            name: 'lastSuccessfulSyncAt',
            type: 'timestamp',
            isNullable: true,
          },
          {
            name: 'lastCompletedAt',
            type: 'timestamp',
            isNullable: true,
          },
          {
            name: 'lastOrderDate',
            type: 'timestamp',
            isNullable: true,
          },
          {
            name: 'lastOrderId',
            type: 'bigint',
            isNullable: true,
          },
          {
            name: 'lastJobId',
            type: 'int',
            isNullable: true,
          },
          {
            name: 'lastRowsSeen',
            type: 'int',
            default: 0,
          },
          {
            name: 'lastImportedEmails',
            type: 'int',
            default: 0,
          },
          {
            name: 'lastDuplicateEmails',
            type: 'int',
            default: 0,
          },
          {
            name: 'lastInvalidEmails',
            type: 'int',
            default: 0,
          },
          {
            name: 'overlapDays',
            type: 'int',
            default: 7,
          },
          {
            name: 'maxRecoveryDays',
            type: 'int',
            default: 365,
          },
          {
            name: 'lastErrorMessage',
            type: 'text',
            isNullable: true,
          },
          {
            name: 'metadata',
            type: 'json',
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

    await this.ensureIndex(queryRunner, 'idx_sync_state_key', ['syncKey'], true);
    await this.ensureIndex(queryRunner, 'idx_sync_state_source', ['sourceType']);
    await this.ensureIndex(queryRunner, 'idx_sync_state_status', ['status']);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    if (await queryRunner.hasTable('sync_states')) {
      await queryRunner.dropTable('sync_states');
    }
  }

  private async ensureIndex(
    queryRunner: QueryRunner,
    name: string,
    columnNames: string[],
    isUnique = false,
  ): Promise<void> {
    const table = await queryRunner.getTable('sync_states');
    const exists = table?.indices.some((index) => index.name === name);

    if (!exists) {
      await queryRunner.createIndex(
        'sync_states',
        new TableIndex({
          name,
          columnNames,
          isUnique,
        }),
      );
    }
  }
}
