import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Not } from 'typeorm';
import { Customer, PaymentMethod } from '../entities/customer.entity';
import { CustomerDomain } from '../entities/customer-domain.entity';
import * as mailcheck from 'mailcheck';

export interface CreateCustomerDto {
  email: string;
  firstName?: string;
  lastName?: string;
  phone?: string;
  company?: string;
  address_1?: string;
  address_2?: string;
  city?: string;
  state?: string;
  postcode?: string;
  country?: string;
  preferredPaymentMethod?: PaymentMethod;
  primaryDomainId?: number;
  woocommerceCustomerId?: string;
}

@Injectable()
export class CustomersService {
  private readonly logger = new Logger(CustomersService.name);
  private readonly commonEmailDomains = [
    'gmail.com',
    'yahoo.com',
    'ymail.com',
    'hotmail.com',
    'outlook.com',
    'icloud.com',
    'protonmail.com',
    'aol.com',
    'mail.com',
    'zoho.com',
  ];
  private readonly protectedEmailDomains = [
    'ymail.com',
    'rocketmail.com',
    'me.com',
    'mac.com',
    'email.com',
    'onmail.com',
  ];
  private readonly obviousTypoTlds = ['con', 'cim', 'cpm', 'coom', 'comm', 'vom'];

  constructor(
    @InjectRepository(Customer)
    private readonly customerRepository: Repository<Customer>,
    @InjectRepository(CustomerDomain)
    private readonly customerDomainRepository: Repository<CustomerDomain>,
  ) {}

  private normalizeOptionalString(value: string | undefined, maxLength: number): string | undefined {
    if (typeof value !== 'string') {
      return undefined;
    }

    const trimmed = value.trim();
    if (!trimmed) {
      return undefined;
    }

    return trimmed.length > maxLength ? trimmed.substring(0, maxLength) : trimmed;
  }

  private normalizeCustomerData(customerData: CreateCustomerDto): CreateCustomerDto {
    return {
      ...customerData,
      email: customerData.email.toLowerCase().trim(),
      firstName: this.normalizeOptionalString(customerData.firstName, 100),
      lastName: this.normalizeOptionalString(customerData.lastName, 100),
      phone: this.normalizeOptionalString(customerData.phone, 50),
      company: this.normalizeOptionalString(customerData.company, 100),
      address_1: this.normalizeOptionalString(customerData.address_1, 255),
      address_2: this.normalizeOptionalString(customerData.address_2, 255),
      city: this.normalizeOptionalString(customerData.city, 100),
      state: this.normalizeOptionalString(customerData.state, 100),
      postcode: this.normalizeOptionalString(customerData.postcode, 20),
      country: this.normalizeOptionalString(customerData.country, 10),
      woocommerceCustomerId: this.normalizeOptionalString(customerData.woocommerceCustomerId, 255),
    };
  }

  /**
   * Get all customers with pagination
   */
  async findAll(options: {
    page?: number;
    limit?: number;
    search?: string;
    domainId?: number;
    country?: string;
    city?: string;
    sortBy?: string;
    sortOrder?: 'ASC' | 'DESC';
  }): Promise<{ data: Customer[]; total: number }> {
    const page = options.page || 1;
    const limit = Math.min(options.limit || 100, 1000);
    const skip = (page - 1) * limit;

    const qb = this.customerRepository.createQueryBuilder('customer');

    // Search
    if (options.search) {
      qb.andWhere(
        '(customer.email LIKE :search OR customer.first_name LIKE :search OR customer.last_name LIKE :search OR customer.phone LIKE :search)',
        { search: `%${options.search}%` }
      );
    }

    // Filter by domain
    if (options.domainId) {
      qb.innerJoin('customer_domains', 'cd', 'cd.customer_id = customer.id')
        .andWhere('cd.domain_id = :domainId', { domainId: options.domainId });
    }

    // Filter by country
    if (options.country) {
      qb.andWhere('customer.country = :country', { country: options.country });
    }

    // Filter by city
    if (options.city) {
      qb.andWhere('customer.city LIKE :city', { city: `%${options.city}%` });
    }

    // Sorting
    const sortBy = options.sortBy || 'created_at';
    const sortOrder = options.sortOrder || 'DESC';

    // Map frontend column names to database columns
    const columnMap: { [key: string]: string } = {
      'name': 'customer.first_name',
      'email': 'customer.email',
      'phone': 'customer.phone',
      'city': 'customer.city',
      'country': 'customer.country',
      'createdAt': 'customer.created_at',
    };

    const sortColumn = columnMap[sortBy] || 'customer.created_at';

    const [data, total] = await qb
      .skip(skip)
      .take(limit)
      .orderBy(sortColumn, sortOrder)
      .getManyAndCount();

    return { data, total };
  }

