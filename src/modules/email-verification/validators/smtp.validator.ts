import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { validate as deepValidate } from 'deep-email-validator';

export interface SmtpValidationResult {
  isValid: boolean;
  isValidMailbox: boolean;
  reason?: string;
  smtpResponse?: string;
}

/**
 * Layer 3: SMTP Validation
 *
 * Validates email by performing SMTP handshake with mail server
 * - Connects to MX server
 * - Executes SMTP commands: HELO → MAIL FROM → RCPT TO
 * - Checks if mailbox actually exists
 *
 * IMPORTANT: This does NOT send any emails!
 * It only performs SMTP handshake to verify the mailbox exists.
 * The connection is closed after RCPT TO command.
 *
 * Uses: deep-email-validator library
 * Speed: ~500-2000ms per email (network dependent)
 * Rate limit: MUST be rate limited to avoid being blocked by mail servers
 *
 * SMTP Commands executed:
 * 1. HELO/EHLO - Identifies the sender server
 * 2. MAIL FROM - Specifies sender (verification@mail-check.tau-domeniu.ro)
 * 3. RCPT TO - Checks if recipient mailbox exists
 * 4. QUIT - Closes connection (NO DATA command, NO email sent)
 */
@Injectable()
export class SmtpValidator {
  private readonly logger = new Logger(SmtpValidator.name);
  private readonly heloDomain: string;
  private readonly mailFrom: string;
  private readonly timeout: number;

  constructor(private readonly configService: ConfigService) {
    this.heloDomain = this.configService.get<string>('EMAIL_VERIFICATION_HELO_DOMAIN');
    this.mailFrom = this.configService.get<string>('EMAIL_VERIFICATION_MAIL_FROM');
    this.timeout = this.configService.get<number>('EMAIL_VERIFICATION_TIMEOUT', 10000);
  }

  /**
   * Validate email via SMTP handshake
   *
   * CRITICAL: This method does NOT send emails!
   * It only verifies the mailbox exists via SMTP protocol.
   */
  async validate(email: string): Promise<SmtpValidationResult> {
    const normalizedEmail = email.trim().toLowerCase();

    try {
      // Use deep-email-validator for SMTP check
      const result = await deepValidate({
        email: normalizedEmail,
        sender: this.mailFrom,
        validateRegex: true,
        validateMx: true,
        validateTypo: false, // We handle typos in Layer 4
        validateDisposable: false, // We handle disposable in Layer 4
        validateSMTP: true, // This is the key - SMTP handshake only
      });

      // Check result
      if (result.valid) {
        return {
          isValid: true,
          isValidMailbox: true,
        };
      }

      // Invalid - extract reason
      const reason = result.reason || 'Unknown SMTP validation failure';
      const validators = result.validators || {};

      // Check specific failure reasons
      if (validators.smtp && !validators.smtp.valid) {
        return {
          isValid: false,
          isValidMailbox: false,
          reason: validators.smtp.reason || 'SMTP verification failed',
          smtpResponse: validators.smtp.reason,
        };
      }

      // MX records issue
      if (validators.mx && !validators.mx.valid) {
        return {
          isValid: false,
          isValidMailbox: false,
          reason: 'MX records validation failed',
        };
      }

      // Generic failure
      return {
        isValid: false,
        isValidMailbox: false,
        reason,
      };
    } catch (error) {
      // SMTP validation error (timeout, network error, etc.)
      this.logger.warn(`SMTP validation failed for ${normalizedEmail}: ${error.message}`);

      return {
        isValid: false,
        isValidMailbox: false,
        reason: `SMTP check failed: ${error.message}`,
      };
    }
  }

  /**
   * Validate multiple emails with rate limiting
   *
   * IMPORTANT: SMTP validation MUST be rate limited!
   * Mail servers will block you if you send too many requests.
   *
   * This method processes emails sequentially with delay between requests.
   */
  async validateBatch(
    emails: string[],
    delayMs: number = 100,
  ): Promise<Map<string, SmtpValidationResult>> {
    const results = new Map<string, SmtpValidationResult>();

    for (const email of emails) {
      const normalizedEmail = email.trim().toLowerCase();

      try {
        const result = await this.validate(normalizedEmail);
        results.set(normalizedEmail, result);

        // Rate limiting delay
        if (delayMs > 0) {
          await this.sleep(delayMs);
        }
      } catch (error) {
        this.logger.error(`Batch validation failed for ${normalizedEmail}: ${error.message}`);
        results.set(normalizedEmail, {
          isValid: false,
          isValidMailbox: false,
          reason: `Batch validation error: ${error.message}`,
        });
      }
    }

    return results;
  }

  /**
   * Sleep helper for rate limiting
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Validate with retry logic (for transient SMTP errors)
   */
  async validateWithRetry(
    email: string,
    maxRetries: number = 2,
    retryDelayMs: number = 1000,
  ): Promise<SmtpValidationResult> {
    let lastError: SmtpValidationResult | null = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const result = await this.validate(email);

        // If valid or definitive invalid (not timeout/network error), return
        if (result.isValid || !this.isTransientError(result.reason)) {
          return result;
        }

        lastError = result;

        // Wait before retry
        if (attempt < maxRetries) {
          this.logger.log(
            `SMTP validation attempt ${attempt} failed for ${email}, retrying...`,
          );
          await this.sleep(retryDelayMs);
        }
      } catch (error) {
        lastError = {
          isValid: false,
          isValidMailbox: false,
          reason: error.message,
        };
      }
    }

    // All retries exhausted
    return (
      lastError || {
        isValid: false,
        isValidMailbox: false,
        reason: 'All SMTP validation retries failed',
      }
    );
  }

  /**
   * Check if error is transient (worth retrying)
   */
  private isTransientError(reason?: string): boolean {
    if (!reason) return false;

    const transientKeywords = [
      'timeout',
      'ETIMEDOUT',
      'ECONNREFUSED',
      'ECONNRESET',
      'network',
      'temporarily',
      'try again',
    ];

    return transientKeywords.some((keyword) =>
      reason.toLowerCase().includes(keyword.toLowerCase()),
    );
  }
}
