import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import { FastifyReply } from 'fastify';
import {
  CampaignExportEligibility,
  EmailsService,
  NeverBounceExportSegment,
  TypoResolutionAction,
  TypoResolutionStatus,
} from '../services/emails.service';
import { VerificationStatus } from '@shared/enums/verification-status.enum';
import { SendEligibility } from '@shared/enums/email-validation.enum';

@Controller('emails')
export class EmailsController {
  constructor(private readonly emailsService: EmailsService) {}

  @Get()
  async findAll(
    @Query('page') page?: number,
    @Query('limit') limit?: number,
    @Query('status') status?: VerificationStatus,
    @Query('minScore') minScore?: number,
    @Query('search') search?: string,
    @Query('emailDomain') emailDomain?: string,
    @Query('hasTypo') hasTypo?: string,
    @Query('typoResolutionStatus') typoResolutionStatus?: TypoResolutionStatus,
    @Query('sendEligibility') sendEligibility?: SendEligibility,
    @Query('doNotSendReason') doNotSendReason?: string,
  ) {
    const { data, total } = await this.emailsService.findAll({
      page: page || 1,
      limit: limit || 100,
      status,
      minScore,
      search,
      emailDomain,
      hasTypo: hasTypo === undefined ? undefined : hasTypo === 'true',
      typoResolutionStatus,
      sendEligibility,
      doNotSendReason,
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
    const [total, byStatus] = await Promise.all([
      this.emailsService.getTotalCount(),
      this.emailsService.getCountByStatus(),
    ]);

    return {
      total,
      byStatus,
    };
  }

  @Get('domains')
  async getEmailDomains(@Query('limit') limit?: number) {
    return this.emailsService.getEmailDomains(limit || 100);
  }

  @Get('analytics/overview')
  async getAnalyticsOverview() {
    return this.emailsService.getOverviewAnalytics();
  }

  @Get('analytics/quality-distribution')
  async getQualityDistribution() {
    return this.emailsService.getQualityScoreDistribution();
  }

  @Get('analytics/customer-linkage')
  async getCustomerLinkage() {
    return this.emailsService.getCustomerLinkageByDomain();
  }

  @Get('analytics/email-providers')
  async getEmailProviders() {
    return this.emailsService.getEmailProviderAnalytics();
  }

  @Get('analytics/risk-assessment')
  async getRiskAssessment() {
    return this.emailsService.getRiskAssessment();
  }

  @Get('analytics/deliverability')
  async getDeliverability() {
    return this.emailsService.getDeliverabilityScore();
  }

  @Get('analytics/send-eligibility')
  async getSendEligibilityAnalytics() {
    return this.emailsService.getSendEligibilityAnalytics();
  }

  @Get('campaign/preview')
  async getCampaignPreview(
    @Query('eligibility') eligibility?: CampaignExportEligibility,
    @Query('domain') domain?: string,
    @Query('batch') batch?: number,
    @Query('limit') limit?: number,
  ) {
    try {
      return await this.emailsService.getCampaignExportPreview({
        eligibility,
        domain,
        batch,
        limit,
      });
    } catch (error) {
      throw new BadRequestException(error.message);
    }
  }

  @Get('campaign/export.csv')
  async exportCampaignCsv(
    @Res({ passthrough: false }) reply: FastifyReply,
    @Query('eligibility') eligibility?: CampaignExportEligibility,
    @Query('domain') domain?: string,
    @Query('batch') batch?: number,
    @Query('limit') limit?: number,
  ) {
    try {
      const result = await this.emailsService.buildCampaignCsv({
        eligibility,
        domain,
        batch,
        limit,
      });

      reply
        .header('Content-Type', 'text/csv; charset=utf-8')
        .header('Content-Disposition', `attachment; filename="${result.filename}"`)
        .send(result.csv);
    } catch (error) {
      throw new BadRequestException(error.message);
    }
  }

  @Get('neverbounce/preview')
  async getNeverBouncePreview(
    @Query('segment') segment?: NeverBounceExportSegment,
    @Query('domain') domain?: string,
    @Query('batch') batch?: number,
    @Query('limit') limit?: number,
  ) {
    try {
      return await this.emailsService.getNeverBounceExportPreview({
        segment: segment || 'typo_resolved',
        domain,
        batch,
        limit,
      });
    } catch (error) {
      throw new BadRequestException(error.message);
    }
  }

  @Get('neverbounce/export.csv')
  async exportNeverBounceCsv(
    @Res({ passthrough: false }) reply: FastifyReply,
    @Query('segment') segment?: NeverBounceExportSegment,
    @Query('domain') domain?: string,
    @Query('batch') batch?: number,
    @Query('limit') limit?: number,
  ) {
    try {
      const result = await this.emailsService.buildNeverBounceCsv({
        segment: segment || 'typo_resolved',
        domain,
        batch,
        limit,
      });

      reply
        .header('Content-Type', 'text/csv; charset=utf-8')
        .header('Content-Disposition', `attachment; filename="${result.filename}"`)
        .send(result.csv);
    } catch (error) {
      throw new BadRequestException(error.message);
    }
  }

  @Post('typos/resolve-bulk')
  async resolveTypoCandidatesBulk(
    @Body('emailIds') emailIds: number[],
    @Body('action') action: TypoResolutionAction,
  ) {
    if (!['accept', 'ignore', 'reset'].includes(action)) {
      throw new BadRequestException('Invalid typo resolution action');
    }

    return {
      success: true,
      result: await this.emailsService.resolveTypoCandidatesBulk({ emailIds, action }),
    };
  }

  @Patch(':id/typo-resolution')
  async resolveTypoCandidate(
    @Param('id', ParseIntPipe) id: number,
    @Body('action') action: TypoResolutionAction,
    @Body('resolvedEmail') resolvedEmail?: string,
    @Body('note') note?: string,
  ) {
    if (!['accept', 'ignore', 'reset'].includes(action)) {
      throw new BadRequestException('Invalid typo resolution action');
    }

    try {
      return {
        success: true,
        email: await this.emailsService.resolveTypoCandidate(id, {
          action,
          resolvedEmail,
          note,
        }),
      };
    } catch (error) {
      throw new BadRequestException(error.message);
    }
  }

  @Get(':id')
  async findOne(@Param('id', ParseIntPipe) id: number) {
    return this.emailsService.findOne(id);
  }

  @Patch(':id/status')
  async updateStatus(
    @Param('id', ParseIntPipe) id: number,
    @Body('status') status: VerificationStatus,
  ) {
    await this.emailsService.updateVerificationStatus(id, {
      verificationStatus: status,
    });

    return { success: true };
  }

  @Post('quality/test')
  async markAsTestEmail(
    @Body('email') email: string,
    @Body('reason') reason?: string,
    @Body('sourceIdentifier') sourceIdentifier?: string,
  ) {
    const result = await this.emailsService.markAsTestEmail(email, {
      reason,
      sourceIdentifier,
    });

    return {
      success: true,
      email: {
        id: result.id,
        email: result.email,
        verificationStatus: result.verificationStatus,
        qualityScore: result.qualityScore,
      },
    };
  }
}
