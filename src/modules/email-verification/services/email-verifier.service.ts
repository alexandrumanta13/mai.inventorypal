import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Email } from '@modules/emails/entities/email.entity';
import { Customer } from '@modules/customers/entities/customer.entity';
import { VerificationHistory } from '../entities/verification-history.entity';
import { VerificationStatus } from '@shared/enums/verification-status.enum';
import { ExternalValidationProvider } from '@shared/enums/email-validation.enum';
import { extractEmailDomain, isPublicMailboxDomain } from '@shared/email-domain-classification';
import { SendEligibilityService } from '@modules/emails/services/send-eligibility.service';
import { SyntaxValidator } from '../validators/syntax.validator';
import { DnsValidator } from '../validators/dns.validator';
import { SmtpValidator } from '../validators/smtp.validator';
import { FilterValidator } from '../validators/filter.validator';

export interface VerificationResult {
  email: string;
  status: VerificationStatus;
  qualityScore: number;
  hasValidSyntax: boolean;
  hasValidDns: boolean;
  hasValidSmtp: boolean;
  isDisposable: boolean;
  isRoleBased: boolean;
  suggestedEmail?: string;
  details: {
    syntax: any;
    dns: any;
    smtp: any;
    filter: any;
  };
  durationMs: number;
}

export interface TypoAuditResult {
  scanned: number;
  typosFound: number;
  updated: number;
  clean: number;
  remaining: number;
  completed: boolean;
  dryRun: boolean;
  afterId: number;
  nextAfterId: number | null;
  rows: Array<{
    id: number;
    email: string;
    suggestedEmail: string;
    status: VerificationStatus;
    updated: boolean;
  }>;
}

/**
 * Email Verifier Service - Orchestrator for 4-layer verification
 *
 * Coordinates all 4 validation layers:
 * 1. Syntax Validation (RFC 5322)
 * 2. DNS/MX Record Validation
 * 3. SMTP Handshake Validation (NO sending)
 * 4. Filter Validation (disposable, role-based, typos)
 *
 * Calculates quality score (0-100) based on all layer results
 * Saves verification history for audit trail
 * Updates email record with latest verification status
 */
@Injectable()
export class EmailVerifierService {
  private readonly logger = new Logger(EmailVerifierService.name);

  constructor(
    @InjectRepository(Email)
    private readonly emailRepository: Repository<Email>,
    @InjectRepository(Customer)
    private readonly customerRepository: Repository<Customer>,
    @InjectRepository(VerificationHistory)
    private readonly verificationHistoryRepository: Repository<VerificationHistory>,
    private readonly syntaxValidator: SyntaxValidator,
    private readonly dnsValidator: DnsValidator,
    private readonly smtpValidator: SmtpValidator,
    private readonly filterValidator: FilterValidator,
    private readonly sendEligibilityService: SendEligibilityService,
  ) {}

