import { MigrationInterface, QueryRunner, Table, TableIndex } from 'typeorm';

export class CreateEmailsTable1714299600000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createTable(
      new Table({
        name: 'emails',
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
            isNullable: false,
          },
          // Metadata from import
          {
            name: 'firstName',
            type: 'varchar',
            length: '100',
            isNullable: true,
          },
          {
            name: 'lastName',
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
            name: 'country',
            type: 'varchar',
            length: '10',
            isNullable: true,
          },
          {
            name: 'city',
            type: 'varchar',
            length: '100',
            isNullable: true,
          },
          {
            name: 'acquisitionSource',
            type: 'varchar',
            length: '100',
            isNullable: true,
          },
          {
            name: 'acquisitionDate',
            type: 'date',
            isNullable: true,
          },
          {
            name: 'funnelStage',
            type: 'varchar',
            length: '50',
            isNullable: true,
          },
          // Verification layer results
          {
            name: 'hasValidSyntax',
            type: 'boolean',
            isNullable: true,
          },
          {
            name: 'hasValidDns',
            type: 'boolean',
            isNullable: true,
          },
          {
            name: 'hasValidSmtp',
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
          {
            name: 'hasTypo',
            type: 'boolean',
            isNullable: true,
          },
          {
            name: 'typoSuggestion',
            type: 'varchar',
            length: '255',
            isNullable: true,
          },
          // Aggregated status
          {
            name: 'verificationStatus',
            type: 'enum',
            enum: ['pending', 'valid', 'invalid', 'risky', 'disposable', 'unknown'],
            default: "'pending'",
          },
          {
            name: 'qualityScore',
            type: 'decimal',
            precision: 5,
            scale: 2,
            default: 0,
          },
          // SMTP details
          {
            name: 'smtpResultCode',
            type: 'varchar',
            length: '50',
            isNullable: true,
          },
          {
            name: 'smtpErrorMessage',
            type: 'text',
            isNullable: true,
          },
          // Timestamps
          {
            name: 'lastVerifiedAt',
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

    // Create indexes
    await queryRunner.createIndex(
      'emails',
      new TableIndex({
        name: 'idx_email_prefix',
        columnNames: ['email'],
        where: '',
      }),
    );

    await queryRunner.createIndex(
      'emails',
      new TableIndex({
        name: 'idx_verification_status',
        columnNames: ['verificationStatus'],
      }),
    );

    await queryRunner.createIndex(
      'emails',
      new TableIndex({
        name: 'idx_quality_score',
        columnNames: ['qualityScore'],
      }),
    );

    await queryRunner.createIndex(
      'emails',
      new TableIndex({
        name: 'idx_last_verified',
        columnNames: ['lastVerifiedAt'],
      }),
    );

    await queryRunner.createIndex(
      'emails',
      new TableIndex({
        name: 'idx_has_valid_syntax',
        columnNames: ['hasValidSyntax'],
      }),
    );

    await queryRunner.createIndex(
      'emails',
      new TableIndex({
        name: 'idx_has_valid_dns',
        columnNames: ['hasValidDns'],
      }),
    );

    await queryRunner.createIndex(
      'emails',
      new TableIndex({
        name: 'idx_is_disposable',
        columnNames: ['isDisposable'],
      }),
    );

    await queryRunner.createIndex(
      'emails',
      new TableIndex({
        name: 'idx_created_at',
        columnNames: ['createdAt'],
      }),
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropTable('emails');
  }
}
