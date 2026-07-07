import { Injectable, Logger } from '@nestjs/common';
import { validate as validateEmail } from 'email-validator';

export interface SyntaxValidationResult {
  isValid: boolean;
  reason?: string;
}

/**
 * Layer 1: Syntax Validation
 *
 * Validates email syntax according to RFC 5322
 * - Basic structure (local@domain)
 * - Valid characters
 * - Proper formatting
 *
 * Uses: email-validator library
 * Speed: ~0.001ms per email (extremely fast)
 */
@Injectable()
export class SyntaxValidator {
  private readonly logger = new Logger(SyntaxValidator.name);

  /**
   * Validate email syntax
   */
  validate(email: string): SyntaxValidationResult {
    // Normalize input
    const normalizedEmail = email?.trim().toLowerCase();

    // Basic checks
    if (!normalizedEmail) {
      return {
        isValid: false,
        reason: 'Email is empty or null',
      };
    }

    // Check minimum length (a@b.c = 5 chars minimum)
    if (normalizedEmail.length < 5) {
      return {
        isValid: false,
        reason: 'Email too short',
      };
    }

    // Check maximum length (RFC 5321: 320 chars max)
    if (normalizedEmail.length > 320) {
      return {
        isValid: false,
        reason: 'Email exceeds maximum length (320 chars)',
      };
    }

    // Must contain exactly one @ symbol
    const atCount = (normalizedEmail.match(/@/g) || []).length;
    if (atCount !== 1) {
      return {
        isValid: false,
        reason: atCount === 0 ? 'Missing @ symbol' : 'Multiple @ symbols',
      };
    }

    // Split into local and domain parts
    const [localPart, domainPart] = normalizedEmail.split('@');

    // Local part validation
    if (!localPart || localPart.length === 0) {
      return {
        isValid: false,
        reason: 'Missing local part (before @)',
      };
    }

    if (localPart.length > 64) {
      return {
        isValid: false,
        reason: 'Local part exceeds maximum length (64 chars)',
      };
    }

    // Domain part validation
    if (!domainPart || domainPart.length === 0) {
      return {
        isValid: false,
        reason: 'Missing domain part (after @)',
      };
    }

    // Domain must contain at least one dot
    if (!domainPart.includes('.')) {
      return {
        isValid: false,
        reason: 'Domain missing TLD (no dot found)',
      };
    }

    // Domain must not start or end with dot
    if (domainPart.startsWith('.') || domainPart.endsWith('.')) {
      return {
        isValid: false,
        reason: 'Domain starts or ends with dot',
      };
    }

    // Use email-validator library for RFC 5322 compliance
    const isValidRFC = validateEmail(normalizedEmail);

    if (!isValidRFC) {
      return {
        isValid: false,
        reason: 'Does not comply with RFC 5322 standard',
      };
    }

    // All checks passed
    return {
      isValid: true,
    };
  }

  /**
   * Batch validate multiple emails
   */
  validateBatch(emails: string[]): Map<string, SyntaxValidationResult> {
    const results = new Map<string, SyntaxValidationResult>();

    for (const email of emails) {
      const normalizedEmail = email?.trim().toLowerCase();
      results.set(normalizedEmail, this.validate(normalizedEmail));
    }

    return results;
  }

  /**
   * Get validation statistics for a batch
   */
  getBatchStats(emails: string[]): {
    total: number;
    valid: number;
    invalid: number;
    validPercentage: number;
  } {
    const results = this.validateBatch(emails);
    const valid = Array.from(results.values()).filter((r) => r.isValid).length;
    const invalid = results.size - valid;

    return {
      total: results.size,
      valid,
      invalid,
      validPercentage: results.size > 0 ? (valid / results.size) * 100 : 0,
    };
  }
}
