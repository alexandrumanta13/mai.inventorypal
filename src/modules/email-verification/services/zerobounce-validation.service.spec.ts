import { ZeroBounceValidationService } from './zerobounce-validation.service';
import { ExternalValidationImportService } from './external-validation-import.service';
import {
  EmailValidationMappedStatus,
  ExternalValidationProvider,
  SendEligibility,
} from '@shared/enums/email-validation.enum';

describe('ZeroBounceValidationService', () => {
  let configService: {
    get: jest.Mock;
  };
  let emailRepository: {
    createQueryBuilder: jest.Mock;
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
  let externalValidationImportService: {
    importRows: jest.Mock;
  };
  let service: ZeroBounceValidationService;

  beforeEach(() => {
    configService = {
      get: jest.fn(),
    };
    emailRepository = {
      createQueryBuilder: jest.fn(),
      findOne: jest.fn(),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    batchRepository = {
      create: jest.fn((row) => row),
      save: jest.fn(async (row) => ({ id: 25, ...row })),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    eventRepository = {
      create: jest.fn((row) => row),
      save: jest.fn().mockResolvedValue({ id: 91 }),
    };
    externalValidationImportService = {
      importRows: jest.fn(),
    };
    service = new ZeroBounceValidationService(
      configService as any,
      emailRepository as any,
      batchRepository as any,
      eventRepository as any,
      externalValidationImportService as unknown as ExternalValidationImportService,
    );
  });

  it('reports not configured when ZEROBOUNCE_API_KEY is missing', async () => {
    configService.get.mockReturnValue(undefined);

    await expect(service.getCreditBalance()).resolves.toEqual({
      configured: false,
      credits: null,
      validKey: null,
    });
  });

  it('caps preview batches to 100 rows', async () => {
    const query = createQueryBuilderMock({
      count: 1250,
      rows: Array.from({ length: 100 }, (_, index) => ({
        id: index + 1,
        email: `client${index}@gmail.com`,
        verificationStatus: 'invalid',
        sendEligibility: 'do_not_send',
        doNotSendReason: 'invalid',
        lastValidationSource: null,
        lastValidationAt: null,
        acquisitionSource: 'supplikit',
      })),
    });
    emailRepository.createQueryBuilder.mockReturnValue(query);
    configService.get.mockReturnValue(undefined);

    const result = await service.previewSegment({
      segment: 'smtp_failed_internal',
      limit: 5000,
      includeCredits: false,
    });

    expect(query.take).toHaveBeenCalledWith(100);
    expect(result.total).toBe(1250);
    expect(result.rows).toHaveLength(100);
    expect(result.estimatedCredits).toBe(100);
  });

  it('excludes a candidate from external validation with an audit event', async () => {
    emailRepository.findOne.mockResolvedValueOnce({
      id: 456,
      email: 'roxana.neacsu@sorantis.ro',
      verificationStatus: 'invalid',
      sendEligibility: 'do_not_send',
      doNotSendReason: 'invalid',
      lastValidationSource: null,
      qualityScore: 20,
    });

    const result = await service.excludeFromExternalValidation({
      emailId: 456,
      note: 'Manual decision from ZeroBounce preview',
    });

    expect(result).toEqual({
      excluded: true,
      emailId: 456,
      email: 'roxana.neacsu@sorantis.ro',
      reasonCode: 'external_validation_excluded',
    });
    expect(eventRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: ExternalValidationProvider.MANUAL,
        emailId: 456,
        mappedStatus: EmailValidationMappedStatus.DO_NOT_MAIL,
        sendEligibility: SendEligibility.DO_NOT_SEND,
        reasonCode: 'external_validation_excluded',
      }),
    );
    expect(emailRepository.update).toHaveBeenCalledWith(
      456,
      expect.objectContaining({
        sendEligibility: SendEligibility.DO_NOT_SEND,
        doNotSendReason: 'external_validation_excluded',
        lastValidationSource: ExternalValidationProvider.MANUAL,
      }),
    );
  });

  it('accepts ZeroBounce successful batch responses with an empty errors array', async () => {
    const response = new Response(JSON.stringify({
      email_batch: [
        {
          address: 'client@gmail.com',
          status: 'valid',
          sub_status: '',
        },
      ],
      errors: [],
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });

    await expect((service as any).readZeroBounceResponse('validatebatch', response))
      .resolves
      .toMatchObject({
        email_batch: [
          {
            address: 'client@gmail.com',
            status: 'valid',
          },
        ],
        errors: [],
      });
  });
});

function createQueryBuilderMock(options: { count: number; rows: any[] }) {
  const query: Record<string, jest.Mock> = {
    where: jest.fn(),
    andWhere: jest.fn(),
    orderBy: jest.fn(),
    addOrderBy: jest.fn(),
    select: jest.fn(),
    take: jest.fn(),
    getMany: jest.fn().mockResolvedValue(options.rows),
    getCount: jest.fn().mockResolvedValue(options.count),
    clone: jest.fn(),
  };

  Object.keys(query).forEach((key) => {
    if (!['getMany', 'getCount'].includes(key)) {
      query[key].mockReturnValue(query);
    }
  });
  query.clone.mockReturnValue(query);

  return query;
}