  /**
   * Verify single email through all 4 layers
   */
  async verifyEmail(email: string, skipSmtp: boolean = false): Promise<VerificationResult> {
    const startTime = Date.now();
    const normalizedEmail = email.trim().toLowerCase();

    this.logger.log(`Starting verification for: ${normalizedEmail}`);

    // Layer 1: Syntax Validation
    const syntaxResult = this.syntaxValidator.validate(normalizedEmail);

    if (!syntaxResult.isValid) {
      // If syntax fails, no need to continue
      const result = this.createFailedResult(
        normalizedEmail,
        VerificationStatus.INVALID,
        0,
        { syntax: syntaxResult },
        Date.now() - startTime,
      );

      await this.saveVerification(normalizedEmail, result);
      return result;
    }

    // Layer 2: DNS Validation
    const dnsResult = await this.dnsValidator.validate(normalizedEmail);

    if (!dnsResult.isValid) {
      // If DNS fails, email is invalid
      const result = this.createFailedResult(
        normalizedEmail,
        VerificationStatus.INVALID,
        20, // Syntax passed (20 points)
        { syntax: syntaxResult, dns: dnsResult },
        Date.now() - startTime,
      );

      await this.saveVerification(normalizedEmail, result);
      return result;
    }

    // Layer 4: Filter Validation (before SMTP to save time on known bad emails)
    const filterResult = this.filterValidator.validate(normalizedEmail);

    if (filterResult.isDisposable) {
      // Disposable email - mark as such
      const result = this.createResult(
        normalizedEmail,
        VerificationStatus.DISPOSABLE,
        30, // Syntax + DNS passed, but disposable
        syntaxResult.isValid,
        dnsResult.isValid,
        false,
        true,
        filterResult.isRoleBased,
        filterResult.suggestedEmail,
        {
          syntax: syntaxResult,
          dns: dnsResult,
          smtp: null,
          filter: filterResult,
        },
        Date.now() - startTime,
      );

      await this.saveVerification(normalizedEmail, result);
      return result;
    }

    // Layer 3: SMTP Validation (optional, can be skipped for faster processing)
    let smtpResult = null;
    let hasValidSmtp = false;
    let smtpExternalReviewReason: string | null = null;

    if (!skipSmtp) {
      try {
        smtpResult = await this.smtpValidator.validate(normalizedEmail);
        hasValidSmtp = smtpResult.isValidMailbox;

        if (!smtpResult.isValidMailbox) {
          smtpExternalReviewReason = this.getSmtpExternalReviewReason(
            normalizedEmail,
            smtpResult.reason,
          );

          if (smtpExternalReviewReason) {
            const result = this.createResult(
              normalizedEmail,
              VerificationStatus.UNKNOWN,
              50, // Syntax + DNS passed, SMTP verdict needs external confirmation
              syntaxResult.isValid,
              dnsResult.isValid,
              false,
              filterResult.isDisposable,
              filterResult.isRoleBased,
              filterResult.suggestedEmail,
              {
                syntax: syntaxResult,
                dns: dnsResult,
                smtp: {
                  ...smtpResult,
                  requiresExternalValidation: true,
                  externalReviewReason: smtpExternalReviewReason,
                },
                filter: filterResult,
              },
              Date.now() - startTime,
            );

            await this.saveVerification(normalizedEmail, result);
            return result;
          }

          // SMTP validation failed with a trusted hard failure.
          const result = this.createResult(
            normalizedEmail,
            VerificationStatus.INVALID,
            40, // Syntax + DNS passed, SMTP failed
            syntaxResult.isValid,
            dnsResult.isValid,
            false,
            filterResult.isDisposable,
            filterResult.isRoleBased,
            filterResult.suggestedEmail,
            {
              syntax: syntaxResult,
              dns: dnsResult,
              smtp: smtpResult,
              filter: filterResult,
            },
            Date.now() - startTime,
          );

          await this.saveVerification(normalizedEmail, result);
          return result;
        }
      } catch (error) {
        // SMTP validation error - mark as unknown
        this.logger.warn(`SMTP validation error for ${normalizedEmail}: ${error.message}`);
        smtpExternalReviewReason = 'internal_smtp_exception';
        smtpResult = {
          isValid: false,
          isValidMailbox: false,
          reason: `SMTP error: ${error.message}`,
          requiresExternalValidation: true,
          externalReviewReason: smtpExternalReviewReason,
        };
      }
    }

    if (smtpExternalReviewReason) {
      const result = this.createResult(
        normalizedEmail,
        VerificationStatus.UNKNOWN,
        50,
        syntaxResult.isValid,
        dnsResult.isValid,
        false,
        filterResult.isDisposable,
        filterResult.isRoleBased,
        filterResult.suggestedEmail,
        {
          syntax: syntaxResult,
          dns: dnsResult,
          smtp: smtpResult,
          filter: filterResult,
        },
        Date.now() - startTime,
      );

      await this.saveVerification(normalizedEmail, result);
      return result;
    }

    // Calculate final quality score and status
    const qualityScore = this.calculateQualityScore(
      syntaxResult.isValid,
      dnsResult.isValid,
      hasValidSmtp,
      filterResult.isDisposable,
      filterResult.isRoleBased,
      filterResult.hasSuggestedCorrection,
      skipSmtp,
    );

    const status = this.determineStatus(
      syntaxResult.isValid,
      dnsResult.isValid,
      hasValidSmtp,
      filterResult.isDisposable,
      filterResult.isRoleBased,
      filterResult.hasSuggestedCorrection,
      skipSmtp,
    );

    const result = this.createResult(
      normalizedEmail,
      status,
      qualityScore,
      syntaxResult.isValid,
      dnsResult.isValid,
      hasValidSmtp,
      filterResult.isDisposable,
      filterResult.isRoleBased,
      filterResult.suggestedEmail,
      {
        syntax: syntaxResult,
        dns: dnsResult,
        smtp: smtpResult,
        filter: filterResult,
      },
      Date.now() - startTime,
    );

    // Save verification result
    await this.saveVerification(normalizedEmail, result);

    this.logger.log(
      `Verification completed for ${normalizedEmail}: ${status} (score: ${qualityScore})`,
    );

    return result;
  }

