import { ExternalValidationProvider, SendEligibility } from '@shared/enums/email-validation.enum';
import { VerificationStatus } from '@shared/enums/verification-status.enum';
import { SendEligibilityService } from './send-eligibility.service';

describe('SendEligibilityService', () => {
  let service: SendEligibilityService;

  beforeEach(() => {
    service = new SendEligibilityService();
  });

  it('keeps unsubscribed emails out of sending', () => {
    expect(
      service.calculate({
        verificationStatus: VerificationStatus.UNSUBSCRIBED,
      }),
    ).toEqual({
      sendEligibility: SendEligibility.DO_NOT_SEND,
      doNotSendReason: 'unsubscribed',
    });
  });

  it('lets bounce win over a previous unsubscribe for deliverability', () => {
    expect(
      service.calculate({
        verificationStatus: VerificationStatus.INVALID,
        previousVerificationStatus: VerificationStatus.UNSUBSCRIBED,
        gmailCategory: 'bounce',
      }),
    ).toEqual({
      sendEligibility: SendEligibility.DO_NOT_SEND,
      doNotSendReason: 'bounce_after_unsubscribe',
    });
  });

  it('routes pending typo candidates to review', () => {
    expect(
      service.calculate({
        verificationStatus: VerificationStatus.PENDING,
        hasTypo: true,
        typoResolutionStatus: 'pending',
      }),
    ).toEqual({
      sendEligibility: SendEligibility.REVIEW,
      doNotSendReason: 'typo_pending',
    });
  });

  it('requires external validation review after accepting a typo fix', () => {
    expect(
      service.calculate({
        verificationStatus: VerificationStatus.PENDING,
        hasTypo: true,
        typoResolutionStatus: 'accepted',
      }),
    ).toEqual({
      sendEligibility: SendEligibility.REVIEW,
      doNotSendReason: 'typo_accepted_external_validation_required',
    });
  });

  it('marks valid high-quality emails as safe to send', () => {
    expect(
      service.calculate({
        verificationStatus: VerificationStatus.VALID,
        qualityScore: 80,
      }),
    ).toEqual({
      sendEligibility: SendEligibility.SAFE_TO_SEND,
      doNotSendReason: null,
    });
  });

  it('does not treat unknown provider results as safe', () => {
    expect(
      service.calculate({
        verificationStatus: VerificationStatus.UNKNOWN,
        qualityScore: 90,
      }),
    ).toEqual({
      sendEligibility: SendEligibility.REVIEW,
      doNotSendReason: 'unknown',
    });
  });

  it('routes internal SMTP failures with valid syntax and DNS to external validation review', () => {
    expect(
      service.calculate({
        verificationStatus: VerificationStatus.UNKNOWN,
        hasValidSyntax: true,
        hasValidDns: true,
        hasValidSmtp: false,
      }),
    ).toEqual({
      sendEligibility: SendEligibility.REVIEW,
      doNotSendReason: 'external_validation_internal_smtp_failed',
    });
  });

  it('returns update metadata with the selected source', () => {
    const update = service.buildUpdate(
      {
        verificationStatus: VerificationStatus.DISPOSABLE,
      },
      ExternalValidationProvider.MANUAL,
    );

    expect(update).toMatchObject({
      sendEligibility: SendEligibility.DO_NOT_SEND,
      doNotSendReason: 'disposable',
      lastValidationSource: ExternalValidationProvider.MANUAL,
    });
    expect(update.lastValidationAt).toBeInstanceOf(Date);
  });
});
