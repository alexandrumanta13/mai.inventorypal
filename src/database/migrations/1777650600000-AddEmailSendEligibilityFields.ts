import { MigrationInterface, QueryRunner, TableColumn, TableIndex } from 'typeorm';

export class AddEmailSendEligibilityFields1777650600000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    if (!(await queryRunner.hasTable('emails'))) {
      return;
    }

    if (!(await queryRunner.hasColumn('emails', 'sendEligibility'))) {
      await queryRunner.addColumn(
        'emails',
        new TableColumn({
          name: 'sendEligibility',
          type: 'enum',
          enum: ['pending', 'safe_to_send', 'review', 'do_not_send'],
          default: "'pending'",
        }),
      );
    }

    if (!(await queryRunner.hasColumn('emails', 'doNotSendReason'))) {
      await queryRunner.addColumn(
        'emails',
        new TableColumn({
          name: 'doNotSendReason',
          type: 'varchar',
          length: '100',
          isNullable: true,
        }),
      );
    }

    if (!(await queryRunner.hasColumn('emails', 'lastValidationSource'))) {
      await queryRunner.addColumn(
        'emails',
        new TableColumn({
          name: 'lastValidationSource',
          type: 'enum',
          enum: ['internal', 'zerobounce', 'neverbounce', 'elastic_email', 'manual', 'unknown'],
          isNullable: true,
        }),
      );
    }

    if (!(await queryRunner.hasColumn('emails', 'lastValidationAt'))) {
      await queryRunner.addColumn(
        'emails',
        new TableColumn({
          name: 'lastValidationAt',
          type: 'timestamp',
          isNullable: true,
        }),
      );
    }

    await queryRunner.query(`
      UPDATE emails
      SET
        sendEligibility = CASE
          WHEN gmailCategory = 'unsubscribe' OR verificationStatus = 'unsubscribed' THEN 'do_not_send'
          WHEN gmailCategory = 'bounce' OR verificationStatus = 'invalid' THEN 'do_not_send'
          WHEN verificationStatus = 'disposable' OR isDisposable = true THEN 'do_not_send'
          WHEN hasTypo = true AND typoResolutionStatus = 'ignored' THEN 'do_not_send'
          WHEN gmailCategory = 'abuse' THEN 'review'
          WHEN hasTypo = true THEN 'review'
          WHEN verificationStatus = 'risky' OR isRoleBased = true THEN 'review'
          WHEN verificationStatus = 'unknown' THEN 'review'
          WHEN verificationStatus = 'valid'
            AND COALESCE(qualityScore, 0) >= 60
            AND (hasTypo IS NULL OR hasTypo = false)
            AND (isDisposable IS NULL OR isDisposable = false)
            AND (isRoleBased IS NULL OR isRoleBased = false)
            THEN 'safe_to_send'
          ELSE 'pending'
        END,
        doNotSendReason = CASE
          WHEN gmailCategory = 'unsubscribe' OR verificationStatus = 'unsubscribed' THEN 'unsubscribed'
          WHEN gmailCategory = 'bounce' THEN 'bounce'
          WHEN verificationStatus = 'invalid' THEN 'invalid'
          WHEN verificationStatus = 'disposable' OR isDisposable = true THEN 'disposable'
          WHEN hasTypo = true AND typoResolutionStatus = 'ignored' THEN 'typo_ignored'
          WHEN gmailCategory = 'abuse' THEN 'abuse_detected'
          WHEN hasTypo = true AND typoResolutionStatus = 'accepted' THEN 'typo_accepted_external_validation_required'
          WHEN hasTypo = true THEN 'typo_pending'
          WHEN verificationStatus = 'risky' THEN 'risky'
          WHEN isRoleBased = true THEN 'role_based'
          WHEN verificationStatus = 'unknown' THEN 'unknown'
          WHEN verificationStatus = 'valid' AND COALESCE(qualityScore, 0) < 60 THEN 'low_quality_score'
          ELSE NULL
        END,
        lastValidationSource = COALESCE(lastValidationSource, 'internal'),
        lastValidationAt = COALESCE(lastValidationAt, lastVerifiedAt, lastGmailScanDate, updatedAt, UTC_TIMESTAMP())
    `);

    await this.ensureIndex(queryRunner, 'emails', 'idx_email_send_eligibility', [
      'sendEligibility',
    ]);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    if (!(await queryRunner.hasTable('emails'))) {
      return;
    }

    await this.dropIndexIfExists(queryRunner, 'emails', 'idx_email_send_eligibility');

    for (const columnName of [
      'lastValidationAt',
      'lastValidationSource',
      'doNotSendReason',
      'sendEligibility',
    ]) {
      if (await queryRunner.hasColumn('emails', columnName)) {
        await queryRunner.dropColumn('emails', columnName);
      }
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
}
