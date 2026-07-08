import { MigrationInterface, QueryRunner } from 'typeorm';

export class MarkBounceRecoveryExternalValidation1777651000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    if (
      !(await queryRunner.hasTable('emails')) ||
      !(await queryRunner.hasTable('bounce_recovery_candidates'))
    ) {
      return;
    }

    await queryRunner.query(`
      UPDATE emails email
      INNER JOIN bounce_recovery_candidates recovery
        ON email.id = CAST(JSON_UNQUOTE(JSON_EXTRACT(recovery.metadata, '$.approvedEmailId')) AS UNSIGNED)
      SET
        email.hasTypo = true,
        email.typoSuggestion = recovery.bouncedEmail,
        email.typoResolutionStatus = 'accepted',
        email.typoResolvedEmail = recovery.suggestedEmail,
        email.typoResolvedAt = COALESCE(email.typoResolvedAt, recovery.resolvedAt, UTC_TIMESTAMP()),
        email.typoResolutionNote = COALESCE(
          email.typoResolutionNote,
          CONCAT('Bounce recovery approved (', recovery.reason, '); external validation required before marketing sends')
        ),
        email.sendEligibility = CASE
          WHEN email.verificationStatus IN ('invalid', 'disposable', 'unsubscribed')
            OR email.gmailCategory IN ('bounce', 'unsubscribe')
            THEN email.sendEligibility
          ELSE 'review'
        END,
        email.doNotSendReason = CASE
          WHEN email.verificationStatus IN ('invalid', 'disposable', 'unsubscribed')
            OR email.gmailCategory IN ('bounce', 'unsubscribe')
            THEN email.doNotSendReason
          ELSE 'typo_accepted_external_validation_required'
        END,
        email.smtpErrorMessage = CASE
          WHEN email.verificationStatus IN ('invalid', 'disposable', 'unsubscribed')
            OR email.gmailCategory IN ('bounce', 'unsubscribe')
            THEN email.smtpErrorMessage
          ELSE 'Bounce recovery approved; external validation required before marketing sends'
        END,
        email.lastValidationSource = COALESCE(email.lastValidationSource, 'internal'),
        email.lastValidationAt = COALESCE(email.lastValidationAt, UTC_TIMESTAMP())
      WHERE recovery.status = 'approved'
    `);
  }

  public async down(): Promise<void> {
    // Data-only safety marker; intentionally not reverted.
  }
}
