import { Controller, Get, Param, ParseIntPipe, Query } from '@nestjs/common';
import { DomainsService } from '../services/domains.service';

@Controller('domains')
export class DomainsController {
  constructor(private readonly domainsService: DomainsService) {}

  @Get()
  async findAll(@Query('active') active?: string) {
    if (active === 'true') {
      return this.domainsService.findActive();
    }
    return this.domainsService.findAll();
  }

  @Get(':id')
  async findOne(@Param('id', ParseIntPipe) id: number) {
    return this.domainsService.findOne(id);
  }
}
