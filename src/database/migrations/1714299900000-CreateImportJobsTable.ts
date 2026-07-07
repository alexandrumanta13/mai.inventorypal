import { MigrationInterface, QueryRunner, Table, TableIndex } from 'typeorm';

export class CreateImportJobsTable1714299900000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createTable(
      new Table({
        name: 'import_jobs',
        columns: [
          {
            name: 'id',
            type: 'int',
            isPrimary: true,
            isGenerated: true,
            generationStrategy: 'increment',
          },
          {
            name: 'sourceType',
            type: 'enum',
            enum: ['json_pages', 'inventorypal', 'csv'],
            isNullable: false,
          },
          {
            name: 'status',
            type: 'enum',
            enum: ['pending', 'running', 'completed', 'failed'],
            default: "'pending'",
          },
          // Progress tracking
          {
            name: 'totalFiles',
            type: 'int',
            default: 0,
          },
          {
            name: 'processedFiles',
            type: 'int',
            default: 0,
          },
          {
            name: 'totalRecords',
            type: 'int',
            default: 0,
          },
          {
            name: 'processedRecords',
            type: 'int',
            default: 0,
          },
          {
            name: 'importedEmails',
            type: 'int',
            default: 0,
          },
          {
            name: 'duplicateEmails',
            type: 'int',
            default: 0,
          },
          {
            name: 'invalidEmails',
            type: 'int',
            default: 0,
          },
          // Timing
          {
            name: 'startedAt',
            type: 'timestamp',
            isNullable: true,
          },
          {
            name: 'completedAt',
            type: 'timestamp',
            isNullable: true,
          },
          {
            name: 'errorMessage',
            type: 'text',
            isNullable: true,
          },
          {
            name: 'createdAt',
            type: 'timestamp',
            default: 'CURRENT_TIMESTAMP',
          },
        ],
      }),
      true,
    );

    // Create indexes
    await queryRunner.createIndex(
      'import_jobs',
      new TableIndex({
        name: 'idx_status',
        columnNames: ['status'],
      }),
    );

    await queryRunner.createIndex(
      'import_jobs',
      new TableIndex({
        name: 'idx_source_type',
        columnNames: ['sourceType'],
      }),
    );

    await queryRunner.createIndex(
      'import_jobs',
      new TableIndex({
        name: 'idx_created_at',
        columnNames: ['createdAt'],
      }),
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropTable('import_jobs');
  }
}
