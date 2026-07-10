import { MigrationInterface, QueryRunner, TableIndex } from 'typeorm';

export class AddValidationDashboardIndexes1777651100000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    if (!(await queryRunner.hasTable('emails'))) {
      return;
    }

    await this.ensureIndex(queryRunner, 'emails', 'idx_email_domain_status', [
      'email_domain',
      'verificationStatus',
    ]);
    await this.ensureIndex(queryRunner, 'emails', 'idx_email_send_eligibility_reason', [
      'sendEligibility',
      'doNotSendReason',
    ]);
    await this.ensureIndex(queryRunner, 'emails', 'idx_email_do_not_send_reason', [
      'doNotSendReason',
    ]);
    await this.ensureIndex(queryRunner, 'emails', 'idx_email_gmail_category', [
      'gmailCategory',
    ]);
    await this.ensureIndex(queryRunner, 'emails', 'idx_email_typo_review', [
      'hasTypo',
      'typoResolutionStatus',
    ]);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    if (!(await queryRunner.hasTable('emails'))) {
      return;
    }

    for (const indexName of [
      'idx_email_typo_review',
      'idx_email_gmail_category',
      'idx_email_do_not_send_reason',
      'idx_email_send_eligibility_reason',
      'idx_email_domain_status',
    ]) {
      await this.dropIndexIfExists(queryRunner, 'emails', indexName);
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
