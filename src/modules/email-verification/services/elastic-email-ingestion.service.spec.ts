import { ElasticEmailIngestionService } from './elastic-email-ingestion.service';
import { SendEligibilityService } from '@modules/emails/services/send-eligibility.service';
import { VerificationStatus } from '@shared/enums/verification-status.enum';
import { SendEligibility } from '@shared/enums/email-validation.enum';

describe('ElasticEmailIngestionService', () => {
  const createRepository = () => ({
    findOne: jest.fn(),
    save: jest.fn((entity) => Promise.resolve({ id: 1, ...entity })),
    create: jest.fn((entity) => entity),
    update: jest.fn(() => Promise.resolve({ affected: 1 })),
  });

  const createService = () => {
    const emailRepository = createRepository();
    const batchRepository = createRepository();
    const eventRepository = createRepository();
    const configService = { get: jest.fn() };
    const bounceRecoveryService = {
      createCandidateFromBounce: jest.fn().mockResolvedValue(null),
    };
    const service = new ElasticEmailIngestionService(
      emailRepository as any,
      batchRepository as any,
      eventRepository as any,
      new SendEligibilityService(),
      configService as any,
      bounceRecoveryService as any,
    );

    return {
      service,
      emailRepository,
      eventRepository,
      configService,
      bounceRecoveryService,
    };
  };

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('marks Elastic bounces after unsubscribe as do-not-send bounce_after_unsubscribe', async () => {
    const { service, emailRepository } = createService();
    emailRepository.findOne
      .mockResolvedValueOnce({
        id: 10,
        email: 'client@gmail.com',
        verificationStatus: VerificationStatus.UNSUBSCRIBED,
        sendEligibility: SendEligibility.DO_NOT_SEND,
        doNotSendReason: 'unsubscribed',
      })
      .mockResolvedValueOnce(null);

    const result = await service.ingestPayload(
      {
        email: 'client@gmail.com',
        status: 'Bounced',
        reason: 'mailbox unavailable',
        date: '2026-07-07T08:00:00Z',
      },
      { dryRun: false },
    );

    expect(result.updated).toBe(1);
    expect(emailRepository.update).toHaveBeenCalledWith(
      10,
      expect.objectContaining({
        verificationStatus: VerificationStatus.INVALID,
        sendEligibility: SendEligibility.DO_NOT_SEND,
        doNotSendReason: 'bounce_after_unsubscribe',
      }),
    );
  });

  it('does not promote protected do-not-send rows on delivered events', async () => {
    const { service, emailRepository } = createService();
    emailRepository.findOne
      .mockResolvedValueOnce({
        id: 11,
        email: 'bad@gmail.com',
        verificationStatus: VerificationStatus.INVALID,
        sendEligibility: SendEligibility.DO_NOT_SEND,
        doNotSendReason: 'bounce',
      })
      .mockResolvedValueOnce(null);

    const result = await service.ingestPayload(
      {
        email: 'bad@gmail.com',
        status: 'Sent',
        date: '2026-07-07T08:00:00Z',
      },
      { dryRun: false },
    );

    expect(result.updated).toBe(0);
    expect(emailRepository.update).not.toHaveBeenCalled();
  });

  it('creates do-not-send suppression rows for missing negative recipients', async () => {
    const { service, emailRepository, eventRepository } = createService();
    emailRepository.findOne.mockResolvedValueOnce(null);

    const result = await service.ingestPayload(
      {
        email: 'technical@example.com',
        status: 'Error',
        date: '2026-07-07T08:00:00Z',
      },
      { dryRun: false },
    );

    expect(result.missingEmailRows).toBe(1);
    expect(result.suppressionRowsCreated).toBe(1);
    expect(result.updated).toBe(0);
    expect(emailRepository.update).not.toHaveBeenCalled();
    expect(emailRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({
        email: 'technical@example.com',
        emailDomain: 'example.com',
        acquisitionSource: 'elastic_email_suppression',
        verificationStatus: VerificationStatus.INVALID,
        sendEligibility: SendEligibility.DO_NOT_SEND,
        doNotSendReason: 'elastic_bounce',
      }),
    );
    expect(eventRepository.save).toHaveBeenCalled();
  });

  it('does not create suppression rows for missing positive recipients', async () => {
    const { service, emailRepository } = createService();
    emailRepository.findOne.mockResolvedValueOnce(null);

    const result = await service.ingestPayload(
      {
        email: 'new@example.com',
        status: 'Sent',
        date: '2026-07-07T08:00:00Z',
      },
      { dryRun: false },
    );

    expect(result.missingEmailRows).toBe(1);
    expect(result.suppressionRowsCreated).toBe(0);
    expect(emailRepository.save).not.toHaveBeenCalledWith(
      expect.objectContaining({
        email: 'new@example.com',
      }),
    );
  });

  it('creates bounce recovery candidates for Elastic hard bounces with recoverable name typos', async () => {
    const { service, emailRepository, bounceRecoveryService } = createService();
    emailRepository.findOne.mockResolvedValueOnce({
      id: 21,
      email: 'catalina.dmitru@gmail.com',
      firstName: 'Catalina',
      lastName: 'Dumitru',
      fullName: 'Catalina Dumitru',
      verificationStatus: VerificationStatus.PENDING,
      sendEligibility: SendEligibility.PENDING,
      gmailCategory: null,
    });
    bounceRecoveryService.createCandidateFromBounce.mockResolvedValueOnce({
      bouncedEmail: 'catalina.dmitru@gmail.com',
      suggestedEmail: 'catalina.dumitru@gmail.com',
      reason: 'name_localpart_typo',
      confidence: 'high',
      emailId: 21,
      customerId: 31,
    });

    const result = await service.ingestPayload(
      {
        email: 'catalina.dmitru@gmail.com',
        status: 'Bounce',
        reason: 'mailbox unavailable',
        date: '2026-07-07T08:00:00Z',
        subject: 'Order notification',
        from: 'no-reply@example.com',
      },
      { dryRun: false },
    );

    expect(emailRepository.update).toHaveBeenCalledWith(
      21,
      expect.objectContaining({
        verificationStatus: VerificationStatus.INVALID,
        sendEligibility: SendEligibility.DO_NOT_SEND,
      }),
    );
    expect(bounceRecoveryService.createCandidateFromBounce).toHaveBeenCalledWith(
      'catalina.dmitru@gmail.com',
      expect.objectContaining({
        source: 'elastic_email_bounce',
        firstName: 'Catalina',
        lastName: 'Dumitru',
        fullName: 'Catalina Dumitru',
        subject: 'Order notification',
        from: 'no-reply@example.com',
      }),
      { dryRun: false },
    );
    expect(result.bounceRecoveryCandidatesCreated).toBe(1);
    expect(result.rows[0]).toEqual(
      expect.objectContaining({
        bounceRecoverySuggestedEmail: 'catalina.dumitru@gmail.com',
        bounceRecoveryAction: 'created_bounce_recovery_candidate',
      }),
    );
  });

  it('splits Elastic v4 event type filters and maps negative aliases', async () => {
    const { service, emailRepository, configService } = createService();
    configService.get.mockReturnValue('elastic-key');
    emailRepository.findOne.mockResolvedValue(null);

    const fetchMock = jest.spyOn(global, 'fetch' as any).mockImplementation(async (url: any) => {
      const eventType = new URL(String(url)).searchParams.get('eventTypes');
      return {
        ok: true,
        json: async () =>
          eventType === 'Bounce'
            ? [
                {
                  EventType: 'Bounce',
                  To: 'missing@example.com',
                  EventDate: '2026-07-07T08:00:00Z',
                  TransactionID: 'tx-1',
                },
              ]
            : [],
      } as any;
    });

    const result = await service.pullLegacyEvents({
      status: 'Error,Bounce,Abuse,Unsubscribe',
      dryRun: true,
    });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const eventTypes = fetchMock.mock.calls.map(([url]) => new URL(String(url)).searchParams.get('eventTypes'));
    expect(eventTypes).toEqual(['Bounce', 'Complaint', 'Unsubscribe']);
    expect(result.fetched).toBe(1);
    expect(result.processed).toBe(1);
    expect(result.suppressionRowsCreated).toBe(0);
    expect(result.rows[0]).toEqual(
      expect.objectContaining({
        email: 'missing@example.com',
        action: 'would_create_do_not_send_suppression',
      }),
    );
  });
});
