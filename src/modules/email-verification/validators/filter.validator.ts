import { Injectable, Logger } from '@nestjs/common';
import * as mailcheck from 'mailcheck';
import { PUBLIC_MAILBOX_DOMAINS_CORE_RO } from '@shared/email-domain-classification';

// CommonJS import for disposable-email-domains
const disposableDomains = require('disposable-email-domains');

export interface FilterValidationResult {
  isValid: boolean;
  isDisposable: boolean;
  isRoleBased: boolean;
  hasSuggestedCorrection: boolean;
  suggestedEmail?: string;
  reason?: string;
}

export interface NameLocalPartContext {
  firstName?: string | null;
  lastName?: string | null;
  fullName?: string | null;
}

export interface NameLocalPartSuggestion {
  suggestedEmail: string;
  confidence: 'high' | 'medium';
  reason: string;
}

/**
 * Layer 4: Filter Validation
 *
 * Applies business rules and filters to detect:
 * 1. Disposable/temporary email addresses (mailinator, tempmail, etc.)
 * 2. Role-based emails (info@, admin@, support@, etc.)
 * 3. Typos in common domains (gamil.com → gmail.com)
 *
 * Uses:
 * - disposable-email-domains (9,000+ disposable domains)
 * - mailcheck (typo detection for common providers)
 * - Custom role-based email patterns
 *
 * Speed: ~0.1ms per email (very fast, no network calls)
 */
@Injectable()
export class FilterValidator {
  private readonly logger = new Logger(FilterValidator.name);
  private readonly disposableDomainsSet: Set<string>;
  private readonly roleBasedPrefixes: string[];

  // Common email domains for typo checking
  private readonly commonDomains = [
    ...PUBLIC_MAILBOX_DOMAINS_CORE_RO,
    'aol.com',
    'mail.com',
    'zoho.com',
  ];

  private readonly protectedDomains = [
    'ymail.com',
    'rocketmail.com',
    'me.com',
    'mac.com',
    'email.com',
    'onmail.com',
  ];

  private readonly obviousTypoTlds = [
    'con',
    'cim',
    'cpm',
    'coom',
    'comm',
    'vom',
  ];

  constructor() {
    // Convert disposable domains array to Set for O(1) lookup
    this.disposableDomainsSet = new Set(disposableDomains);

    // Common role-based email prefixes
    this.roleBasedPrefixes = [
      'admin',
      'info',
      'support',
      'sales',
      'contact',
      'help',
      'service',
      'office',
      'team',
      'hello',
      'noreply',
      'no-reply',
      'postmaster',
      'webmaster',
      'hostmaster',
      'abuse',
      'marketing',
      'hr',
      'jobs',
      'career',
      'careers',
      'billing',
      'accounts',
      'finance',
    ];
  }

  /**
   * Validate email against filters
   */
  validate(email: string): FilterValidationResult {
    const normalizedEmail = email.trim().toLowerCase();
    const domain = this.extractDomain(normalizedEmail);
    const localPart = this.extractLocalPart(normalizedEmail);

    if (!domain || !localPart) {
      return {
        isValid: false,
        isDisposable: false,
        isRoleBased: false,
        hasSuggestedCorrection: false,
        reason: 'Invalid email format',
      };
    }

    // Check if disposable
    const isDisposable = this.isDisposableDomain(domain);

    // Check if role-based
    const isRoleBased = this.isRoleBasedEmail(localPart);

    // Check for typos
    const typoSuggestion = this.checkTypo(normalizedEmail);

    // Determine if valid based on filters
    let isValid = true;
    const reasons: string[] = [];

    if (isDisposable) {
      isValid = false;
      reasons.push('Disposable/temporary email domain');
    }

    if (isRoleBased) {
      // Role-based emails are marked but not necessarily invalid
      // depending on your business rules
      reasons.push('Role-based email address');
    }

    return {
      isValid,
      isDisposable,
      isRoleBased,
      hasSuggestedCorrection: !!typoSuggestion,
      suggestedEmail: typoSuggestion,
      reason: reasons.length > 0 ? reasons.join('; ') : undefined,
    };
  }

  suggestNameLocalPartCorrection(
    email: string,
    context: NameLocalPartContext = {},
  ): NameLocalPartSuggestion | null {
    const normalizedEmail = String(email || '').trim().toLowerCase();
    const localPart = this.extractLocalPart(normalizedEmail);
    const domain = this.extractDomain(normalizedEmail);
    const nameTokens = this.getNameTokens(context);

    if (!localPart || !domain || nameTokens.length === 0) {
      return null;
    }

    const segmentedSuggestion = this.suggestSegmentedLocalPart(localPart, nameTokens);
    if (segmentedSuggestion && segmentedSuggestion.suggestedLocalPart !== localPart) {
      return {
        suggestedEmail: `${segmentedSuggestion.suggestedLocalPart}@${domain}`,
        confidence: segmentedSuggestion.confidence,
        reason: 'Email local part is close to customer name but appears misspelled',
      };
    }

    const compactSuggestion = this.suggestCompactLocalPart(localPart, nameTokens);
    if (compactSuggestion && compactSuggestion !== localPart) {
      return {
        suggestedEmail: `${compactSuggestion}@${domain}`,
        confidence: 'medium',
        reason: 'Compact email local part is close to customer name but appears misspelled',
      };
    }

    return null;
  }