  /**
   * Get customer by ID
   */
  async findOne(id: number): Promise<Customer> {
    const customer = await this.customerRepository.findOne({
      where: { id },
      relations: ['primaryDomain', 'emails'],
    });

    if (!customer) {
      throw new NotFoundException(`Customer with ID ${id} not found`);
    }

    return customer;
  }

  /**
   * Get customer by email
   */
  async findByEmail(email: string): Promise<Customer | null> {
    return this.customerRepository.findOne({
      where: { email: email.toLowerCase().trim() },
      relations: ['primaryDomain'],
    });
  }

  /**
   * Create or update customer (upsert by email)
   */
  async upsert(customerData: CreateCustomerDto): Promise<Customer> {
    const normalizedData = this.normalizeCustomerData(customerData);
    const normalizedEmail = normalizedData.email;

    // Check if customer exists
    let customer = await this.findByEmail(normalizedEmail);

    if (customer) {
      // Update existing customer
      await this.customerRepository.update(customer.id, {
        first_name: normalizedData.firstName || customer.first_name,
        last_name: normalizedData.lastName || customer.last_name,
        phone: normalizedData.phone || customer.phone,
        company: normalizedData.company || customer.company,
        address_1: normalizedData.address_1 || customer.address_1,
        address_2: normalizedData.address_2 || customer.address_2,
        city: normalizedData.city || customer.city,
        state: normalizedData.state || customer.state,
        postcode: normalizedData.postcode || customer.postcode,
        country: normalizedData.country || customer.country,
        preferred_payment_method: normalizedData.preferredPaymentMethod || customer.preferred_payment_method,
      });

      customer = await this.findOne(customer.id);
    } else {
      // Create new customer
      const newCustomer = this.customerRepository.create({
        email: normalizedEmail,
        first_name: normalizedData.firstName,
        last_name: normalizedData.lastName,
        phone: normalizedData.phone,
        company: normalizedData.company,
        address_1: normalizedData.address_1,
        address_2: normalizedData.address_2,
        city: normalizedData.city,
        state: normalizedData.state,
        postcode: normalizedData.postcode,
        country: normalizedData.country,
        preferred_payment_method: normalizedData.preferredPaymentMethod,
        primary_domain_id: normalizedData.primaryDomainId,
        woocommerce_customer_id: normalizedData.woocommerceCustomerId,
      });

      customer = await this.customerRepository.save(newCustomer);
    }

    return customer;
  }

  /**
   * Associate customer with domain
   */
  async associateWithDomain(
    customerId: number,
    domainId: number,
    data?: {
      woocommerceCustomerId?: string;
      orderCount?: number;
      totalSpent?: number;
      firstOrderDate?: Date;
      lastOrderDate?: Date;
    }
  ): Promise<CustomerDomain> {
    // Check if association exists
    let customerDomain = await this.customerDomainRepository.findOne({
      where: { customer_id: customerId, domain_id: domainId },
    });

    if (customerDomain) {
      // Update existing association
      await this.customerDomainRepository.update(customerDomain.id, {
        woocommerce_customer_id: data?.woocommerceCustomerId || customerDomain.woocommerce_customer_id,
        order_count: data?.orderCount || customerDomain.order_count,
        total_spent: data?.totalSpent || customerDomain.total_spent,
        first_order_date: data?.firstOrderDate || customerDomain.first_order_date,
        last_order_date: data?.lastOrderDate || customerDomain.last_order_date,
      });

      customerDomain = await this.customerDomainRepository.findOne({
        where: { id: customerDomain.id },
      });
    } else {
      // Create new association
      const newCustomerDomain = this.customerDomainRepository.create({
        customer_id: customerId,
        domain_id: domainId,
        woocommerce_customer_id: data?.woocommerceCustomerId,
        order_count: data?.orderCount || 0,
        total_spent: data?.totalSpent || 0,
        first_order_date: data?.firstOrderDate,
        last_order_date: data?.lastOrderDate,
      });

      customerDomain = await this.customerDomainRepository.save(newCustomerDomain);
    }

    return customerDomain;
  }

  /**
   * Get customer's domains
   */
  async getCustomerDomains(customerId: number): Promise<CustomerDomain[]> {
    return this.customerDomainRepository.find({
      where: { customer_id: customerId },
      relations: ['domain'],
    });
  }

