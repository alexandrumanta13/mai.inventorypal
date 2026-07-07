import { MigrationInterface, QueryRunner, TableColumn, TableIndex } from 'typeorm';

export class AddTypoResolutionFields1777650300000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    if (!(await queryRunner.hasTable('emails'))) {
      return;
    }

    if (!(await queryRunner.hasColumn('emails', 'typoResolutionStatus'))) {
      await queryRunner.addColumn(
        'emails',
        new TableColumn({
          name: 'typoResolutionStatus',
          type: 'enum',
          enum: ['pending', 'accepted', 'ignored'],
          isNullable: true,
        }),
      );
    }

    if (!(await queryRunner.hasColumn('emails', 'typoResolvedEmail'))) {
      await queryRunner.addColumn(
        'emails',
        new TableColumn({
          name: 'typoResolvedEmail',
          type: 'varchar',
          length: '255',
          isNullable: true,
        }),
      );
    }

    if (!(await queryRunner.hasColumn('emails', 'typoResolvedAt'))) {
      await queryRunner.addColumn(
        'emails',
        new TableColumn({
          name: 'typoResolvedAt',
          type: 'timestamp',
          isNullable: true,
        }),
      );
    }

    if (!(await queryRunner.hasColumn('emails', 'typoResolutionNote'))) {
      await queryRunner.addColumn(
        'emails',
        new TableColumn({
          name: 'typoResolutionNote',
          type: 'text',
          isNullable: true,
        }),
      );
    }

    await queryRunner.query(`
      UPDATE emails
      SET typoResolutionStatus = 'pending'
      WHERE hasTypo = true
        AND typoSuggestion IS NOT NULL
        AND typoSuggestion <> ''
        AND typoResolutionStatus IS NULL
    `);

    await this.ensureIndex(queryRunner, 'emails', 'idx_email_typo_resolution', [
      'typoResolutionStatus',
    ]);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    if (!(await queryRunner.hasTable('emails'))) {
      return;
    }

    await this.dropIndexIfExists(queryRunner, 'emails', 'idx_email_typo_resolution');

    for (const columnName of [
      'typoResolutionNote',
      'typoResolvedAt',
      'typoResolvedEmail',
      'typoResolutionStatus',
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
