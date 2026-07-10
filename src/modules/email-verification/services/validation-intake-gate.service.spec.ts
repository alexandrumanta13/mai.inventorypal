import { ValidationIntakeGateService } from './validation-intake-gate.service';
import { SyntaxValidator } from '../validators/syntax.validator';
import { FilterValidator } from '../validators/filter.validator';
import { VerificationStatus } from '@shared/enums/verification-status.enum';
import { ImportSourceType } from '@shared/enums/import-source.enum';

describe('ValidationIntakeGateService', () => {
  let service: ValidationIntakeGateService;
  let emailRepository: {
    findOne: jest.Mock;
    count: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let verificationQueue: { add: jest.Mock };
  let emailsService: { storeTypoCandidate: jest.Mock };

  beforeEach(() => {
    emailRepository = {
      findOne: jest.fn().mockResolvedValue(null),
      count: jest.fn().mockResolvedValue(0),
      createQueryBuilder: jest.fn(),
    };
    verificationQueue = {
      add: jest.fn().mockResolvedValue({ id: 'job-1' }),
    };
    emailsService = {
      storeTypoCandidate: jest.fn().mockResolvedValue(true),
    };

    service = new ValidationIntakeGateService(
      emailRepository as any,
      verificationQueue as any,
      emailsService as any,
      new SyntaxValidator(),
      new FilterValidator(),
    );
  });

  it('accepts a normal customer email as pending validation', async () => {
    await expect(service.evaluate(' Client.Valid@Gmail.com ')).resolves.toMatchObject({
      accepted: true,
      decision: 'accepted_pending_validation',
      normalizedEmail: 'client.valid@gmail.com',
      reasonCode: 'accepted',
      isDisposable: false,
      isRoleBased: false,
    });
  });

  it('blocks empty and malformed emails with stable reason codes', async () => {
    await expect(service.evaluate('')).resolves.toMatchObject({
      accepted: false,
      decision: 'blocked',
      normalizedEmail: '',
      reasonCode: 'empty',
    });

    await expect(service.evaluate('not-an-email')).resolves.toMatchObject({
      accepted: false,
      decision: 'blocked',
      normalizedEmail: 'not-an-email',
      reasonCode: 'invalid_shape',
    });
  });

  it('blocks obvious test and placeholder addresses', async () => {
    await expect(service.evaluate('test@example.com')).resolves.toMatchObject({
      accepted: false,
      decision: 'blocked',
      reasonCode: 'test_or_placeholder',
    });

    await expect(service.evaluate('unknown@gmail.com')).resolves.toMatchObject({
      accepted: false,
      decision: 'blocked',
      reasonCode: 'test_or_placeholder',
    });
  });

  it('blocks existing suppressed emails before customer import', async () => {
    emailRepository.findOne.mockResolvedValue({
      email: 'andrei.popescu@gmail.com',
      verificationStatus: VerificationStatus.UNSUBSCRIBED,
    });

    await expect(service.evaluate('andrei.popescu@gmail.com')).resolves.toMatchObject({
      accepted: false,
      decision: 'blocked',
      normalizedEmail: 'andrei.popescu@gmail.com',
      reasonCode: 'existing_suppressed',
      existingStatus: VerificationStatus.UNSUBSCRIBED,
    });
  });

  it('does not treat internal SMTP-only invalid as a hard suppression', async () => {
    emailRepository.findOne.mockResolvedValue({
      email: 'andrei.popescu@yahoo.com',
      verificationStatus: VerificationStatus.INVALID,
      hasValidSyntax: true,
      hasValidDns: true,
      hasValidSmtp: false,
      doNotSendReason: 'invalid',
      lastValidationSource: 'internal',
    });

    await expect(service.evaluate('andrei.popescu@yahoo.com')).resolves.toMatchObject({
      accepted: true,
      decision: 'accepted_pending_validation',
      normalizedEmail: 'andrei.popescu@yahoo.com',
      reasonCode: 'accepted',
      existingStatus: VerificationStatus.INVALID,
    });
  });

  it('routes common provider typo candidates to typo review', async () => {
    await expect(service.evaluate('andrei.popescu@gamil.com')).resolves.toMatchObject({
      accepted: false,
      decision: 'needs_typo_review',
      normalizedEmail: 'andrei.popescu@gamil.com',
      reasonCode: 'common_domain_typo',
      suggestedEmail: 'andrei.popescu@gmail.com',
    });
  });

  it('stores typo candidates during import preparation', async () => {
    const decision = await service.prepareImportCandidate(
      {
        email: 'andrei.popescu@gamil.com',
        firstName: 'Andrei',
        acquisitionSource: 'supplikit_orders',
      },
      ImportSourceType.INVENTORYPAL_ORDER,
      'supplikit_order_123',
    );

    expect(decision).toMatchObject({
      accepted: false,
      decision: 'needs_typo_review',
      reasonCode: 'common_domain_typo',
    });
    expect(emailsService.storeTypoCandidate).toHaveBeenCalledWith(
      expect.objectContaining({
        email: 'andrei.popescu@gamil.com',
        firstName: 'Andrei',
      }),
      ImportSourceType.INVENTORYPAL_ORDER,
      'supplikit_order_123',
      expect.objectContaining({
        suggestedEmail: 'andrei.popescu@gmail.com',
      }),
    );
  });

  it('does not route customer-name local-part typos from SuppliKit to typo review', async () => {
    const decision = await service.prepareImportCandidate(
      {
        email: 'catalina.dmitru@gmail.com',
        firstName: 'Catalina',
        lastName: 'Dumitru',
        acquisitionSource: 'supplikit_orders',
      },
      ImportSourceType.INVENTORYPAL_ORDER,
      'supplikit_order_456',
    );

    expect(decision).toMatchObject({
      accepted: true,
      decision: 'accepted_pending_validation',
      reasonCode: 'accepted',
    });
    expect(emailsService.storeTypoCandidate).not.toHaveBeenCalled();
  });

  it('does not route ambiguous local-parts to typo review', async () => {
    await expect(
      service.evaluate('catalina_frmusika@gmail.com', {
        firstName: 'Catalina',
        lastName: 'Dumitru',
      }),
    ).resolves.toMatchObject({
      accepted: true,
      decision: 'accepted_pending_validation',
      reasonCode: 'accepted',
    });
    expect(emailsService.storeTypoCandidate).not.toHaveBeenCalled();
  });

  it('does not route normal name-matching local-parts to typo review', async () => {
    await expect(
      service.evaluate('catalina.dumitru@gmail.com', {
        firstName: 'Catalina',
        lastName: 'Dumitru',
      }),
    ).resolves.toMatchObject({
      accepted: true,
      decision: 'accepted_pending_validation',
      reasonCode: 'accepted',
    });
    expect(emailsService.storeTypoCandidate).not.toHaveBeenCalled();
  });

  it('blocks disposable domains', async () => {
    await expect(service.evaluate('andrei.popescu@mailinator.com')).resolves.toMatchObject({
      accepted: false,
      decision: 'blocked',
      reasonCode: 'disposable',
      isDisposable: true,
    });
  });

  it('accepts role-based emails only as manual review', async () => {
    await expect(service.evaluate('info@example-company.ro')).resolves.toMatchObject({
      accepted: true,
      decision: 'needs_manual_review',
      normalizedEmail: 'info@example-company.ro',
      reasonCode: 'role_based',
      isRoleBased: true,
    });
  });

  it('queues validation only for usable non-typo emails', async () => {
    emailRepository.findOne.mockResolvedValueOnce({
      email: 'client@gmail.com',
      verificationStatus: VerificationStatus.PENDING,
      hasTypo: false,
    });

    await expect(service.queueValidation('client@gmail.com')).resolves.toBe(true);
    expect(verificationQueue.add).toHaveBeenCalledWith(
      'verify-email',
      {
        email: 'client@gmail.com',
        skipSmtp: false,
      },
      expect.objectContaining({
        attempts: 2,
      }),
    );
  });

  it('does not queue validation for suppressed or typo emails', async () => {
    emailRepository.findOne.mockResolvedValueOnce({
      email: 'bad@gmail.com',
      verificationStatus: VerificationStatus.INVALID,
      hasTypo: false,
    });

    await expect(service.queueValidation('bad@gmail.com')).resolves.toBe(false);

    emailRepository.findOne.mockResolvedValueOnce({
      email: 'client@gamil.com',
      verificationStatus: VerificationStatus.RISKY,
      hasTypo: true,
    });

    await expect(service.queueValidation('client@gamil.com')).resolves.toBe(false);
    expect(verificationQueue.add).not.toHaveBeenCalled();
  });

  it('queues validation again for internal SMTP-only invalid emails', async () => {
    emailRepository.findOne.mockResolvedValueOnce({
      email: 'client@yahoo.com',
      verificationStatus: VerificationStatus.INVALID,
      hasValidSyntax: true,
      hasValidDns: true,
      hasValidSmtp: false,
      doNotSendReason: 'invalid',
      lastValidationSource: 'internal',
      hasTypo: false,
    });

    await expect(service.queueValidation('client@yahoo.com')).resolves.toBe(true);
    expect(verificationQueue.add).toHaveBeenCalledWith(
      'verify-email',
      {
        email: 'client@yahoo.com',
        skipSmtp: false,
      },
      expect.objectContaining({
        attempts: 2,
      }),
    );
  });
});