  /**
   * Check if domain is disposable/temporary
   */
  private isDisposableDomain(domain: string): boolean {
    return this.disposableDomainsSet.has(domain);
  }

  /**
   * Check if email is role-based
   */
  private isRoleBasedEmail(localPart: string): boolean {
    return this.roleBasedPrefixes.some((prefix) => {
      // Exact match or starts with prefix followed by dot/dash
      return (
        localPart === prefix ||
        localPart.startsWith(`${prefix}.`) ||
        localPart.startsWith(`${prefix}-`) ||
        localPart.startsWith(`${prefix}_`)
      );
    });
  }

  /**
   * Check for common typos in email domain
   */
  private checkTypo(email: string): string | null {
    try {
      const suggestion = mailcheck.run({
        email,
        domains: this.commonDomains,
      });

      if (!suggestion?.full) {
        return null;
      }

      const originalDomain = this.extractDomain(email);
      const suggestedDomain = this.extractDomain(suggestion.full);

      if (!originalDomain || !suggestedDomain || originalDomain === suggestedDomain) {
        return null;
      }

      if (!this.commonDomains.includes(suggestedDomain)) {
        return null;
      }

      if (this.protectedDomains.includes(originalDomain)) {
        return null;
      }

      const originalParts = originalDomain.split('.');
      const suggestedParts = suggestedDomain.split('.');
      const originalTld = originalParts[originalParts.length - 1];
      const suggestedTld = suggestedParts[suggestedParts.length - 1];
      const originalBase = this.normalizeDomainBase(originalDomain);
      const suggestedBase = this.normalizeDomainBase(suggestedDomain);

      // Do not treat legitimate country-code domains as typos for .com providers.
      // Examples that should stay unflagged: yahoo.it, hotmail.fr, proton.me.
      if (originalTld.length === 2 && originalTld !== suggestedTld) {
        return null;
      }

      if (originalTld !== suggestedTld) {
        if (originalBase !== suggestedBase || !this.obviousTypoTlds.includes(originalTld)) {
          return null;
        }
        return suggestion.full;
      }

      if (!this.isAllowedProviderTypo(originalDomain, suggestedDomain)) {
        return null;
      }

      return suggestion.full;
    } catch (error) {
      // Mailcheck failed, ignore
      return null;
    }
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

    if (
      suggestedBase === 'icloud' &&
      !trimmedOriginal.startsWith('i') &&
      !trimmedOriginal.startsWith('y')
    ) {
      return false;
    }

    if (suggestedBase === 'protonmail' && !trimmedOriginal.startsWith('p')) {
      return false;
    }

    return this.levenshteinDistance(trimmedOriginal, suggestedBase) <= 2;
  }

  private normalizeDomainBase(domain: string): string {
    const parts = domain.split('.');
    if (parts.length < 2) {
      return domain.replace(/[^a-z0-9]/g, '');
    }

    return parts
      .slice(0, -1)
      .join('')
      .replace(/[^a-z0-9]/g, '');
  }

  private levenshteinDistance(a: string, b: string): number {
    const matrix: number[][] = Array.from({ length: a.length + 1 }, () =>
      Array(b.length + 1).fill(0),
    );

    for (let i = 0; i <= a.length; i++) {
      matrix[i][0] = i;
    }

    for (let j = 0; j <= b.length; j++) {
      matrix[0][j] = j;
    }

    for (let i = 1; i <= a.length; i++) {
      for (let j = 1; j <= b.length; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        matrix[i][j] = Math.min(
          matrix[i - 1][j] + 1,
          matrix[i][j - 1] + 1,
          matrix[i - 1][j - 1] + cost,
        );
      }
    }

    return matrix[a.length][b.length];
  }

  private getNameTokens(context: NameLocalPartContext): string[] {
    return [context.firstName, context.lastName, context.fullName]
      .flatMap((value) => String(value || '').split(/[\s._-]+/))
      .map((value) => this.normalizePersonToken(value))
      .filter((value, index, values) => value.length >= 3 && values.indexOf(value) === index);
  }

