import { ExternalValidationImportService } from './external-validation-import.service';
import {
  EmailValidationMappedStatus,
  ExternalValidationProvider,
  SendEligibility,
} from '@shared/enums/email-validation.enum';
import { VerificationStatus } from '@shared/enums/verification-status.enum';

describe('ExternalValidationImportService', () => {
  let emailRepository: {
    findOne: jest.Mock;
    update: jest.Mock;
  };
  let batchRepository: {
    create: jest.Mock;
    save: jest.Mock;
    update: jest.Mock;
  };
  let eventRepository: {
    create: jest.Mock;
    save: jest.Mock;
  };
  let service: ExternalValidationImportService;

  beforeEach(() => {
    emailRepository = {
      findOne: jest.fn(),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    batchRepository = {
      create: jest.fn((row) => row),
      save: jest.fn().mockImplementation(async (row) => ({ id: 77, ...row })),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    eventRepository = {
      create: jest.fn((row) => row),
      save: jest.fn().mockResolvedValue({ id: 88 }),
    };

    service = new ExternalValidationImportService(
      emailRepository as any,
      batchRepository as any,
      eventRepository as any,
    );
  });

  it('imports a valid recovered typo result and releases it to safe_to_send', async () => {
    emailRepository.findOne.mockResolvedValueOnce({
      id: 123,
      email: 'client@gmail.com',
      hasTypo: true,
      typoResolutionStatus: 'accepted',
      typoResolutionNote: 'Bounce recovery approved',
      verificationStatus: VerificationStatus.VALID,
      qualityScore: 90,
      gmailCategory: null,
    });

    const result = await service.importCsv({
      provider: ExternalValidationProvider.ZEROBOUNCE,
      csv: 'email,email_id,status\nclient@gmail.com,123,valid\n',
    });

    expect(result).toMatchObject({
      dryRun: false,
      processed: 1,
      matched: 1,
      updated: 1,
    });
    expect(eventRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: ExternalValidationProvider.ZEROBOUNCE,
        emailId: 123,
        mappedStatus: EmailValidationMappedStatus.VALID,
        sendEligibility: SendEligibility.SAFE_TO_SEND,
      }),
    );
    expect(emailRepository.update).toHaveBeenCalledWith(
      123,
      expect.objectContaining({
        verificationStatus: VerificationStatus.VALID,
        qualityScore: 95,
        hasTypo: false,
        sendEligibility: SendEligibility.SAFE_TO_SEND,
        doNotSendReason: null,
        lastValidationSource: ExternalValidationProvider.ZEROBOUNCE,
      }),
    );
  });

  it('does not release protected unsubscribed emails when external result is valid', async () => {
    emailRepository.findOne.mockResolvedValueOnce({
      id: 124,
      email: 'blocked@gmail.com',
      gmailCategory: 'unsubscribe',
      verificationStatus: VerificationStatus.UNSUBSCRIBED,
      sendEligibility: SendEligibility.DO_NOT_SEND,
      doNotSendReason: 'unsubscribed',
      qualityScore: 0,
      hasTypo: false,
    });

    await service.importCsv({
      provider: ExternalValidationProvider.NEVERBOUNCE,
      csv: 'email,status\nblocked@gmail.com,valid\n',
    });

    expect(emailRepository.update).toHaveBeenCalledWith(
      124,
      expect.objectContaining({
        verificationStatus: VerificationStatus.UNSUBSCRIBED,
        sendEligibility: SendEligibility.DO_NOT_SEND,
        doNotSendReason: 'unsubscribed',
        lastValidationSource: ExternalValidationProvider.NEVERBOUNCE,
      }),
    );
  });

  it('maps catch-all results to review', async () => {
    emailRepository.findOne.mockResolvedValueOnce({
      id: 125,
      email: 'catchall@example.com',
      verificationStatus: VerificationStatus.RISKY,
      qualityScore: 50,
      hasTypo: true,
    });

    const result = await service.importCsv({
      csv: 'email,status\ncatchall@example.com,catch-all\n',
      dryRun: true,
    });

    expect(result.rows[0]).toMatchObject({
      mappedStatus: EmailValidationMappedStatus.CATCH_ALL,
      action: 'would_update_email',
      sendEligibility: SendEligibility.REVIEW,
      reasonCode: 'external_validation_catch_all',
    });
    expect(emailRepository.update).not.toHaveBeenCalled();
  });
});
