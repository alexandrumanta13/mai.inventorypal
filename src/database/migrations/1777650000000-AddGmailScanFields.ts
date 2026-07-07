import { MigrationInterface, QueryRunner, TableColumn, TableIndex } from 'typeorm';

export class AddGmailScanFields1777650000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    if (!(await queryRunner.hasColumn('emails', 'fullName'))) {
      await queryRunner.addColumn(
        'emails',
        new TableColumn({
          name: 'fullName',
          type: 'varchar',
          length: '255',
          isNullable: true,
        }),
      );
    }

    if (!(await queryRunner.hasColumn('emails', 'lastGmailScanDate'))) {
      await queryRunner.addColumn(
        'emails',
        new TableColumn({
          name: 'lastGmailScanDate',
          type: 'timestamp',
          isNullable: true,
        }),
      );
    }

    if (!(await queryRunner.hasColumn('emails', 'gmailMessageDate'))) {
      await queryRunner.addColumn(
        'emails',
        new TableColumn({
          name: 'gmailMessageDate',
          type: 'timestamp',
          isNullable: true,
          comment: 'Data când a fost trimis emailul (pentru win-back campaigns)',
        }),
      );
    }

    if (!(await queryRunner.hasColumn('emails', 'gmailCategory'))) {
      await queryRunner.query(`
        ALTER TABLE emails
        ADD COLUMN gmailCategory ENUM('unsubscribe', 'order', 'abuse', 'bounce', 'clean') NULL
      `);
    }

    await this.ensureIndex(queryRunner, 'idx_gmail_category', ['gmailCategory']);
    await this.ensureIndex(queryRunner, 'idx_gmail_message_date', ['gmailMessageDate']);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await this.dropIndexIfExists(queryRunner, 'idx_gmail_message_date');
    await this.dropIndexIfExists(queryRunner, 'idx_gmail_category');

    if (await queryRunner.hasColumn('emails', 'gmailCategory')) {
      await queryRunner.dropColumn('emails', 'gmailCategory');
    }
    if (await queryRunner.hasColumn('emails', 'gmailMessageDate')) {
      await queryRunner.dropColumn('emails', 'gmailMessageDate');
    }
    if (await queryRunner.hasColumn('emails', 'lastGmailScanDate')) {
      await queryRunner.dropColumn('emails', 'lastGmailScanDate');
    }
    if (await queryRunner.hasColumn('emails', 'fullName')) {
      await queryRunner.dropColumn('emails', 'fullName');
    }
  }

  private async ensureIndex(
    queryRunner: QueryRunner,
    indexName: string,
    columnNames: string[],
  ): Promise<void> {
    const table = await queryRunner.getTable('emails');
    if (!table || table.indices.some((index) => index.name === indexName)) {
      return;
    }

    await queryRunner.createIndex(
      'emails',
      new TableIndex({
        name: indexName,
        columnNames,
      }),
    );
  }

  private async dropIndexIfExists(queryRunner: QueryRunner, indexName: string): Promise<void> {
    const table = await queryRunner.getTable('emails');
    const index = table?.indices.find((existingIndex) => existingIndex.name === indexName);

    if (index) {
      await queryRunner.dropIndex('emails', index);
    }
  }
}