  private suggestSegmentedLocalPart(
    localPart: string,
    nameTokens: string[],
  ): { suggestedLocalPart: string; confidence: 'high' | 'medium' } | null {
    const parts = localPart.match(/[a-z0-9]+|[^a-z0-9]+/g);
    if (!parts || parts.length < 2) {
      return null;
    }

    let exactMatches = 0;
    let changed = 0;
    const correctedParts = parts.map((part) => {
      if (!/[a-z]/.test(part)) {
        return part;
      }

      const alpha = this.normalizePersonToken(part);
      if (alpha.length < 3) {
        return part;
      }

      if (nameTokens.includes(alpha)) {
        exactMatches++;
        return part;
      }

      const best = this.findClosestNameToken(alpha, nameTokens);
      if (!best) {
        return part;
      }

      changed++;
      return part.replace(/[a-z]+/g, best.token);
    });

    if (changed === 0 || exactMatches === 0) {
      return null;
    }

    const suggestedLocalPart = correctedParts.join('');
    if (suggestedLocalPart === localPart) {
      return null;
    }

    return {
      suggestedLocalPart,
      confidence: changed === 1 && exactMatches >= 1 ? 'high' : 'medium',
    };
  }

  private suggestCompactLocalPart(localPart: string, nameTokens: string[]): string | null {
    const compactLocal = this.normalizePersonToken(localPart);
    if (compactLocal.length < 6 || nameTokens.length < 2) {
      return null;
    }

    const candidates = this.buildCompactNameCandidates(nameTokens);
    const best = candidates
      .map((candidate) => ({
        candidate,
        distance: this.levenshteinDistance(compactLocal, candidate),
      }))
      .sort((a, b) => a.distance - b.distance)[0];

    if (!best || best.distance === 0 || best.distance > this.maxLocalPartDistance(best.candidate)) {
      return null;
    }

    const hasAnchoredNameToken = nameTokens.some(
      (token) => token.length >= 4 && compactLocal.includes(token),
    );

    if (!hasAnchoredNameToken) {
      return null;
    }

    return best.candidate;
  }

  private buildCompactNameCandidates(nameTokens: string[]): string[] {
    const candidates = new Set<string>();
    for (let i = 0; i < nameTokens.length; i++) {
      for (let j = 0; j < nameTokens.length; j++) {
        if (i === j) {
          continue;
        }
        candidates.add(`${nameTokens[i]}${nameTokens[j]}`);
      }
    }
    return Array.from(candidates);
  }

  private findClosestNameToken(
    value: string,
    nameTokens: string[],
  ): { token: string; distance: number } | null {
    const ranked = nameTokens
      .map((token) => ({
        token,
        distance: this.levenshteinDistance(value, token),
      }))
      .sort((a, b) => a.distance - b.distance);

    const best = ranked[0];
    const runnerUp = ranked[1];
    if (!best || best.distance === 0 || best.distance > this.maxLocalPartDistance(best.token)) {
      return null;
    }

    if (runnerUp && runnerUp.distance === best.distance) {
      return null;
    }

    return best;
  }

  private maxLocalPartDistance(value: string): number {
    if (value.length <= 4) {
      return 1;
    }

    if (value.length <= 8) {
      return 1;
    }

    return 2;
  }

  private normalizePersonToken(value: string): string {
    return String(value || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z]/g, '');
  }

  /**
   * Extract domain from email
   */
  private extractDomain(email: string): string | null {
    if (!email || !email.includes('@')) {
      return null;
    }

    const parts = email.split('@');
    return parts.length === 2 ? parts[1] : null;
  }

  /**
   * Extract local part from email
   */
  private extractLocalPart(email: string): string | null {
    if (!email || !email.includes('@')) {
      return null;
    }

    const parts = email.split('@');
    return parts.length === 2 ? parts[0] : null;
  }

  /**
   * Batch validate multiple emails
   */
  validateBatch(emails: string[]): Map<string, FilterValidationResult> {
    const results = new Map<string, FilterValidationResult>();

    for (const email of emails) {
      const normalizedEmail = email.trim().toLowerCase();
      results.set(normalizedEmail, this.validate(normalizedEmail));
    }

    return results;
  }

  /**
   * Get filter statistics for a batch
   */
  getBatchStats(emails: string[]): {
    total: number;
    disposable: number;
    roleBased: number;
    withTypoSuggestions: number;
    disposablePercentage: number;
  } {
    const results = this.validateBatch(emails);
    const values = Array.from(results.values());

    const disposable = values.filter((r) => r.isDisposable).length;
    const roleBased = values.filter((r) => r.isRoleBased).length;
    const withTypoSuggestions = values.filter((r) => r.hasSuggestedCorrection).length;

    return {
      total: results.size,
      disposable,
      roleBased,
      withTypoSuggestions,
      disposablePercentage: results.size > 0 ? (disposable / results.size) * 100 : 0,
    };
  }

  /**
   * Add custom disposable domain to blacklist
   */
  addDisposableDomain(domain: string): void {
    this.disposableDomainsSet.add(domain.toLowerCase());
  }

  /**
   * Remove domain from disposable blacklist
   */
  removeDisposableDomain(domain: string): void {
    this.disposableDomainsSet.delete(domain.toLowerCase());
  }

  /**
   * Check if a specific domain is in disposable list
   */
  isInDisposableList(domain: string): boolean {
    return this.disposableDomainsSet.has(domain.toLowerCase());
  }

  /**
   * Get total count of disposable domains
   */
  getDisposableDomainsCount(): number {
    return this.disposableDomainsSet.size;
  }
}
