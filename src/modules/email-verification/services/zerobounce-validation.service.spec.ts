import { ZeroBounceValidationService } from './zerobounce-validation.service';
import { ExternalValidationImportService } from './external-validation-import.service';

describe('ZeroBounceValidationService', () => {
  let configService: {
    get: jest.Mock;
  };
  let emailRepository: {
    createQueryBuilder: jest.Mock;
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
    };
    externalValidationImportService = {
      importRows: jest.fn(),
    };
    service = new ZeroBounceValidationService(
      configService as any,
      emailRepository as any,
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
