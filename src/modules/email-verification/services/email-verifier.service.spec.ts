import { EmailVerifierService } from './email-verifier.service';
import { VerificationStatus } from '@shared/enums/verification-status.enum';
import { SendEligibilityService } from '@modules/emails/services/send-eligibility.service';

describe('EmailVerifierService', () => {
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
