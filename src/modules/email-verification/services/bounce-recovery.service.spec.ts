import { BounceRecoveryService } from './bounce-recovery.service';
import { FilterValidator } from '../validators/filter.validator';
import {
  BounceRecoveryReason,
  BounceRecoveryStatus,
} from '../entities/bounce-recovery-candidate.entity';
import { SendEligibility } from '@shared/enums/email-validation.enum';
import { VerificationStatus } from '@shared/enums/verification-status.enum';

describe('BounceRecoveryService', () => {
  let service: BounceRecoveryService;
  let bounceRecoveryRepository: {
    findOne: jest.Mock;
    save: jest.Mock;
    create: jest.Mock;
    update: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let emailRepository: {
    findOne: jest.Mock;
    save: jest.Mock;
    create: jest.Mock;
    update: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let customerRepository: {
    findOne: jest.Mock;
  };
  let sendEligibilityService: {
    buildUpdate: jest.Mock;
  };
  let verificationQueue: {
    add: jest.Mock;
  };

  beforeEach(() => {
    bounceRecoveryRepository = {
      findOne: jest.fn().mockResolvedValue(null),
      save: jest.fn().mockImplementation(async (row) => row),
      create: jest.fn().mockImplementation((row) => row),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      createQueryBuilder: jest.fn(),
    };
    emailRepository = {
      findOne: jest.fn().mockResolvedValue(null),
      save: jest.fn().mockImplementation(async (row) => ({ id: 99, ...row })),
      create: jest.fn().mockImplementation((row) => row),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      createQueryBuilder: jest.fn(),
    };
    customerRepository = {
      findOne: jest.fn().mockResolvedValue(null),
    };
    sendEligibilityService = {
      buildUpdate: jest.fn().mockReturnValue({
        sendEligibility: 'pending',
        doNotSendReason: null,
        lastValidationSource: 'internal',
        lastValidationAt: new Date('2026-07-07T00:00:00Z'),
      }),
    };
    verificationQueue = {
      add: jest.fn().mockResolvedValue({ id: 'job-1' }),
    };

    service = new BounceRecoveryService(
      bounceRecoveryRepository as any,
      emailRepository as any,
      customerRepository as any,
      new FilterValidator(),
      sendEligibilityService as any,
      verificationQueue as any,
    );
  });

  it('stores domain typo bounce recovery candidates', async () => {
    emailRepository.findOne
      .mockResolvedValueOnce({
        id: 10,
        email: 'client@gamil.com',
        customerId: 20,
      })
      .mockResolvedValueOnce(null);
    customerRepository.findOne
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 20, first_name: 'Client' });

    const result = await service.createCandidateFromBounce('client@gamil.com');

    expect(result).toMatchObject({
      bouncedEmail: 'client@gamil.com',
      suggestedEmail: 'client@gmail.com',
      reason: BounceRecoveryReason.DOMAIN_TYPO,
      confidence: 'high',
      emailId: 10,
      customerId: 20,
    });
    expect(bounceRecoveryRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({
        bouncedEmail: 'client@gamil.com',
        suggestedEmail: 'client@gmail.com',
        status: BounceRecoveryStatus.PENDING,
      }),
    );
  });

  it('stores name/local-part typo candidates only with customer name context', async () => {
    emailRepository.findOne
      .mockResolvedValueOnce({
        id: 11,
        email: 'catalina.dmitru@gmail.com',
        customerId: 21,
      })
      .mockResolvedValueOnce(null);
    customerRepository.findOne
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: 21,
        first_name: 'Catalina',
        last_name: 'Dumitru',
      });

    const result = await service.createCandidateFromBounce('catalina.dmitru@gmail.com');

    expect(result).toMatchObject({
      bouncedEmail: 'catalina.dmitru@gmail.com',
      suggestedEmail: 'catalina.dumitru@gmail.com',
      reason: BounceRecoveryReason.NAME_LOCALPART_TYPO,
      confidence: 'high',
    });
    expect(bounceRecoveryRepository.save).toHaveBeenCalled();
  });

  it('skips ambiguous local-part bounces without clear suggestion', async () => {
    emailRepository.findOne.mockResolvedValueOnce({
      id: 12,
      email: 'catalina_frmusika@gmail.com',
      customerId: 22,
    });
    customerRepository.findOne
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: 22,
        first_name: 'Catalina',
        last_name: 'Dumitru',
      });

    await expect(
      service.createCandidateFromBounce('catalina_frmusika@gmail.com'),
    ).resolves.toBeNull();
    expect(bounceRecoveryRepository.save).not.toHaveBeenCalled();
  });

  it('does not create name typo recovery candidates for business domains', async () => {
    emailRepository.findOne.mockResolvedValueOnce({
      id: 13,
      email: 'catalina.dmitru@industrialaccess.ro',
      customerId: 23,
    });
    customerRepository.findOne
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: 23,
        first_name: 'Catalina',
        last_name: 'Dumitru',
      });

    await expect(
      service.createCandidateFromBounce('catalina.dmitru@industrialaccess.ro'),
    ).resolves.toBeNull();
    expect(bounceRecoveryRepository.save).not.toHaveBeenCalled();
  });

  it('suppresses an ignored bounce recovery suggestion from marketing sends', async () => {
    bounceRecoveryRepository.findOne.mockResolvedValueOnce({
      id: 31,
      bouncedEmail: 'catalina.dmitru@gmail.com',
      suggestedEmail: 'catalina.dumitru@gmail.com',
      status: BounceRecoveryStatus.PENDING,
      customerId: 21,
      metadata: { source: 'test' },
    });
    emailRepository.findOne.mockResolvedValueOnce(null);

    const result = await service.ignoreCandidate(31, 'bad suggestion');

    expect(emailRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({
        email: 'catalina.dumitru@gmail.com',
        verificationStatus: VerificationStatus.RISKY,
        sendEligibility: SendEligibility.DO_NOT_SEND,
        doNotSendReason: 'bounce_recovery_ignored',
      }),
    );
    expect(bounceRecoveryRepository.update).toHaveBeenCalledWith(
      31,
      expect.objectContaining({
        status: BounceRecoveryStatus.IGNORED,
        metadata: expect.objectContaining({
          suppressedEmailId: 99,
          suppressedAlready: false,
          suppressionReason: 'bounce_recovery_ignored',
        }),
      }),
    );
    expect(result).toMatchObject({
      ignored: true,
      suggestedEmail: 'catalina.dumitru@gmail.com',
      suppressedEmailId: 99,
      suppressedAlready: false,
    });
  });

  it('does not overwrite an existing do-not-send suppression when ignoring a suggestion', async () => {
    bounceRecoveryRepository.findOne.mockResolvedValueOnce({
      id: 32,
      bouncedEmail: 'client@gamil.com',
      suggestedEmail: 'client@gmail.com',
      status: BounceRecoveryStatus.PENDING,
      metadata: {},
    });
    emailRepository.findOne.mockResolvedValueOnce({
      id: 44,
      email: 'client@gmail.com',
      sendEligibility: SendEligibility.DO_NOT_SEND,
      doNotSendReason: 'unsubscribed',
    });

    const result = await service.ignoreCandidate(32);

    expect(emailRepository.update).not.toHaveBeenCalled();
    expect(bounceRecoveryRepository.update).toHaveBeenCalledWith(
      32,
      expect.objectContaining({
        status: BounceRecoveryStatus.IGNORED,
        metadata: expect.objectContaining({
          suppressedEmailId: 44,
          suppressedAlready: true,
        }),
      }),
    );
    expect(result).toMatchObject({
      ignored: true,
      suppressedEmailId: 44,
      suppressedAlready: true,
    });
  });

  it('updates a pending bounce recovery suggestion with audit metadata', async () => {
    bounceRecoveryRepository.findOne
      .mockResolvedValueOnce({
        id: 41,
        bouncedEmail: 'catalina.dmitru@gmail.com',
        suggestedEmail: 'catalina.dumitru@gmail.com',
        status: BounceRecoveryStatus.PENDING,
        metadata: { source: 'gmail_bounce' },
      })
      .mockResolvedValueOnce(null);
    emailRepository.findOne.mockResolvedValueOnce({
      id: 55,
      email: 'catalina.dumitru86@gmail.com',
      verificationStatus: VerificationStatus.PENDING,
    });

    const result = await service.updateSuggestion(
      41,
      'Catalina.Dumitru86@gmail.com',
      'manual correction',
    );

    expect(bounceRecoveryRepository.update).toHaveBeenCalledWith(
      41,
      expect.objectContaining({
        suggestedEmail: 'catalina.dumitru86@gmail.com',
        note: 'manual correction',
        metadata: expect.objectContaining({
          existingSuggestedStatus: VerificationStatus.PENDING,
          manuallyEditedSuggestion: true,
          previousSuggestions: [
            expect.objectContaining({
              suggestedEmail: 'catalina.dumitru@gmail.com',
            }),
          ],
        }),
      }),
    );
    expect(result).toMatchObject({
      updated: true,
      suggestedEmail: 'catalina.dumitru86@gmail.com',
      existingSuggestedStatus: VerificationStatus.PENDING,
    });
  });

  it('rejects invalid manual bounce recovery suggestions', async () => {
    bounceRecoveryRepository.findOne.mockResolvedValueOnce({
      id: 42,
      bouncedEmail: 'client@gamil.com',
      suggestedEmail: 'client@gmail.com',
      status: BounceRecoveryStatus.PENDING,
      metadata: {},
    });

    const result = await service.updateSuggestion(42, 'not-an-email');

    expect(bounceRecoveryRepository.update).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      updated: false,
      reason: 'Suggested email is not valid',
    });
  });
});
