import { GmailService } from './gmail.service';
import { PaymentMethod } from '../../customers/entities/customer.entity';
import { SendEligibilityService } from '../../emails/services/send-eligibility.service';

describe('GmailService smart scan helpers', () => {
  let service: any;
  const sendEligibilityService = new SendEligibilityService();
  const bounceRecoveryService = {
    createCandidateFromBounce: jest.fn().mockResolvedValue(null),
  };
  const filterValidator = {
    validate: jest.fn().mockReturnValue({
      isDisposable: false,
      isRoleBased: false,
      hasSuggestedCorrection: false,
      suggestedEmail: undefined,
    }),
  };

  beforeEach(() => {
    filterValidator.validate.mockClear();
    bounceRecoveryService.createCandidateFromBounce.mockClear();
    filterValidator.validate.mockReturnValue({
      isDisposable: false,
      isRoleBased: false,
      hasSuggestedCorrection: false,
      suggestedEmail: undefined,
    });

    service = new GmailService(
      {} as any,
      { isAvailable: jest.fn().mockReturnValue(false) } as any,
      { updateProgress: jest.fn() } as any,
      { upsert: jest.fn() } as any,
      filterValidator as any,
      sendEligibilityService as any,
      bounceRecoveryService as any,
    ) as any;
  });

  it('parses WooCommerce order customer details from billing block', () => {
    const body = `Comandă nouă: nr. 243765

Ai primit următoarea comandă de la Cristian Copilau:

Metodă de plată:
Numerar la livrare

Total:
lei189,00

Adresă de facturare

Cristian Copilau
aleea Callatis 10
Bl. D8, sc.E, ap.43
Bucuresti
București
061925
+40733595730

cristian.copilau@gmail.com

Adresă de livrare

Cristian Copilau`;

    const parsed = service.parseWooCommerceOrderCustomer(body);

    expect(parsed).toMatchObject({
      email: 'cristian.copilau@gmail.com',
      firstName: 'Cristian',
      lastName: 'Copilau',
      fullName: 'Cristian Copilau',
      phone: '+40733595730',
      address_1: 'aleea Callatis 10',
      address_2: 'Bl. D8, sc.E, ap.43',
      city: 'Bucuresti',
      state: 'București',
      postcode: '061925',
      country: 'RO',
      preferredPaymentMethod: PaymentMethod.CASH_ON_DELIVERY,
    });
  });

  it('returns null for order emails without billing customer email', () => {
    const parsed = service.parseWooCommerceOrderCustomer(`Comandă nouă: nr. 1

Adresă de facturare

Client Fara Email
Bucuresti

Adresă de livrare
Client Fara Email`);

    expect(parsed).toBeNull();
  });

  it('does not parse internal support footer as the order customer', () => {
    const parsed = service.parseWooCommerceOrderCustomer(`Comandă nouă: nr. 243875

Adresă de facturare

Sesizari si garantii: suport@fabricadeasternuturi.ro
Fabricadeasternuturi.ro © 2022.`);

    expect(parsed).toBeNull();
  });

  it('parses compact Gmail API WooCommerce plain text with mailto and tel links', () => {
    const body = `Fabricadeasternuturi.ro\r
Comandă nouă: nr. 243715\r
Metodă de plată:Visa ending in 5714Total:lei358,00Adresă de facturare
\t\t\t\tDRAGOS GHEORGON\r
Raiului\r
Nr. 3\r
OSTRATU\r
Ilfov\r
077066\t\t\t\t\t\t\t\t\t\r
\r
<tel:0722889686>\r
0722889686\r
\r
<mailto:diana.gheorgon@yahoo.com>\r
diana.gheorgon@yahoo.comAdresă de livrareDRAGOS GHEORGON\r
Raiului\r
Nr. 3\r
OSTRATU\r
Ilfov\r
077066`;

    const parsed = service.parseWooCommerceOrderCustomer(body);

    expect(parsed).toMatchObject({
      email: 'diana.gheorgon@yahoo.com',
      firstName: 'DRAGOS',
      lastName: 'GHEORGON',
      phone: '0722889686',
      address_1: 'Raiului',
      address_2: 'Nr. 3',
      city: 'OSTRATU',
      state: 'Ilfov',
      postcode: '077066',
      preferredPaymentMethod: PaymentMethod.CARD,
    });
  });

  it('treats newsletter headers as skippable but not customer replies', () => {
    const newsletterHeaders = [
      { name: 'List-Unsubscribe', value: '<mailto:unsubscribe@example.com>' },
    ];
    const replyHeaders = [
      { name: 'List-Unsubscribe', value: '<mailto:unsubscribe@example.com>' },
      { name: 'In-Reply-To', value: '<message-id>' },
    ];

    expect(service.isNewsletterByHeaders(newsletterHeaders, 'Weekly update')).toBe(true);
    expect(service.isNewsletterByHeaders(replyHeaders, 'Re: Comanda #123')).toBe(false);
  });

  it('builds the default smart scan query without spam and trash', () => {
    expect(service.buildSmartScanQuery()).toBe('in:anywhere -in:trash -in:spam');
  });

  it('builds smart scan query for explicit historical windows', () => {
    expect(service.buildSmartScanQuery({
      afterDate: '2026-06-01',
      beforeDate: '2026-07-01',
    })).toBe('in:anywhere -in:trash -in:spam after:2026/06/01 before:2026/07/01');
  });

  it('can include spam and trash when explicitly requested', () => {
    expect(service.buildSmartScanQuery({
      afterDate: '2026-06-01',
      includeSpamTrash: true,
    })).toBe('in:anywhere after:2026/06/01');
  });

  it('does not classify order cancellation as unsubscribe by pattern', () => {
    const text = 'Vreau să anulez comanda nr. 123';

    expect(service.hasAnyPattern(service.unsubscribePatterns, text)).toBe(false);
  });

  it('extracts failed recipients from standard bounce headers', () => {
    const headers = [
      { name: 'From', value: 'Mail Delivery Subsystem <mailer-daemon@googlemail.com>' },
      { name: 'X-Failed-Recipients', value: 'client.gresit@gamil.com' },
    ];

    expect(
      service.extractFailedRecipientFromBounce(
        headers,
        'Delivery Status Notification',
        'mailer-daemon@googlemail.com',
      ),
    ).toBe('client.gresit@gamil.com');
  });

  it('extracts failed recipients from delivery-status body parts', () => {
    const body = `Reporting-MTA: dns; googlemail.com
Final-Recipient: rfc822; vpop0707@gmail.con
Action: failed
Status: 5.1.1
Diagnostic-Code: smtp; 550-5.1.1 The email account that you tried to reach does not exist.`;

    expect(
      service.extractFailedRecipientFromBounce([], body, 'mailer-daemon@googlemail.com'),
    ).toBe('vpop0707@gmail.con');
  });

  it('extracts failed recipients from human-readable bounce text', () => {
    const body = `Your message wasn't delivered to client@yahoo.con because the address couldn't be found, or is unable to receive mail.`;

    expect(
      service.extractFailedRecipientFromBounce([], body, 'mailer-daemon@googlemail.com'),
    ).toBe('client@yahoo.con');
  });

  it('does not return the mailer-daemon sender as failed recipient', () => {
    const body = `Delivery to mailer-daemon@googlemail.com failed with user unknown.`;

    expect(
      service.extractFailedRecipientFromBounce([], body, 'mailer-daemon@googlemail.com'),
    ).toBeNull();
  });

  it('preserves unsubscribed status when an order later updates the same email', async () => {
    const emailRepository = {
      findOne: jest.fn().mockResolvedValue({
        id: 10,
        email: 'client@example.com',
        verificationStatus: 'unsubscribed',
      }),
      update: jest.fn(),
      save: jest.fn(),
    };
    const customersService = {
      upsert: jest.fn().mockResolvedValue({ id: 20 }),
    };

    const localService = new GmailService(
      emailRepository as any,
      { isAvailable: jest.fn().mockReturnValue(false) } as any,
      { updateProgress: jest.fn() } as any,
      customersService as any,
      filterValidator as any,
      sendEligibilityService as any,
      bounceRecoveryService as any,
    ) as any;

    await localService.markEmailAsValid('client@example.com', {
      firstName: 'Client',
      gmailMessageDate: new Date('2026-05-05T00:00:00Z'),
    });

    expect(emailRepository.update).toHaveBeenCalledWith(
      10,
      expect.not.objectContaining({
        verificationStatus: expect.anything(),
        gmailCategory: expect.anything(),
      }),
    );
    expect(emailRepository.update).toHaveBeenCalledWith(
      10,
      expect.objectContaining({
        customerId: 20,
        firstName: 'Client',
      }),
    );
  });

  it('does not promote manually ignored test emails from later order scans', async () => {
    const emailRepository = {
      findOne: jest.fn().mockResolvedValue({
        id: 11,
        email: 'client@example.com',
        acquisitionSource: 'quality_gate_test',
        verificationStatus: 'invalid',
      }),
      update: jest.fn(),
      save: jest.fn(),
    };
    const customersService = {
      upsert: jest.fn().mockResolvedValue({ id: 20 }),
    };

    const localService = new GmailService(
      emailRepository as any,
      { isAvailable: jest.fn().mockReturnValue(false) } as any,
      { updateProgress: jest.fn() } as any,
      customersService as any,
      filterValidator as any,
      sendEligibilityService as any,
      bounceRecoveryService as any,
    ) as any;

    await expect(localService.markEmailAsValid('client@example.com')).resolves.toBe(false);

    expect(customersService.upsert).not.toHaveBeenCalled();
    expect(emailRepository.update).not.toHaveBeenCalled();
    expect(emailRepository.save).not.toHaveBeenCalled();
  });

  it('does not promote invalid emails from later order scans', async () => {
    const emailRepository = {
      findOne: jest.fn().mockResolvedValue({
        id: 14,
        email: 'client@example.com',
        verificationStatus: 'invalid',
        gmailCategory: 'bounce',
      }),
      update: jest.fn(),
      save: jest.fn(),
    };
    const customersService = {
      upsert: jest.fn().mockResolvedValue({ id: 20 }),
    };
    const localService = new GmailService(
      emailRepository as any,
      { isAvailable: jest.fn().mockReturnValue(false) } as any,
      { updateProgress: jest.fn() } as any,
      customersService as any,
      filterValidator as any,
      sendEligibilityService as any,
      bounceRecoveryService as any,
    ) as any;

    await expect(localService.markEmailAsValid('client@example.com')).resolves.toBe(false);

    expect(customersService.upsert).toHaveBeenCalledWith(expect.objectContaining({
      email: 'client@example.com',
    }));
    expect(emailRepository.update).toHaveBeenCalledWith(
      14,
      expect.not.objectContaining({
        verificationStatus: expect.anything(),
        qualityScore: expect.anything(),
        gmailCategory: expect.anything(),
        sendEligibility: expect.anything(),
      }),
    );
    expect(emailRepository.update).toHaveBeenCalledWith(
      14,
      expect.objectContaining({
        customerId: 20,
      }),
    );
  });

  it('lets a later bounce override unsubscribe for deliverability while preserving history in reason', async () => {
    const emailRepository = {
      findOne: jest.fn().mockResolvedValue({
        id: 15,
        email: 'client@example.com',
        verificationStatus: 'unsubscribed',
        gmailCategory: 'unsubscribe',
        qualityScore: 0,
      }),
      update: jest.fn(),
      save: jest.fn(),
    };
    const localService = new GmailService(
      emailRepository as any,
      { isAvailable: jest.fn().mockReturnValue(false) } as any,
      { updateProgress: jest.fn() } as any,
      { upsert: jest.fn() } as any,
      filterValidator as any,
      sendEligibilityService as any,
      bounceRecoveryService as any,
    ) as any;

    await expect(localService.markEmailAsInvalid('client@example.com')).resolves.toBe(false);

    expect(emailRepository.update).toHaveBeenCalledWith(
      15,
      expect.objectContaining({
        verificationStatus: 'invalid',
        gmailCategory: 'bounce',
        sendEligibility: 'do_not_send',
        doNotSendReason: 'bounce_after_unsubscribe',
        smtpErrorMessage: 'Bounce-back detected from Gmail after unsubscribe',
      }),
    );
    expect(emailRepository.save).not.toHaveBeenCalled();
  });

  it('truncates long email metadata extracted from Gmail before saving to emails', async () => {
    const emailRepository = {
      findOne: jest.fn().mockResolvedValue({
        id: 13,
        email: 'client@example.com',
        verificationStatus: 'pending',
      }),
      update: jest.fn(),
      save: jest.fn(),
    };
    const customersService = {
      upsert: jest.fn().mockResolvedValue({ id: 20 }),
    };
    const localService = new GmailService(
      emailRepository as any,
      { isAvailable: jest.fn().mockReturnValue(false) } as any,
      { updateProgress: jest.fn() } as any,
      customersService as any,
      filterValidator as any,
      sendEligibilityService as any,
      bounceRecoveryService as any,
    ) as any;
    const longCity = 'Bucuresti '.repeat(20);

    await localService.markEmailAsValid('client@example.com', {
      firstName: 'Client',
      city: longCity,
      country: 'Romania-Too-Long',
      phone: '0'.repeat(80),
    });

    expect(emailRepository.update).toHaveBeenCalledWith(
      13,
      expect.objectContaining({
        city: expect.stringMatching(/^Bucuresti/),
        country: 'Romania-To',
        phone: '0'.repeat(50),
      }),
    );
    const updated = emailRepository.update.mock.calls[0][1];
    expect(updated.city).toHaveLength(100);
  });

  it('stores typo order emails for review instead of marking them as valid', async () => {
    const emailRepository = {
      findOne: jest.fn().mockResolvedValue(null),
      update: jest.fn(),
      save: jest.fn(),
    };
    const customersService = {
      upsert: jest.fn(),
    };
    const typoFilterValidator = {
      validate: jest.fn().mockReturnValue({
        isDisposable: false,
        isRoleBased: false,
        hasSuggestedCorrection: true,
        suggestedEmail: 'client@gmail.com',
      }),
    };

    const localService = new GmailService(
      emailRepository as any,
      { isAvailable: jest.fn().mockReturnValue(false) } as any,
      { updateProgress: jest.fn() } as any,
      customersService as any,
      typoFilterValidator as any,
      sendEligibilityService as any,
      bounceRecoveryService as any,
    ) as any;

    await localService.markEmailAsValid('client@gamil.com', {
      firstName: 'Client',
      gmailMessageDate: new Date('2026-05-05T00:00:00Z'),
    });

    expect(customersService.upsert).not.toHaveBeenCalled();
    expect(emailRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({
        email: 'client@gamil.com',
        verificationStatus: 'risky',
        hasTypo: true,
        typoSuggestion: 'client@gmail.com',
        gmailCategory: 'order',
      }),
    );
  });

  it('does not put manually ignored test typo emails back into review', async () => {
    const emailRepository = {
      findOne: jest.fn().mockResolvedValue({
        id: 12,
        email: 'client@gamil.com',
        acquisitionSource: 'quality_gate_test',
        verificationStatus: 'invalid',
        hasTypo: false,
        typoResolutionStatus: 'ignored',
      }),
      update: jest.fn(),
      save: jest.fn(),
    };
    const customersService = {
      upsert: jest.fn(),
    };
    const typoFilterValidator = {
      validate: jest.fn().mockReturnValue({
        isDisposable: false,
        isRoleBased: false,
        hasSuggestedCorrection: true,
        suggestedEmail: 'client@gmail.com',
      }),
    };

    const localService = new GmailService(
      emailRepository as any,
      { isAvailable: jest.fn().mockReturnValue(false) } as any,
      { updateProgress: jest.fn() } as any,
      customersService as any,
      typoFilterValidator as any,
      sendEligibilityService as any,
      bounceRecoveryService as any,
    ) as any;

    await expect(localService.markEmailAsValid('client@gamil.com')).resolves.toBe(false);

    expect(customersService.upsert).not.toHaveBeenCalled();
    expect(emailRepository.update).not.toHaveBeenCalled();
    expect(emailRepository.save).not.toHaveBeenCalled();
  });
});