  async auditExistingTypoCandidates(options: {
    limit?: number;
    afterId?: number;
    dryRun?: boolean;
  } = {}): Promise<TypoAuditResult> {
    const limit = Math.min(Math.max(Number(options.limit) || 1000, 1), 10000);
    const dryRun = options.dryRun !== false;

    const emails = await this.emailRepository
      .createQueryBuilder('email')
      .where('email.typoScannedAt IS NULL')
      .orderBy('email.id', 'ASC')
      .take(limit)
      .getMany();

    const result: TypoAuditResult = {
      scanned: emails.length,
      typosFound: 0,
      updated: 0,
      clean: 0,
      remaining: 0,
      completed: false,
      dryRun,
      afterId: 0,
      nextAfterId: emails.length ? Number(emails[emails.length - 1].id) : null,
      rows: [],
    };

    const scannedAt = new Date();

    for (const emailRecord of emails) {
      const filterResult = this.filterValidator.validate(emailRecord.email);
      const suggestedEmail = filterResult.suggestedEmail;
      if (!suggestedEmail) {
        result.clean++;
        if (!dryRun) {
          await this.emailRepository.update(emailRecord.id, {
            typoScanStatus: 'clean',
            typoScannedAt: scannedAt,
          });
        }
        continue;
      }

      result.typosFound++;

      const suppressedStatus = [
        VerificationStatus.INVALID,
        VerificationStatus.DISPOSABLE,
        VerificationStatus.UNSUBSCRIBED,
      ].includes(emailRecord.verificationStatus);

      if (!dryRun) {
        const verificationStatus = suppressedStatus
          ? emailRecord.verificationStatus
          : VerificationStatus.RISKY;
        const qualityScore = suppressedStatus ? emailRecord.qualityScore : 45;
        await this.emailRepository.update(emailRecord.id, {
          hasTypo: true,
          typoSuggestion: suggestedEmail,
          typoResolutionStatus: 'pending' as const,
          typoResolvedEmail: null,
          typoResolvedAt: null,
          typoResolutionNote: null,
          typoScanStatus: 'typo' as const,
          typoScannedAt: scannedAt,
          isDisposable: filterResult.isDisposable,
          isRoleBased: filterResult.isRoleBased,
          verificationStatus,
          qualityScore,
          smtpErrorMessage: 'Common-domain typo detected during existing-list audit',
          lastVerifiedAt: new Date(),
          ...this.sendEligibilityService.buildUpdate({
            verificationStatus,
            qualityScore: Number(qualityScore || 0),
            gmailCategory: emailRecord.gmailCategory,
            hasTypo: true,
            typoResolutionStatus: 'pending',
            isDisposable: filterResult.isDisposable,
            isRoleBased: filterResult.isRoleBased,
            hasValidSyntax: emailRecord.hasValidSyntax,
            hasValidDns: emailRecord.hasValidDns,
            hasValidSmtp: emailRecord.hasValidSmtp,
          }, ExternalValidationProvider.INTERNAL),
        });

        result.updated++;
      }

      result.rows.push({
        id: emailRecord.id,
        email: emailRecord.email,
        suggestedEmail,
        status: suppressedStatus ? emailRecord.verificationStatus : VerificationStatus.RISKY,
        updated: !dryRun,
      });
    }

    result.remaining = await this.emailRepository
      .createQueryBuilder('email')
      .where('email.typoScannedAt IS NULL')
      .getCount();
    result.completed = result.remaining === 0;

    return result;
  }

