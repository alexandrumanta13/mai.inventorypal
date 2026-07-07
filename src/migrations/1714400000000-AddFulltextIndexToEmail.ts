import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddFulltextIndexToEmail1714400000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    // Add FULLTEXT index for email column (better performance for LIKE '%search%')
    await queryRunner.query(
      `ALTER TABLE emails ADD FULLTEXT INDEX idx_email_fulltext (email)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE emails DROP INDEX idx_email_fulltext`);
  }
}
