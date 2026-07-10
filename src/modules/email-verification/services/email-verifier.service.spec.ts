import { EmailVerifierService } from './email-verifier.service';
import { VerificationStatus } from '@shared/enums/verification-status.enum';
import { SendEligibilityService } from '@modules/emails/services/send-eligibility.service';

describe('EmailVerifierService', () => {
  it('does not hard-suppress public mailbox SMTP failures', async () => {
    const emailRepository = {
      findOne: jest.fn().mockResolvedValue({
        id: 20,
        email: 'client@yahoo.com',
        hasTypo: false,
        typoSuggestion: null,
        typoResolutionStatus: null,
        gmailCategory: null,
      }),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    const historyRepository = {
      save: jest.fn().mockResolvedValue({ id: 1 }),
    };
    const syntaxValidator = {
      validate: jest.fn().mockReturnValue({ isValid: true }),
    };
    const dnsValidator = {
      validate: jest.fn().mockResolvedValue({ isValid: true }),
    };
    const smtpValidator = {
      validate: jest.fn().mockResolvedValue({
        isValid: false,
        isValidMailbox: false,
        reason: 'Mailbox not found.',
      }),
    };
    const filterValidator = {
      validate: jest.fn().mockReturnValue({
        isDisposable: false,
        isRoleBased: false,
        hasSuggestedCorrection: false,
        suggestedEmail: null,
      }),
    };
    const sendEligibilityService = new SendEligibilityService();
    const service = new EmailVerifierService(
      emailRepository as any,
      {} as any,
      historyRepository as any,
      syntaxValidator as any,
      dnsValidator as any,
      smtpValidator as any,
      filterValidator as any,
      sendEligibilityService,
    );

    const result = await service.verifyEmail('client@yahoo.com');

    expect(result.status).toBe(VerificationStatus.UNKNOWN);
    expect(emailRepository.update).toHaveBeenCalledWith(
      20,
      expect.objectContaining({
        verificationStatus: VerificationStatus.UNKNOWN,
        sendEligibility: 'review',
        doNotSendReason: 'external_validation_internal_smtp_failed',
      }),
    );
    expect(historyRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({
        finalStatus: VerificationStatus.UNKNOWN,
        smtpValid: false,
        verificationDetails: expect.objectContaining({
          smtp: expect.objectContaining({
            requiresExternalValidation: true,
            externalReviewReason: 'public_mailbox_smtp_untrusted',
          }),
        }),
      }),
    );
  });

  it('preserves accepted typo/recovery gate during internal validation', async () => {
    const emailRepository = {
      findOne: jest.fn().mockResolvedValue({
        id: 10,
        email: 'client@gmail.com',
        hasTypo: true,
        typoSuggestion: 'client@gamil.com',
        typoResolutionStatus: 'accepted',
        typoResolvedEmail: 'client@gmail.com',
        gmailCategory: null,
      }),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    const historyRepository = {
      save: jest.fn().mockResolvedValue({ id: 1 }),
    };
    const sendEligibilityService = new SendEligibilityService();
    const service = new EmailVerifierService(
      emailRepository as any,
      {} as any,
      historyRepository as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      sendEligibilityService,
    );

    await (service as any).saveVerification('client@gmail.com', {
      status: VerificationStatus.VALID,
      qualityScore: 90,
      hasValidSyntax: true,
      hasValidDns: true,
      hasValidSmtp: true,
      isDisposable: false,
      isRoleBased: false,
      suggestedEmail: null,
      details: {},
      durationMs: 100,
    });

    expect(emailRepository.update).toHaveBeenCalledWith(
      10,
      expect.objectContaining({
        verificationStatus: VerificationStatus.VALID,
        hasTypo: true,
        typoSuggestion: 'client@gamil.com',
        sendEligibility: 'review',
        doNotSendReason: 'typo_accepted_external_validation_required',
      }),
    );
  });
});
