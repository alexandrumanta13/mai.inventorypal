import { MigrationInterface, QueryRunner } from 'typeorm';

export class ReclassifyExternalValidationReviewSignals1777651300000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    if (
      !(await queryRunner.hasTable('emails'))
      || !(await queryRunner.hasTable('email_validation_events'))
    ) {
      return;
    }

    await queryRunner.query(`
      UPDATE email_validation_events event
      SET event.rawResponse = JSON_SET(
            COALESCE(event.rawResponse, JSON_OBJECT()),
            '$.inventorypalPolicy.originalMappedStatus', event.mappedStatus,
            '$.inventorypalPolicy.reclassifiedReason', 'temporary_provider_signal'
          ),
          event.mappedStatus = 'risky',
          event.sendEligibility = 'review',
          event.reasonCode = CONCAT(
            'external_validation_temporary_',
            LOWER(event.providerSubStatus)
          )
      WHERE event.provider = 'zerobounce'
        AND LOWER(event.providerSubStatus) IN (
          'antispam_system',
          'exception_occurred',
          'failed_smtp_connection',
          'forcible_disconnect',
          'greylisted',
          'mail_server_did_not_respond',
          'mail_server_temporary_error',
          'mailbox_quota_exceeded',
          'timeout_exceeded'
        )
    `);

    await queryRunner.query(`
      UPDATE email_validation_events event
      SET event.rawResponse = JSON_SET(
            COALESCE(event.rawResponse, JSON_OBJECT()),
            '$.inventorypalPolicy.originalMappedStatus', event.mappedStatus,
            '$.inventorypalPolicy.reclassifiedReason', 'public_mailbox_disposable_conflict'
          ),
          event.mappedStatus = 'risky',
          event.sendEligibility = 'review',
          event.reasonCode = 'external_validation_suspect_public_disposable'
      WHERE event.provider = 'zerobounce'
        AND LOWER(event.providerSubStatus) = 'disposable'
        AND LOWER(SUBSTRING_INDEX(event.inputEmail, '@', -1)) IN (${this.publicMailboxDomainsSql()})
    `);

    await queryRunner.query(`
      UPDATE emails email
      INNER JOIN email_validation_events event
        ON event.emailId = email.id
       AND event.provider = 'zerobounce'
      LEFT JOIN email_validation_events newer
        ON newer.emailId = email.id
       AND newer.id > event.id
      SET email.verificationStatus = 'risky',
          email.qualityScore = 40,
          email.hasValidSmtp = false,
          email.sendEligibility = 'review',
          email.doNotSendReason = event.reasonCode,
          email.smtpErrorMessage = CONCAT(
            'External validation requires policy review: ',
            event.providerSubStatus
          )
      WHERE newer.id IS NULL
        AND email.lastValidationSource = 'zerobounce'
        AND email.verificationStatus <> 'unsubscribed'
        AND (email.gmailCategory IS NULL OR email.gmailCategory NOT IN ('unsubscribe', 'abuse'))
        AND event.reasonCode LIKE 'external_validation_temporary_%'
    `);

    await queryRunner.query(`
      UPDATE emails email
      INNER JOIN email_validation_events event
        ON event.emailId = email.id
       AND event.provider = 'zerobounce'
      LEFT JOIN email_validation_events newer
        ON newer.emailId = email.id
       AND newer.id > event.id
      SET email.verificationStatus = 'risky',
          email.qualityScore = 40,
          email.hasValidSmtp = false,
          email.isDisposable = false,
          email.sendEligibility = 'review',
          email.doNotSendReason = 'external_validation_suspect_public_disposable',
          email.smtpErrorMessage = 'External validation requires policy review: public mailbox marked disposable'
      WHERE newer.id IS NULL
        AND email.lastValidationSource = 'zerobounce'
        AND email.verificationStatus <> 'unsubscribed'
        AND (email.gmailCategory IS NULL OR email.gmailCategory NOT IN ('unsubscribe', 'abuse'))
        AND event.reasonCode = 'external_validation_suspect_public_disposable'
    `);

    await this.refreshBatchCounts(queryRunner);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    if (
      !(await queryRunner.hasTable('emails'))
      || !(await queryRunner.hasTable('email_validation_events'))
    ) {
      return;
    }

    await queryRunner.query(`
      UPDATE emails
      SET verificationStatus = 'invalid',
          qualityScore = 0,
          sendEligibility = 'do_not_send',
          doNotSendReason = 'external_validation_invalid',
          smtpErrorMessage = 'External validation blocked email: invalid'
      WHERE lastValidationSource = 'zerobounce'
        AND doNotSendReason LIKE 'external_validation_temporary_%'
    `);

    await queryRunner.query(`
      UPDATE emails
      SET verificationStatus = 'invalid',
          qualityScore = 0,
          sendEligibility = 'do_not_send',
          doNotSendReason = 'external_validation_do_not_mail',
          smtpErrorMessage = 'External validation blocked email: do_not_mail'
      WHERE lastValidationSource = 'zerobounce'
        AND doNotSendReason = 'external_validation_suspect_public_disposable'
    `);

    await queryRunner.query(`
      UPDATE email_validation_events
      SET mappedStatus = 'invalid',
          sendEligibility = 'do_not_send',
          reasonCode = 'external_validation_invalid',
          rawResponse = JSON_REMOVE(
            rawResponse,
            '$.inventorypalPolicy.originalMappedStatus',
            '$.inventorypalPolicy.reclassifiedReason'
          )
      WHERE provider = 'zerobounce'
        AND reasonCode LIKE 'external_validation_temporary_%'
    `);

    await queryRunner.query(`
      UPDATE email_validation_events
      SET mappedStatus = 'do_not_mail',
          sendEligibility = 'do_not_send',
          reasonCode = 'external_validation_do_not_mail',
          rawResponse = JSON_REMOVE(
            rawResponse,
            '$.inventorypalPolicy.originalMappedStatus',
            '$.inventorypalPolicy.reclassifiedReason'
          )
      WHERE provider = 'zerobounce'
        AND reasonCode = 'external_validation_suspect_public_disposable'
    `);

    await this.refreshBatchCounts(queryRunner);
  }

  private async refreshBatchCounts(queryRunner: QueryRunner): Promise<void> {
    if (!(await queryRunner.hasTable('email_validation_batches'))) {
      return;
    }

    await queryRunner.query(`
      UPDATE email_validation_batches batch
      SET batch.validCount = (
            SELECT COUNT(*) FROM email_validation_events event
            WHERE event.batchId = batch.id AND event.mappedStatus = 'valid'
          ),
          batch.invalidCount = (
            SELECT COUNT(*) FROM email_validation_events event
            WHERE event.batchId = batch.id AND event.mappedStatus = 'invalid'
          ),
          batch.riskyCount = (
            SELECT COUNT(*) FROM email_validation_events event
            WHERE event.batchId = batch.id AND event.mappedStatus = 'risky'
          ),
          batch.unknownCount = (
            SELECT COUNT(*) FROM email_validation_events event
            WHERE event.batchId = batch.id AND event.mappedStatus = 'unknown'
          ),
          batch.catchAllCount = (
            SELECT COUNT(*) FROM email_validation_events event
            WHERE event.batchId = batch.id AND event.mappedStatus = 'catch_all'
          ),
          batch.disposableCount = (
            SELECT COUNT(*) FROM email_validation_events event
            WHERE event.batchId = batch.id AND event.mappedStatus = 'disposable'
          )
      WHERE batch.provider = 'zerobounce'
    `);
  }

  private publicMailboxDomainsSql(): string {
    return [
      'gmail.com',
      'googlemail.com',
      'yahoo.com',
      'yahoo.ro',
      'ymail.com',
      'rocketmail.com',
      'hotmail.com',
      'outlook.com',
      'live.com',
      'icloud.com',
      'me.com',
      'protonmail.com',
      'proton.me',
      'aol.com',
      'msn.com',
      'mac.com',
      'mail.com',
      'gmx.com',
      'gmx.net',
    ].map((domain) => `'${domain}'`).join(', ');
  }
}
