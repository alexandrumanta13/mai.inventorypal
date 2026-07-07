import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Domain } from '../entities/domain.entity';

@Injectable()
export class DomainsService {
  private readonly logger = new Logger(DomainsService.name);

  constructor(
    @InjectRepository(Domain)
    private readonly domainRepository: Repository<Domain>,
  ) {}

  /**
   * Get all domains
   */
  async findAll(): Promise<Domain[]> {
    return this.domainRepository.find({
      order: { id: 'ASC' },
    });
  }

  /**
   * Get active domains only
   */
  async findActive(): Promise<Domain[]> {
    return this.domainRepository.find({
      where: { is_active: true },
      order: { id: 'ASC' },
    });
  }

  /**
   * Get domain by ID
   */
  async findOne(id: number): Promise<Domain> {
    const domain = await this.domainRepository.findOne({
      where: { id },
      relations: ['customers'],
    });

    if (!domain) {
      throw new NotFoundException(`Domain with ID ${id} not found`);
    }

    return domain;
  }

  /**
   * Get domain by domain name
   */
  async findByDomainName(domainName: string): Promise<Domain> {
    const domain = await this.domainRepository.findOne({
      where: { domain_name: domainName },
    });

    if (!domain) {
      throw new NotFoundException(`Domain ${domainName} not found`);
    }

    return domain;
  }

  /**
   * Create a new domain
   */
  async create(domainData: Partial<Domain>): Promise<Domain> {
    const domain = this.domainRepository.create(domainData);
    return this.domainRepository.save(domain);
  }

  /**
   * Update domain
   */
  async update(id: number, domainData: Partial<Domain>): Promise<Domain> {
    await this.domainRepository.update(id, domainData);
    return this.findOne(id);
  }
}