  /**
   * Get total count
   */
  async getTotalCount(): Promise<number> {
    return this.customerRepository.count();
  }

  /**
   * Get overview analytics
   */
  async getOverviewAnalytics(): Promise<{
    total: number;
    withPhone: number;
    withoutPhone: number;
    fullProfile: number;
    averageEmailQuality: number;
  }> {
    const [total, withPhone, fullProfile, avgQualityResult] = await Promise.all([
      this.customerRepository.count(),
      this.customerRepository.count({
        where: {
          phone: Not(null),
        },
      }),
      this.customerRepository
        .createQueryBuilder('customer')
        .where('customer.phone IS NOT NULL')
        .andWhere('customer.first_name IS NOT NULL')
        .andWhere('customer.last_name IS NOT NULL')
        .getCount(),
      this.customerRepository
        .createQueryBuilder('customer')
        .leftJoin('emails', 'email', 'email.email = customer.email')
        .select('AVG(email.qualityScore)', 'average')
        .getRawOne(),
    ]);

    return {
      total,
      withPhone,
      withoutPhone: total - withPhone,
      fullProfile,
      averageEmailQuality: parseFloat(avgQualityResult?.average || '0'),
    };
  }

  /**
   * Get email quality breakdown for customers
   */
  async getEmailQualityBreakdown(): Promise<{
    valid: number;
    risky: number;
    invalid: number;
    pending: number;
    disposable: number;
    roleBased: number;
  }> {
    const [valid, risky, invalid, pending, disposable, roleBased] = await Promise.all([
      this.customerRepository
        .createQueryBuilder('customer')
        .leftJoin('emails', 'email', 'email.email = customer.email')
        .where('email.verificationStatus = :status', { status: 'valid' })
        .getCount(),
      this.customerRepository
        .createQueryBuilder('customer')
        .leftJoin('emails', 'email', 'email.email = customer.email')
        .where('email.verificationStatus = :status', { status: 'risky' })
        .getCount(),
      this.customerRepository
        .createQueryBuilder('customer')
        .leftJoin('emails', 'email', 'email.email = customer.email')
        .where('email.verificationStatus = :status', { status: 'invalid' })
        .getCount(),
      this.customerRepository
        .createQueryBuilder('customer')
        .leftJoin('emails', 'email', 'email.email = customer.email')
        .where('email.verificationStatus = :status', { status: 'pending' })
        .getCount(),
      this.customerRepository
        .createQueryBuilder('customer')
        .leftJoin('emails', 'email', 'email.email = customer.email')
        .where('email.isDisposable = true')
        .getCount(),
      this.customerRepository
        .createQueryBuilder('customer')
        .leftJoin('emails', 'email', 'email.email = customer.email')
        .where('email.isRoleBased = true')
        .getCount(),
    ]);

    return {
      valid,
      risky,
      invalid,
      pending,
      disposable,
      roleBased,
    };
  }

  /**
   * Get contact completeness analytics
   */
  async getContactCompleteness(): Promise<{
    fullProfile: number;
    emailAndName: number;
    emailOnly: number;
    incomplete: number;
  }> {
    const [fullProfile, emailAndName, emailOnly] = await Promise.all([
      // Full profile: email + phone + first name + last name
      this.customerRepository
        .createQueryBuilder('customer')
        .where('customer.phone IS NOT NULL')
        .andWhere('customer.first_name IS NOT NULL')
        .andWhere('customer.last_name IS NOT NULL')
        .getCount(),
      // Email + Name (no phone)
      this.customerRepository
        .createQueryBuilder('customer')
        .where('customer.phone IS NULL')
        .andWhere('customer.first_name IS NOT NULL')
        .andWhere('customer.last_name IS NOT NULL')
        .getCount(),
      // Email only (no phone, no name)
      this.customerRepository
        .createQueryBuilder('customer')
        .where('customer.phone IS NULL')
        .andWhere(
          '(customer.first_name IS NULL OR customer.last_name IS NULL)',
        )
        .getCount(),
    ]);

    const total = await this.customerRepository.count();
    const incomplete = total - fullProfile - emailAndName - emailOnly;

    return {
      fullProfile,
      emailAndName,
      emailOnly,
      incomplete,
    };
  }

