import { MigrationInterface, QueryRunner, Table, TableIndex, TableForeignKey } from 'typeorm';

export class CreateVerificationHistoryTable1714299800000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createTable(
      new Table({
        name: 'verification_history',
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
          // Layer results
          {
            name: 'syntaxValid',
            type: 'boolean',
            isNullable: true,
          },
          {
            name: 'dnsValid',
            type: 'boolean',
            isNullable: true,
          },
          {
            name: 'smtpValid',
            type: 'boolean',
            isNullable: true,
          },
          {
            name: 'isDisposable',
            type: 'boolean',
            isNullable: true,
          },
          {
            name: 'isRoleBased',
            type: 'boolean',
            isNullable: true,
          },
          // Final result
          {
            name: 'finalStatus',
            type: 'enum',
            enum: ['valid', 'invalid', 'risky', 'disposable', 'unknown'],
            isNullable: false,
          },
          {
            name: 'qualityScore',
            type: 'decimal',
            precision: 5,
            scale: 2,
            isNullable: true,
          },
          // Audit details
          {
            name: 'verificationDetails',
            type: 'json',
            isNullable: true,
          },
          {
            name: 'durationMs',
            type: 'int',
            isNullable: true,
          },
          {
            name: 'verifiedAt',
            type: 'timestamp',
            default: 'CURRENT_TIMESTAMP',
          },
        ],
      }),
      true,
    );

    // Create indexes
    await queryRunner.createIndex(
      'verification_history',
      new TableIndex({
        name: 'idx_email',
        columnNames: ['emailId'],
      }),
    );

    await queryRunner.createIndex(
      'verification_history',
      new TableIndex({
        name: 'idx_verified_at',
        columnNames: ['verifiedAt'],
      }),
    );

    await queryRunner.createIndex(
      'verification_history',
      new TableIndex({
        name: 'idx_final_status',
        columnNames: ['finalStatus'],
      }),
    );

    // Create foreign key
    await queryRunner.createForeignKey(
      'verification_history',
      new TableForeignKey({
        columnNames: ['emailId'],
        referencedColumnNames: ['id'],
        referencedTableName: 'emails',
        onDelete: 'CASCADE',
      }),
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropTable('verification_history');
  }
}
