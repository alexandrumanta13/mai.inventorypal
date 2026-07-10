import { MigrationInterface, QueryRunner } from 'typeorm';

export class BackfillAcceptedTypoEligibility1777651200000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    if (!(await queryRunner.hasTable('emails'))) {
      return;
    }

    await queryRunner.query(`
      UPDATE emails email
      SET email.doNotSendReason = 'typo_accepted_external_validation_required'
      WHERE email.hasTypo = true
        AND email.typoResolutionStatus = 'accepted'
        AND email.typoResolvedEmail IS NOT NULL
        AND email.sendEligibility = 'review'
        AND email.verificationStatus NOT IN ('invalid', 'disposable', 'unsubscribed')
        AND (email.gmailCategory IS NULL OR email.gmailCategory NOT IN ('bounce', 'unsubscribe', 'abuse'))
        AND (email.lastValidationSource IS NULL OR email.lastValidationSource IN ('internal', 'manual', 'unknown'))
        AND email.doNotSendReason IN ('risky', 'typo_pending', 'external_validation_internal_smtp_failed')
        AND NOT EXISTS (
          SELECT 1
          FROM email_validation_events event
          WHERE event.emailId = email.id
            AND event.provider IN ('zerobounce', 'neverbounce')
        )
    `);
  }

  public async down(): Promise<void> {
    // Data-only classification repair; original generic reasons cannot be restored safely.
  }
}
