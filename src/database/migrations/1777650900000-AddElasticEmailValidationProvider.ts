import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddElasticEmailValidationProvider1777650900000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await this.extendProviderEnum(queryRunner, 'email_validation_batches', 'provider', "'unknown'", false);
    await this.extendProviderEnum(queryRunner, 'email_validation_events', 'provider', "'unknown'", false);
    await this.extendProviderEnum(queryRunner, 'emails', 'lastValidationSource', null, true);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Keep the enum value on rollback so existing audit history is not made invalid.
  }

  private async extendProviderEnum(
    queryRunner: QueryRunner,
    tableName: string,
    columnName: string,
    defaultValue: string | null,
    nullable: boolean,
  ): Promise<void> {
    if (!(await queryRunner.hasTable(tableName)) || !(await queryRunner.hasColumn(tableName, columnName))) {
      return;
    }

    const nullSql = nullable ? 'NULL' : 'NOT NULL';
    const defaultSql = defaultValue ? ` DEFAULT ${defaultValue}` : '';
    await queryRunner.query(`
      ALTER TABLE \`${tableName}\`
      MODIFY \`${columnName}\` ENUM(
        'internal',
        'zerobounce',
        'neverbounce',
        'elastic_email',
        'manual',
        'unknown'
      ) ${nullSql}${defaultSql}
    `);
  }
}
