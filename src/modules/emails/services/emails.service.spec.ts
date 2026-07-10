import { ImportSourceType } from '@shared/enums/import-source.enum';
import { ExternalValidationProvider, SendEligibility } from '@shared/enums/email-validation.enum';
import { VerificationStatus } from '@shared/enums/verification-status.enum';
import { FilterValidator } from '../../email-verification/validators/filter.validator';
import { Email } from '../entities/email.entity';
import { SendEligibilityService } from './send-eligibility.service';
import { EmailsService } from './emails.service';

describe('EmailsService', () => {
  let service: EmailsService;
  let emailRepository: {
    findOne: jest.Mock;
    findOneOrFail: jest.Mock;
    update: jest.Mock;
    save: jest.Mock;
    create: jest.Mock;
  };
  let emailSourceRepository: {
    findOne: jest.Mock;
    save: jest.Mock;
  };
  let bounceRecoveryRepository: {
    createQueryBuilder: jest.Mock;
  };

  beforeEach(() => {
    emailRepository = {
      findOne: jest.fn(),
      findOneOrFail: jest.fn(),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      save: jest.fn(),
      create: jest.fn((data) => data),
    };
    emailSourceRepository = {
      findOne: jest.fn().mockResolvedValue(null),
      save: jest.fn().mockResolvedValue({ id: 1 }),
    };
    bounceRecoveryRepository = {
      createQueryBuilder: jest.fn(),
    };

    service = new EmailsService(
      emailRepository as any,
      emailSourceRepository as any,
      bounceRecoveryRepository as any,
      new FilterValidator(),
      new SendEligibilityService(),
    );
  });

  it('removes a typo candidate from review when it is marked as test', async () => {
    const existingEmail = {
      id: 123,
      email: 'client@gamil.com',
      emailDomain: 'gamil.com',
      hasTypo: true,
      typoSuggestion: 'client@gmail.com',
      typoResolutionStatus: 'pending',
      verificationStatus: VerificationStatus.RISKY,
      qualityScore: 45,
    } as Email;
    const updatedEmail = {
      ...existingEmail,
      hasTypo: false,
      typoSuggestion: null,
      typoResolutionStatus: 'ignored',
      verificationStatus: VerificationStatus.INVALID,
      qualityScore: 0,
    } as Email;

    emailRepository.findOne
      .mockResolvedValueOnce(existingEmail)
      .mockResolvedValueOnce(updatedEmail);

    await expect(
      service.markAsTestEmail(' client@gamil.com ', {
        reason: 'Marked as test from review',
        sourceIdentifier: 'quality_gate_test_supplikit_order_1',
      }),
    ).resolves.toMatchObject({
      id: 123,
      email: 'client@gamil.com',
      hasTypo: false,
      typoResolutionStatus: 'ignored',
      verificationStatus: VerificationStatus.INVALID,
    });

    expect(emailRepository.update).toHaveBeenCalledWith(
      123,
      expect.objectContaining({
        verificationStatus: VerificationStatus.INVALID,
        qualityScore: 0,
        hasTypo: false,
        typoSuggestion: null,
        typoResolutionStatus: 'ignored',
        typoResolvedEmail: null,
        typoResolutionNote: 'Marked as test from review',
        sendEligibility: SendEligibility.DO_NOT_SEND,
        doNotSendReason: 'invalid',
        lastValidationSource: ExternalValidationProvider.MANUAL,
      }),
    );
    expect(emailSourceRepository.findOne).toHaveBeenCalledWith({
      where: {
        emailId: 123,
        sourceType: ImportSourceType.MANUAL,
        sourceIdentifier: 'quality_gate_test_supplikit_order_1',
      },
    });
  });

  it('accepts a manual typo correction when the scanner has no suggestion', async () => {
    const existingEmail = {
      id: 77,
      email: 'maria@gmial.com',
      emailDomain: 'gmial.com',
      hasTypo: true,
      typoSuggestion: null,
      typoResolutionStatus: 'pending',
      verificationStatus: VerificationStatus.INVALID,
      qualityScore: 0,
      isDisposable: false,
      isRoleBased: false,
    } as Email;
    const updatedEmail = {
      ...existingEmail,
      typoSuggestion: 'maria@gmail.com',
      typoResolvedEmail: 'maria@gmail.com',
      typoResolutionStatus: 'accepted',
      verificationStatus: VerificationStatus.RISKY,
    } as Email;

    emailRepository.findOne.mockResolvedValue(existingEmail);
    emailRepository.findOneOrFail.mockResolvedValue(updatedEmail);

    await expect(
      service.resolveTypoCandidate(77, {
        action: 'accept',
        resolvedEmail: 'maria@gmail.com',
        note: 'Manual correction from import audit',
      }),
    ).resolves.toMatchObject({
      id: 77,
      typoResolvedEmail: 'maria@gmail.com',
      typoResolutionStatus: 'accepted',
    });

    expect(emailRepository.update).toHaveBeenCalledWith(
      77,
      expect.objectContaining({
        hasTypo: true,
        typoSuggestion: 'maria@gmail.com',
        typoResolvedEmail: 'maria@gmail.com',
        typoResolutionStatus: 'accepted',
        verificationStatus: VerificationStatus.RISKY,
        sendEligibility: SendEligibility.REVIEW,
        doNotSendReason: 'typo_accepted_external_validation_required',
        lastValidationSource: ExternalValidationProvider.MANUAL,
      }),
    );
  });

  it('uses an accepted typo correction as the effective campaign address', () => {
    expect((service as any).getEffectiveEmailAddress({
      email: 'maria@gmial.com',
      typoResolutionStatus: 'accepted',
      typoResolvedEmail: 'maria@gmail.com',
    })).toBe('maria@gmail.com');
  });
});
