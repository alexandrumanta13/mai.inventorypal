import { Controller, Get, Param, Query, ParseIntPipe } from '@nestjs/common';
import { CustomersService } from '../services/customers.service';

@Controller('customers')
export class CustomersController {
  constructor(private readonly customersService: CustomersService) {}

  @Get()
  async findAll(
    @Query('page') page?: number,
    @Query('limit') limit?: number,
    @Query('search') search?: string,
    @Query('domainId') domainId?: number,
    @Query('country') country?: string,
    @Query('city') city?: string,
    @Query('sortBy') sortBy?: string,
    @Query('sortOrder') sortOrder?: 'ASC' | 'DESC',
  ) {
    const { data, total } = await this.customersService.findAll({
      page: page || 1,
      limit: limit || 100,
      search,
      domainId,
      country,
      city,
      sortBy,
      sortOrder,
    });

    return {
      data,
      pagination: {
        page: page || 1,
        limit: limit || 100,
        total,
        totalPages: Math.ceil(total / (limit || 100)),
      },
    };
  }

  @Get('stats')
  async getStats() {
    const total = await this.customersService.getTotalCount();

    return {
      total,
    };
  }

  @Get('analytics/overview')
  async getAnalyticsOverview() {
    return this.customersService.getOverviewAnalytics();
  }

  @Get('analytics/email-quality')
  async getEmailQuality() {
    return this.customersService.getEmailQualityBreakdown();
  }

  @Get('analytics/contact-completeness')
  async getContactCompleteness() {
    return this.customersService.getContactCompleteness();
  }

  @Get('analytics/email-domains')
  async getEmailDomains(@Query('limit') limit?: number) {
    return this.customersService.getEmailDomainDistribution(limit || 20);
  }

  @Get('analytics/risk-assessment')
  async getRiskAssessment() {
    return this.customersService.getRiskAssessment();
  }

  @Get(':id')
  async findOne(@Param('id', ParseIntPipe) id: number) {
    return this.customersService.findOne(id);
  }

  @Get(':id/domains')
  async getCustomerDomains(@Param('id', ParseIntPipe) id: number) {
    return this.customersService.getCustomerDomains(id);
  }
}
