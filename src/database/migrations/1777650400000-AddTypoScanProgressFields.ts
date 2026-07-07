import { MigrationInterface, QueryRunner, TableColumn, TableIndex } from 'typeorm';

export class AddTypoScanProgressFields1777650400000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    if (await queryRunner.hasTable('emails')) {
      if (!(await queryRunner.hasColumn('emails', 'typoScanStatus'))) {
        await queryRunner.addColumn(
          'emails',
          new TableColumn({
            name: 'typoScanStatus',
            type: 'enum',
            enum: ['clean', 'typo'],
            isNullable: true,
          }),
        );
      }

      if (!(await queryRunner.hasColumn('emails', 'typoScannedAt'))) {
        await queryRunner.addColumn(
          'emails',
          new TableColumn({
            name: 'typoScannedAt',
            type: 'timestamp',
            isNullable: true,
          }),
        );
      }

      await queryRunner.query(`
        UPDATE emails
        SET typoScanStatus = 'typo', typoScannedAt = COALESCE(lastVerifiedAt, updatedAt, UTC_TIMESTAMP())
        WHERE hasTypo = true
          AND typoScanStatus IS NULL
      `);

      await this.ensureIndex(queryRunner, 'emails', 'idx_email_typo_scan_progress', [
        'typoScannedAt',
        'id',
      ]);
    }

    if (await queryRunner.hasTable('customers')) {
      if (!(await queryRunner.hasColumn('customers', 'typo_scan_status'))) {
        await queryRunner.addColumn(
          'customers',
          new TableColumn({
            name: 'typo_scan_status',
            type: 'enum',
            enum: ['clean', 'typo'],
            isNullable: true,
          }),
        );
      }

      if (!(await queryRunner.hasColumn('customers', 'typo_scanned_at'))) {
        await queryRunner.addColumn(
          'customers',
          new TableColumn({
            name: 'typo_scanned_at',
            type: 'timestamp',
            isNullable: true,
          }),
        );
      }

      await this.ensureIndex(queryRunner, 'customers', 'idx_customer_typo_scan_progress', [
        'typo_scanned_at',
        'id',
      ]);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    if (await queryRunner.hasTable('emails')) {
      await this.dropIndexIfExists(queryRunner, 'emails', 'idx_email_typo_scan_progress');

      for (const columnName of ['typoScannedAt', 'typoScanStatus']) {
        if (await queryRunner.hasColumn('emails', columnName)) {
          await queryRunner.dropColumn('emails', columnName);
        }
      }
    }

    if (await queryRunner.hasTable('customers')) {
      await this.dropIndexIfExists(queryRunner, 'customers', 'idx_customer_typo_scan_progress');

      for (const columnName of ['typo_scanned_at', 'typo_scan_status']) {
        if (await queryRunner.hasColumn('customers', columnName)) {
          await queryRunner.dropColumn('customers', columnName);
        }
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
