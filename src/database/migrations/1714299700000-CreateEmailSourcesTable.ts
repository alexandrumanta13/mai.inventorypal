import { MigrationInterface, QueryRunner, Table, TableIndex, TableForeignKey } from 'typeorm';

export class CreateEmailSourcesTable1714299700000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createTable(
      new Table({
        name: 'email_sources',
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
            isNullable: false,
          },
          {
            name: 'sourceType',
            type: 'enum',
            enum: ['json_import', 'inventorypal_order', 'manual', 'api'],
            isNullable: false,
          },
          {
            name: 'sourceIdentifier',
            type: 'varchar',
            length: '255',
            isNullable: true,
          },
          {
            name: 'consentGiven',
            type: 'boolean',
            default: true,
          },
          {
            name: 'consentTimestamp',
            type: 'timestamp',
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
      'email_sources',
      new TableIndex({
        name: 'idx_email',
        columnNames: ['emailId'],
      }),
    );

    await queryRunner.createIndex(
      'email_sources',
      new TableIndex({
        name: 'idx_source_type',
        columnNames: ['sourceType'],
      }),
    );

    // Create foreign key
    await queryRunner.createForeignKey(
      'email_sources',
      new TableForeignKey({
        columnNames: ['emailId'],
        referencedColumnNames: ['id'],
        referencedTableName: 'emails',
        onDelete: 'CASCADE',
      }),
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropTable('email_sources');
  }
}
