import { BounceRecoveryService } from './bounce-recovery.service';
import { FilterValidator } from '../validators/filter.validator';
import {
  BounceRecoveryReason,
  BounceRecoveryStatus,
} from '../entities/bounce-recovery-candidate.entity';
import { ExternalValidationProvider, SendEligibility } from '@shared/enums/email-validation.enum';
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

  it('keeps approved bounce recovery suggestions gated for external validation', async () => {
    bounceRecoveryRepository.findOne.mockResolvedValueOnce({
      id: 40,
      bouncedEmail: 'client@gamil.com',
      suggestedEmail: 'client@gmail.com',
      reason: BounceRecoveryReason.DOMAIN_TYPO,
      status: BounceRecoveryStatus.PENDING,
      customerId: 21,
      customer: {
        first_name: 'Client',
        last_name: 'Example',
      },
      metadata: {},
    });
    emailRepository.findOne.mockResolvedValueOnce(null);

    const result = await service.approveCandidate(40);

    expect(emailRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({
        email: 'client@gmail.com',
        hasTypo: true,
        typoSuggestion: 'client@gamil.com',
        typoResolutionStatus: 'accepted',
        typoResolvedEmail: 'client@gmail.com',
        smtpErrorMessage: 'Bounce recovery approved; external validation required before marketing sends',
      }),
    );
    expect(sendEligibilityService.buildUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        verificationStatus: VerificationStatus.PENDING,
        hasTypo: true,
        typoResolutionStatus: 'accepted',
      }),
      ExternalValidationProvider.INTERNAL,
    );
    expect(result).toMatchObject({
      approved: true,
      suggestedEmail: 'client@gmail.com',
      validationQueued: true,
    });
  });

  it('accepts the bounced original as a recovery decision for external validation', async () => {
    bounceRecoveryRepository.findOne.mockResolvedValueOnce({
      id: 45,
      bouncedEmail: 'petroimary82@gmail.com',
      suggestedEmail: 'petroimaria@gmail.com',
      reason: BounceRecoveryReason.NAME_LOCALPART_TYPO,
      status: BounceRecoveryStatus.PENDING,
      customerId: 21,
      customer: {
        first_name: 'Maria',
        last_name: 'Petroi',
      },
      metadata: {},
    });
    emailRepository.findOne
      .mockResolvedValueOnce({
        id: 77,
        email: 'petroimary82@gmail.com',
        verificationStatus: VerificationStatus.INVALID,
        qualityScore: 0,
        gmailCategory: null,
      })
      .mockResolvedValueOnce({
        id: 77,
        email: 'petroimary82@gmail.com',
      });

    const result = await service.takeOriginalCandidate(45, 'manual original decision');

    expect(emailRepository.update).toHaveBeenCalledWith(
      77,
      expect.objectContaining({
        email: 'petroimary82@gmail.com',
        hasTypo: true,
        typoSuggestion: 'petroimaria@gmail.com',
        typoResolutionStatus: 'accepted',
        typoResolvedEmail: 'petroimary82@gmail.com',
        smtpErrorMessage: 'Bounce recovery original accepted; external validation required before marketing sends',
      }),
    );
    expect(sendEligibilityService.buildUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        verificationStatus: VerificationStatus.PENDING,
        hasTypo: true,
        typoResolutionStatus: 'accepted',
      }),
      ExternalValidationProvider.MANUAL,
    );
    expect(verificationQueue.add).not.toHaveBeenCalled();
    expect(bounceRecoveryRepository.update).toHaveBeenCalledWith(
      45,
      expect.objectContaining({
        status: BounceRecoveryStatus.APPROVED,
        note: 'manual original decision',
        metadata: expect.objectContaining({
          approvedEmailId: 77,
          originalEmailAccepted: true,
          previousSuggestedEmail: 'petroimaria@gmail.com',
          externalValidationRequired: true,
        }),
      }),
    );
    expect(result).toMatchObject({
      approved: true,
      originalEmail: 'petroimary82@gmail.com',
      emailId: 77,
      validationQueued: false,
      externalValidationRequired: true,
    });
  });

  it('does not reopen protected original emails when taking original', async () => {
    bounceRecoveryRepository.findOne.mockResolvedValueOnce({
      id: 46,
      bouncedEmail: 'blocked@gmail.com',
      suggestedEmail: 'blocker@gmail.com',
      reason: BounceRecoveryReason.NAME_LOCALPART_TYPO,
      status: BounceRecoveryStatus.PENDING,
      metadata: {},
    });
    emailRepository.findOne.mockResolvedValueOnce({
      id: 78,
      email: 'blocked@gmail.com',
      verificationStatus: VerificationStatus.UNSUBSCRIBED,
    });

    const result = await service.takeOriginalCandidate(46);

    expect(emailRepository.update).not.toHaveBeenCalled();
    expect(emailRepository.create).not.toHaveBeenCalled();
    expect(bounceRecoveryRepository.update).toHaveBeenCalledWith(
      46,
      expect.objectContaining({
        status: BounceRecoveryStatus.APPROVED,
        metadata: expect.objectContaining({
          approvedEmailId: 78,
          originalEmailAccepted: true,
          protectedOriginalStatus: VerificationStatus.UNSUBSCRIBED,
          externalValidationRequired: false,
        }),
      }),
    );
    expect(result).toMatchObject({
      approved: true,
      originalEmail: 'blocked@gmail.com',
      emailId: 78,
      externalValidationRequired: false,
      protectedOriginalStatus: VerificationStatus.UNSUBSCRIBED,
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