  async auditCustomerTypoCandidates(options: {
    limit?: number;
    afterId?: number;
    dryRun?: boolean;
  } = {}): Promise<TypoAuditResult> {
    const limit = Math.min(Math.max(Number(options.limit) || 1000, 1), 10000);
    const dryRun = options.dryRun !== false;

    const customers = await this.customerRepository
      .createQueryBuilder('customer')
      .where('customer.typo_scanned_at IS NULL')
      .orderBy('customer.id', 'ASC')
      .take(limit)
      .getMany();

    const result: TypoAuditResult = {
      scanned: customers.length,
      typosFound: 0,
      updated: 0,
      clean: 0,
      remaining: 0,
      completed: false,
      dryRun,
      afterId: 0,
      nextAfterId: customers.length ? Number(customers[customers.length - 1].id) : null,
      rows: [],
    };

    const scannedAt = new Date();

    for (const customer of customers) {
      const normalizedEmail = String(customer.email || '').trim().toLowerCase();
      const filterResult = this.filterValidator.validate(normalizedEmail);
      const suggestedEmail = filterResult.suggestedEmail;
      if (!suggestedEmail) {
        result.clean++;
        if (!dryRun) {
          await this.customerRepository.update(customer.id, {
            typo_scan_status: 'clean',
            typo_scanned_at: scannedAt,
          });
        }
        continue;
      }

      const existingEmail = await this.emailRepository.findOne({
        where: { email: normalizedEmail },
      });

      if (
        existingEmail?.hasTypo &&
        existingEmail.typoSuggestion?.toLowerCase() === suggestedEmail.toLowerCase()
      ) {
        result.typosFound++;
        if (!dryRun) {
          await this.customerRepository.update(customer.id, {
            typo_scan_status: 'typo',
            typo_scanned_at: scannedAt,
          });
        }
        continue;
      }

      result.typosFound++;

      const suppressedStatus = existingEmail
        ? [
            VerificationStatus.INVALID,
            VerificationStatus.DISPOSABLE,
            VerificationStatus.UNSUBSCRIBED,
          ].includes(existingEmail.verificationStatus)
        : false;
      const status = suppressedStatus
        ? existingEmail.verificationStatus
        : VerificationStatus.RISKY;

      if (!dryRun) {
        const updateData = {
          customerId: existingEmail?.customerId && existingEmail.customerId !== customer.id
            ? existingEmail.customerId
            : customer.id,
          firstName: customer.first_name,
          lastName: customer.last_name,
          phone: customer.phone,
          country: customer.country,
          city: customer.city,
          acquisitionSource: 'customer_email_typo_audit',
          hasTypo: true,
          typoSuggestion: suggestedEmail,
          typoResolutionStatus: 'pending' as const,
          typoResolvedEmail: null,
          typoResolvedAt: null,
          typoResolutionNote: null,
          typoScanStatus: 'typo' as const,
          typoScannedAt: scannedAt,
          isDisposable: filterResult.isDisposable,
          isRoleBased: filterResult.isRoleBased,
          verificationStatus: status,
          qualityScore: suppressedStatus ? existingEmail.qualityScore : 45,
          smtpErrorMessage: existingEmail?.customerId && existingEmail.customerId !== customer.id
            ? `Common-domain typo detected on customer #${customer.id}; existing email row is linked to customer #${existingEmail.customerId}`
            : 'Common-domain typo detected during customer email audit',
          lastVerifiedAt: new Date(),
        };
        Object.assign(
          updateData,
          this.sendEligibilityService.buildUpdate({
            verificationStatus: status,
            qualityScore: Number(updateData.qualityScore || 0),
            gmailCategory: existingEmail?.gmailCategory,
            hasTypo: true,
            typoResolutionStatus: 'pending',
            isDisposable: filterResult.isDisposable,
            isRoleBased: filterResult.isRoleBased,
            hasValidSyntax: existingEmail?.hasValidSyntax,
            hasValidDns: existingEmail?.hasValidDns,
            hasValidSmtp: existingEmail?.hasValidSmtp,
          }, ExternalValidationProvider.INTERNAL),
        );

        if (existingEmail) {
          await this.emailRepository.update(existingEmail.id, updateData);
        } else {
          await this.emailRepository.save(
            this.emailRepository.create({
              email: normalizedEmail,
              emailDomain: normalizedEmail.split('@')[1] || null,
              ...updateData,
            }),
          );
        }

        await this.customerRepository.update(customer.id, {
          typo_scan_status: 'typo',
          typo_scanned_at: scannedAt,
        });

        result.updated++;
      }

      result.rows.push({
        id: customer.id,
        email: normalizedEmail,
        suggestedEmail,
        status,
        updated: !dryRun,
      });
    }

    result.remaining = await this.customerRepository
      .createQueryBuilder('customer')
      .where('customer.typo_scanned_at IS NULL')
      .getCount();
    result.completed = result.remaining === 0;

    return result;
  }