  /**
   * Get email domain distribution for customers
   */
  async getEmailDomainDistribution(limit: number = 20): Promise<{
    domain: string;
    count: number;
    percentage: number;
    isSuspectedTypo: boolean;
    suggestedDomain?: string;
  }[]> {
    const total = await this.customerRepository.count();

    const results = await this.customerRepository
      .createQueryBuilder('customer')
      .select('SUBSTRING_INDEX(customer.email, "@", -1)', 'domain')
      .addSelect('COUNT(*)', 'count')
      .groupBy('domain')
      .orderBy('count', 'DESC')
      .limit(limit)
      .getRawMany();

    return results.map((row) => {
      const count = parseInt(row.count, 10);
      const typoSuggestion = this.getDomainTypoSuggestion(row.domain);
      return {
        domain: row.domain,
        count,
        percentage: total > 0 ? (count / total) * 100 : 0,
        isSuspectedTypo: !!typoSuggestion,
        suggestedDomain: typoSuggestion || undefined,
      };
    });
  }

  private getDomainTypoSuggestion(domain: string): string | null {
    if (!domain || this.protectedEmailDomains.includes(domain)) {
      return null;
    }

    const suggestion = mailcheck.run({
      email: `customer@${domain}`,
      domains: this.commonEmailDomains,
    });

    if (!suggestion?.domain || suggestion.domain === domain) {
      return null;
    }

    if (!this.commonEmailDomains.includes(suggestion.domain)) {
      return null;
    }

    const originalParts = domain.split('.');
    const suggestedParts = suggestion.domain.split('.');
    const originalTld = originalParts[originalParts.length - 1];
    const suggestedTld = suggestedParts[suggestedParts.length - 1];
    const originalBase = this.normalizeDomainBase(domain);
    const suggestedBase = this.normalizeDomainBase(suggestion.domain);

    if (originalTld.length === 2 && originalTld !== suggestedTld) {
      return null;
    }

    if (originalTld !== suggestedTld) {
      if (originalBase !== suggestedBase || !this.obviousTypoTlds.includes(originalTld)) {
        return null;
      }
      return suggestion.domain;
    }

    if (!this.isAllowedProviderTypo(domain, suggestion.domain)) {
      return null;
    }

    return suggestion.domain;
  }

  private normalizeDomainBase(domain: string): string {
    return (domain.split('.')[0] || '').replace(/[^a-z0-9]/gi, '').toLowerCase();
  }

  private isAllowedProviderTypo(originalDomain: string, suggestedDomain: string): boolean {
    const originalBase = this.normalizeDomainBase(originalDomain);
    const suggestedBase = this.normalizeDomainBase(suggestedDomain);

    if (!originalBase || !suggestedBase) {
      return false;
    }

    if (originalDomain === `${suggestedDomain}.com`) {
      return true;
    }

    if (originalBase === suggestedBase) {
      return true;
    }

    const trimmedOriginal = originalBase.replace(/^\d+/, '');
    const restrictedShortProviders = ['aol', 'mail', 'zoho'];
    if (restrictedShortProviders.includes(suggestedBase)) {
      return false;
    }

    const minimumLengths: Record<string, number> = {
      gmail: 4,
      yahoo: 4,
      ymail: 4,
      hotmail: 5,
      outlook: 5,
      icloud: 5,
      protonmail: 8,
    };

    const minimumLength = minimumLengths[suggestedBase];
    if (!minimumLength || trimmedOriginal.length < minimumLength) {
      return false;
    }

    if (suggestedBase === 'hotmail' && !trimmedOriginal.startsWith('h')) {
      return false;
    }

    if (suggestedBase === 'outlook' && !trimmedOriginal.startsWith('o')) {
      return false;
    }

    return true;
  }

  /**
   * Get risk assessment for customers
   */
  async getRiskAssessment(): Promise<{
    disposableEmails: number;
    roleBasedEmails: number;
    invalidEmails: number;
    totalRisky: number;
  }> {
    const [disposableEmails, roleBasedEmails, invalidEmails] = await Promise.all([
      this.customerRepository
        .createQueryBuilder('customer')
        .leftJoin('emails', 'email', 'email.email = customer.email')
        .where('email.isDisposable = true')
        .getCount(),
      this.customerRepository
        .createQueryBuilder('customer')
        .leftJoin('emails', 'email', 'email.email = customer.email')
        .where('email.isRoleBased = true')
        .getCount(),
      this.customerRepository
        .createQueryBuilder('customer')
        .leftJoin('emails', 'email', 'email.email = customer.email')
        .where('email.verificationStatus = :status', { status: 'invalid' })
        .getCount(),
    ]);

    return {
      disposableEmails,
      roleBasedEmails,
      invalidEmails,
      totalRisky: disposableEmails + roleBasedEmails + invalidEmails,
    };
  }
}