  async resetTypoScanProgress(scope: 'emails' | 'customers'): Promise<{ reset: number }> {
    if (scope === 'customers') {
      const result = await this.customerRepository
        .createQueryBuilder()
        .update(Customer)
        .set({
          typo_scan_status: null,
          typo_scanned_at: null,
        })
        .where('typo_scanned_at IS NOT NULL')
        .execute();

      return { reset: result.affected || 0 };
    }

    const result = await this.emailRepository
      .createQueryBuilder()
      .update(Email)
      .set({
        typoScanStatus: null,
        typoScannedAt: null,
      })
      .where('typoScannedAt IS NOT NULL')
      .execute();

    return { reset: result.affected || 0 };
  }

  /**
   * Calculate quality score (0-100)
   */
  private calculateQualityScore(
    hasValidSyntax: boolean,
    hasValidDns: boolean,
    hasValidSmtp: boolean,
    isDisposable: boolean,
    isRoleBased: boolean,
    hasTypo: boolean,
    skipSmtp: boolean,
  ): number {
    let score = 0;

    // Syntax: 20 points
    if (hasValidSyntax) score += 20;

    // DNS: 30 points
    if (hasValidDns) score += 30;

    // SMTP: 40 points (if not skipped)
    if (!skipSmtp && hasValidSmtp) {
      score += 40;
    } else if (skipSmtp && hasValidDns) {
      // If SMTP skipped, give partial points based on DNS
      score += 20;
    }

    // Deductions
    if (isDisposable) score -= 30;
    if (isRoleBased) score -= 10;
    if (hasTypo) score -= 25;

    // Ensure score is between 0-100
    return Math.max(0, Math.min(100, score));
  }

  /**
   * Determine final verification status
   */
  private determineStatus(
    hasValidSyntax: boolean,
    hasValidDns: boolean,
    hasValidSmtp: boolean,
    isDisposable: boolean,
    isRoleBased: boolean,
    hasTypo: boolean,
    skipSmtp: boolean,
  ): VerificationStatus {
    if (!hasValidSyntax || !hasValidDns) {
      return VerificationStatus.INVALID;
    }

    if (isDisposable) {
      return VerificationStatus.DISPOSABLE;
    }

    if (!skipSmtp && !hasValidSmtp) {
      return VerificationStatus.INVALID;
    }

    if (isRoleBased || hasTypo) {
      return VerificationStatus.RISKY;
    }

    if (skipSmtp) {
      // If SMTP skipped, mark as risky (not fully verified)
      return VerificationStatus.RISKY;
    }

    return VerificationStatus.VALID;
  }

  private getSmtpExternalReviewReason(email: string, reason?: string): string | null {
    const domain = extractEmailDomain(email);

    if (isPublicMailboxDomain(domain, { includeObserve: true })) {
      return 'public_mailbox_smtp_untrusted';
    }

    if (this.isTransientSmtpFailure(reason)) {
      return 'transient_smtp_failure';
    }

    return null;
  }

  private isTransientSmtpFailure(reason?: string): boolean {
    if (!reason) return false;

    return [
      'timeout',
      'temporar',
      'try again',
      'system storage',
      'storage',
      'over quota',
      'mailbox full',
      'rate',
      'greylist',
      'too many',
      'blocked',
      'connection',
      'network',
      'unavailable',
      'econn',
      'etimedout',
      'refused',
      'reset',
      '421',
      '450',
      '451',
      '452',
      '4.2.',
      '4.3.',
      '4.4.',
      '4.7.',
    ].some((keyword) => reason.toLowerCase().includes(keyword));
  }

  /**
   * Create verification result object
   */
  private createResult(
    email: string,
    status: VerificationStatus,
    qualityScore: number,
    hasValidSyntax: boolean,
    hasValidDns: boolean,
    hasValidSmtp: boolean,
    isDisposable: boolean,
    isRoleBased: boolean,
    suggestedEmail: string | undefined,
    details: any,
    durationMs: number,
  ): VerificationResult {
    return {
      email,
      status,
      qualityScore,
      hasValidSyntax,
      hasValidDns,
      hasValidSmtp,
      isDisposable,
      isRoleBased,
      suggestedEmail,
      details,
      durationMs,
    };
  }

  /**
   * Create failed result (for early exits)
   */
  private createFailedResult(
    email: string,
    status: VerificationStatus,
    qualityScore: number,
    details: any,
    durationMs: number,
  ): VerificationResult {
    return {
      email,
      status,
      qualityScore,
      hasValidSyntax: details.syntax?.isValid || false,
      hasValidDns: details.dns?.isValid || false,
      hasValidSmtp: false,
      isDisposable: details.filter?.isDisposable || false,
      isRoleBased: details.filter?.isRoleBased || false,
      details,
      durationMs,
    };
  }

  /**
   * Save verification result to database
   */
  private async saveVerification(
    email: string,
    result: VerificationResult,
  ): Promise<void> {
    try {
      // Find email record
      const emailRecord = await this.emailRepository.findOne({
        where: { email },
      });

      if (!emailRecord) {
        this.logger.warn(`Email record not found for: ${email}`);
        return;
      }

      const shouldKeepAcceptedTypoGate =
        emailRecord.hasTypo === true &&
        emailRecord.typoResolutionStatus === 'accepted' &&
        !result.suggestedEmail;
      const nextHasTypo = shouldKeepAcceptedTypoGate ? true : !!result.suggestedEmail;
      const nextTypoSuggestion = shouldKeepAcceptedTypoGate
        ? emailRecord.typoSuggestion
        : result.suggestedEmail || null;
      const nextTypoResolutionStatus = shouldKeepAcceptedTypoGate
        ? emailRecord.typoResolutionStatus
        : result.suggestedEmail
          ? 'pending'
          : emailRecord.typoResolutionStatus;

      // Update email record
      await this.emailRepository.update(emailRecord.id, {
        verificationStatus: result.status,
        qualityScore: result.qualityScore,
        hasValidSyntax: result.hasValidSyntax,
        hasValidDns: result.hasValidDns,
        hasValidSmtp: result.hasValidSmtp,
        isDisposable: result.isDisposable,
        isRoleBased: result.isRoleBased,
        hasTypo: nextHasTypo,
        typoSuggestion: nextTypoSuggestion,
        lastVerifiedAt: new Date(),
        ...this.sendEligibilityService.buildUpdate({
          verificationStatus: result.status,
          qualityScore: result.qualityScore,
          gmailCategory: emailRecord.gmailCategory,
          hasTypo: nextHasTypo,
          typoResolutionStatus: nextTypoResolutionStatus,
          isDisposable: result.isDisposable,
          isRoleBased: result.isRoleBased,
          hasValidSyntax: result.hasValidSyntax,
          hasValidDns: result.hasValidDns,
          hasValidSmtp: result.hasValidSmtp,
        }, ExternalValidationProvider.INTERNAL),
      });

      // Save verification history
      await this.verificationHistoryRepository.save({
        email: emailRecord,
        finalStatus: result.status,
        qualityScore: result.qualityScore,
        syntaxValid: result.hasValidSyntax,
        dnsValid: result.hasValidDns,
        smtpValid: result.hasValidSmtp,
        isDisposable: result.isDisposable,
        isRoleBased: result.isRoleBased,
        verificationDetails: result.details,
        durationMs: result.durationMs,
      });
    } catch (error) {
      this.logger.error(`Failed to save verification for ${email}: ${error.message}`);
    }
  }
}
