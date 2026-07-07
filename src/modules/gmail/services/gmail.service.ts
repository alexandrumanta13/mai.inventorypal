import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Not, MoreThan, IsNull } from 'typeorm';
import { google } from 'googleapis';
import { OAuth2Client } from 'google-auth-library';
import { Email } from '../../emails/entities/email.entity';
import { VerificationStatus } from '@shared/enums/verification-status.enum';
import { ExternalValidationProvider } from '@shared/enums/email-validation.enum';
import { LLMCategorizationService } from './llm-categorization.service';
import { ScanProgressService } from './scan-progress.service';
import { CustomersService } from '../../customers/services/customers.service';
import { PaymentMethod } from '../../customers/entities/customer.entity';
import { FilterValidator } from '../../email-verification/validators/filter.validator';
import { SendEligibilityService } from '../../emails/services/send-eligibility.service';
import { BounceRecoveryService } from '../../email-verification/services/bounce-recovery.service';

export interface GmailScanResult {
  scanned: number;
  unsubscribeDetected: number;
  bounceDetected: number;
  updated: number;
  created: number;
  errors: number;
  nextPageToken?: string;
}

export interface OrderScanResult {
  scanned: number;
  ordersDetected: number;
  updated: number;
  created: number;
  errors: number;
  nextPageToken?: string;
}

export interface AbuseScanResult {
  scanned: number;
  abuseDetected: number;
  updated: number;
  created: number;
  errors: number;
  nextPageToken?: string;
}

export interface SmartGmailScanResult {
  scanned: number;
  bodyFetched: number;
  llmAnalyzed: number;
  ignored: {
    spamTrash: number;
    promotions: number;
    newsletters: number;
    marketing: number;
    clean: number;
  };
  ordersDetected: number;
  unsubscribeDetected: number;
  bounceDetected: number;
  abuseDetected: number;
  updated: number;
  created: number;
  errors: number;
  nextPageToken?: string;
}

export interface DetectedEmail {
  email: string;
  reason: string;
  type: 'unsubscribe' | 'bounce';
  subject?: string;
  date?: string;
}

interface ParsedOrderCustomer {
  email: string;
  firstName?: string;
  lastName?: string;
  fullName?: string;
  phone?: string;
  address_1?: string;
  address_2?: string;
  city?: string;
  state?: string;
  postcode?: string;
  country?: string;
  preferredPaymentMethod?: PaymentMethod;
}

interface GmailMessageContext {
  id: string;
  labelIds: string[];
  headers: any[];
  fromHeader: string;
  toHeader: string;
  subjectHeader: string;
  dateHeader: string;
  snippet: string;
}

interface SmartGmailScanOptions {
  maxResults?: number;
  daysBack?: number;
  afterDate?: string;
  beforeDate?: string;
  autoUpdate?: boolean;
  pageToken?: string;
  includeSpamTrash?: boolean;
}

@Injectable()
export class GmailService {
  private readonly logger = new Logger(GmailService.name);
  private oauth2Client: OAuth2Client;

  // Unsubscribe patterns (Romanian and English)
  private readonly unsubscribePatterns = [
    /\bunsubscribe\b/i,
    /\bdezabonare\b/i,
    /\boprește\b/i,
    /\bstop\s+(sending|emails?|mail)/i,
    /\bremove\s+me\b/i,
    /\bdo\s+not\s+send\b/i,
    /\bnu\s+mai\s+trimite/i,
    /\bvreau\s+sa\s+ma\s+dezabonez/i,
    /\bopt[\s-]?out\b/i,
  ];

  // Bounce-back patterns
  private readonly bouncePatterns = [
    /\b(out\s+of\s+office|away\s+from\s+office)\b/i,
    /\b(delivery\s+failed|delivery\s+status\s+notification)\b/i,
    /\b(mailer[\s-]?daemon|postmaster)\b/i,
    /\b(address\s+not\s+found|user\s+not\s+found)\b/i,
    /\b(550\s+user\s+unknown|550\s+no\s+such\s+user)\b/i,
    /\b(mailbox\s+unavailable|mailbox\s+full)\b/i,
    /\b(permanent\s+error|permanent\s+failure)\b/i,
    /\b(undelivered\s+mail|mail\s+delivery\s+failed)\b/i,
    /\b(this\s+email\s+address\s+doesn'?t?\s+exist)\b/i,
    /\b(recipient\s+address\s+rejected)\b/i,
  ];

  // Order confirmation patterns (Romanian & English)
  // These patterns identify order confirmations to EXCLUDE from LLM scanning
  private readonly orderPatterns = [
    // SPECIFIC: WooCommerce/store automated order emails
    // Example: "[Fabricadeasternuturi.ro]: comandă nouă nr. 243430"
    /\[.+\]:\s*comand[ăa]\s+(nou[ăa]|new)/i,
    /\[.+\]:\s*(new\s+)?order/i,

    // Order number patterns - allow optional words between "comanda" and "nr"
    /\bcomand[ăa]\s+(nou[ăa]\s+)?(nr\.?|#|num[ăa]r)\s*[:=]?\s*\d+/i,
    /\border\s+(new\s+)?(#|number|nr\.?)\s*[:=]?\s*\d+/i,
    /\bcomand[ăa]\s+nou[ăa]\b/i, // "comandă nouă" by itself

    // Confirmation messages
    /\b(thank\s+you\s+for\s+your\s+(order|purchase)|mul[țt]umim\s+pentru\s+comand[ăa])/i,
    /\b(order\s+confirmation|confirmare\s+comand[ăa])/i,
    /\b(purchase\s+confirmation|confirmare\s+achizi[țt]ie)/i,

    // Body-specific patterns
    /\b(order\s+(id|number)|nr\.?\s*comand[ăa]|num[ăa]r\s+comand[ăa])\s*[:=]?\s*[#\s]*\d+/i,
    /\b(tracking\s+(number|code)|cod\s+urm[ăa]rire)\s*[:=]?\s*[A-Z0-9]+/i,
    /\b(invoice|factur[ăa])\s*(#|nr\.?)?\s*\d+/i,
    /\b(total|subtotal)\s*[:=]?\s*(lei|ron|eur|\$|€)\s*\d+/i,
    /\b(adres[ăa]\s+de\s+(livrare|facturare)|shipping\s+address|billing\s+address)/i,
    /\b(payment\s+method|metod[ăa]\s+de\s+plat[ăa])/i,

    // E-commerce specific
    /\b(your\s+order\s+has\s+been|comanda\s+(ta|dumneavoastr[ăa])\s+a\s+fost)/i,
    /\b(order\s+summary|sumar\s+comand[ăa])/i,
    /\b(estimated\s+delivery|livrare\s+estimat[ăa])/i,
    /\b(order\s+(placed|received)|comand[ăa]\s+(plasat[ăa]|primit[ăa]))/i,
  ];

  // Common e-commerce sender patterns to identify orders
  private readonly orderSenderPatterns = [
    /noreply@/i,
    /no-reply@/i,
    /orders@/i,
    /comenzi@/i,
    /shop@/i,
    /store@/i,
    /notification@/i,
    /notificare@/i,
    /office@/i, // Common for Romanian e-commerce
    /sales@/i,
    /vanzari@/i,
    /comenzi-noi@/i,
  ];

  private readonly abusePatterns = [
    /\b(fuck|shit|damn|bastard|asshole|bitch)\b/i,
    /\b(muie|pula|pizda|futut|cacat|labagiu)\b/i,
    /\b(idiot|cretin|prost|tembel|imbecil)\b/i,
  ];

  /**
   * Check if email is a REPLY (Re:, Fwd:, răspuns)
   * Replies to order emails might contain unsubscribe/abuse content
   * Priority: Unsubscribe/Abuse > Order
   */
  private isReplyEmail(subject: string, headers: any[]): boolean {
    // Check subject line
    if (/^(re|fwd|r[eă]spuns):/i.test(subject)) {
      return true;
    }

    // Check In-Reply-To or References headers
    const inReplyTo = headers.find((h) => h.name === 'In-Reply-To')?.value;
    const references = headers.find((h) => h.name === 'References')?.value;

    return !!(inReplyTo || references);
  }

  /**
   * Detect if email is an order confirmation using pattern matching
   * Returns true if this is clearly an order email (to EXCLUDE from LLM scanning)
   * Returns false for replies, which need LLM analysis regardless of order keywords
   */
  private isOrderEmail(fromHeader: string, subject: string, body: string, headers: any[]): boolean {
    // CRITICAL: If this is a REPLY, it might be unsubscribe/abuse even if it mentions "order"
    // Example: "Re: Comanda #123" with body "vreau să mă dezabonez"
    if (this.isReplyEmail(subject, headers)) {
      return false; // Treat replies as non-orders (will go to LLM for analysis)
    }

    const fullText = `${subject} ${body}`;

    // Check if sender is from order system
    let isSenderOrder = false;
    for (const pattern of this.orderSenderPatterns) {
      if (pattern.test(fromHeader)) {
        isSenderOrder = true;
        break;
      }
    }

    // Check content patterns
    let hasOrderPattern = false;
    for (const pattern of this.orderPatterns) {
      if (pattern.test(fullText)) {
        hasOrderPattern = true;
        break;
      }
    }

    // Strong signal: both sender AND content match order patterns
    if (isSenderOrder && hasOrderPattern) {
      return true;
    }

    // Medium signal: at least 2 different order patterns match
    let patternMatches = 0;
    for (const pattern of this.orderPatterns) {
      if (pattern.test(fullText)) {
        patternMatches++;
        if (patternMatches >= 2) {
          return true;
        }
      }
    }

    return false;
  }

  /**
   * CRITICAL: Detect MARKETING EMAILS RECEIVED by us (newsletters, promotions)
   * These are NOT customer emails and should be SKIPPED entirely
   *
   * Example of what to SKIP:
   * - From: newsletter@substack.com → Substack newsletter we subscribed to
   * - From: news@cos.com → COS promotional email
   * - From: hello@brand.com → Marketing automation
   *
   * Example of what to PROCESS:
   * - From: dascaludenisa14@yahoo.com → Real customer reply
   * - From: office@fabricadeasternuturi.ro → Our own sent emails (orders)
   */
  private isMarketingEmailReceived(fromHeader: string, toHeader: string, headers: any[]): boolean {
    // If this is a REPLY from a customer, DO NOT skip (need to check for unsubscribe/abuse)
    if (this.isReplyEmail('', headers)) {
      return false; // Customer replies are NOT marketing, process them
    }

    // Marketing sender patterns - typical newsletter/automation senders
    const marketingSenderPatterns = [
      /newsletter@/i,
      /news@/i,
      /hello@/i,
      /hi@/i,
      /team@/i,
      /support@/i,
      /info@/i,
      /contact@/i,
      /@substack\.com$/i,
      /@e\./i, // e.cos.com, e.brand.com (email service providers)
      /@mail\./i, // mail.brand.com
      /@updates\./i,
      /@notifications?\./i,
      /marketing@/i,
      /promo@/i,
      /offers@/i,
      /deals@/i,
    ];

    // Check if sender matches marketing patterns
    let isMarketingSender = false;
    for (const pattern of marketingSenderPatterns) {
      if (pattern.test(fromHeader)) {
        isMarketingSender = true;
        break;
      }
    }

    // If NOT a marketing sender, it's probably a real customer → PROCESS IT
    if (!isMarketingSender) {
      return false;
    }

    // Marketing sender detected - now check if we're the RECIPIENT (not sender)
    // If TO contains our business email, we RECEIVED this marketing email → SKIP IT
    const ourBusinessEmails = [
      'office@fabricadeasternuturi.ro',
      'alex@fabricadeasternuturi.ro',
      // Add more business emails if needed
    ];

    for (const ourEmail of ourBusinessEmails) {
      if (toHeader && toHeader.toLowerCase().includes(ourEmail.toLowerCase())) {
        // This is a marketing email SENT TO US → SKIP
        this.logger.debug(`SKIP marketing email from ${fromHeader} (we are recipient)`);
        return true;
      }
    }

    // Fallback: If it's a marketing sender but we can't confirm we're the recipient, be safe and SKIP
    return true;
  }

  private getHeader(headers: any[], name: string): string {
    return headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value || '';
  }

  private extractEmailAddress(header: string): string | null {
    const emailMatch = header.match(/<?([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})>?/);
    return emailMatch ? emailMatch[1].toLowerCase().trim() : null;
  }

  private extractFailedRecipientFromBounce(headers: any[], body: string, fallbackFromEmail?: string | null): string | null {
    const fallback = fallbackFromEmail?.toLowerCase().trim() || null;
    const normalize = (value: string | null | undefined): string | null => {
      if (!value) {
        return null;
      }

      const email = this.extractEmailAddress(value);
      if (!email || email === fallback) {
        return null;
      }

      return email;
    };

    const headerCandidates = [
      this.getHeader(headers, 'X-Failed-Recipients'),
      this.getHeader(headers, 'Final-Recipient'),
      this.getHeader(headers, 'Original-Recipient'),
    ];

    for (const candidate of headerCandidates) {
      const email = normalize(candidate);
      if (email) {
        return email;
      }
    }

    const lines = body
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);

    const lineLabels = [
      /^x-failed-recipients\s*:/i,
      /^final-recipient\s*:/i,
      /^original-recipient\s*:/i,
      /^failed-recipient\s*:/i,
      /^recipient(?:\s+address)?\s*:/i,
    ];

    for (const line of lines) {
      if (!lineLabels.some((pattern) => pattern.test(line))) {
        continue;
      }

      const email = normalize(line);
      if (email) {
        return email;
      }
    }

    const text = body.replace(/\s+/g, ' ');
    const emailPattern = '([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,})';
    const contextualPatterns = [
      new RegExp(`message\\s+(?:wasn'?t|was\\s+not)\\s+delivered\\s+to\\s+<?${emailPattern}>?`, 'i'),
      new RegExp(`couldn'?t\\s+be\\s+delivered\\s+to\\s+<?${emailPattern}>?`, 'i'),
      new RegExp(`delivery\\s+to\\s+<?${emailPattern}>?\\s+failed`, 'i'),
      new RegExp(`recipient(?:\\s+address)?(?:\\s+rejected)?[^a-zA-Z0-9._%+-]{1,40}<?${emailPattern}>?`, 'i'),
      new RegExp(`<?${emailPattern}>?[^.]{0,160}(?:user\\s+unknown|doesn'?t\\s+exist|not\\s+found|mailbox\\s+unavailable|recipient\\s+address\\s+rejected)`, 'i'),
      new RegExp(`(?:user\\s+unknown|doesn'?t\\s+exist|not\\s+found|mailbox\\s+unavailable|recipient\\s+address\\s+rejected)[^.]{0,160}<?${emailPattern}>?`, 'i'),
    ];

    for (const pattern of contextualPatterns) {
      const match = text.match(pattern);
      const email = normalize(match?.[1]);
      if (email) {
        return email;
      }
    }

    return null;
  }

  private hasAnyPattern(patterns: RegExp[], text: string): boolean {
    return patterns.some((pattern) => pattern.test(text));
  }

  private formatGmailQueryDate(value: string | Date): string {
    const date = value instanceof Date ? value : new Date(value);

    if (Number.isNaN(date.getTime())) {
      throw new Error(`Invalid Gmail query date: ${value}`);
    }

    return date.toISOString().split('T')[0].replace(/-/g, '/');
  }

  private buildSmartScanQuery(options: SmartGmailScanOptions = {}): string {
    const queryParts = ['in:anywhere'];

    if (!options.includeSpamTrash) {
      queryParts.push('-in:trash', '-in:spam');
    }

    if (options.afterDate) {
      queryParts.push(`after:${this.formatGmailQueryDate(options.afterDate)}`);
    } else if (options.daysBack) {
      const afterDate = new Date();
      afterDate.setDate(afterDate.getDate() - options.daysBack);
      queryParts.push(`after:${this.formatGmailQueryDate(afterDate)}`);
    }

    if (options.beforeDate) {
      queryParts.push(`before:${this.formatGmailQueryDate(options.beforeDate)}`);
    }

    return queryParts.join(' ');
  }

  private isNewsletterByHeaders(headers: any[], subject: string): boolean {
    if (this.isReplyEmail(subject, headers)) {
      return false;
    }

    const listUnsubscribe = this.getHeader(headers, 'List-Unsubscribe');
    const listId = this.getHeader(headers, 'List-Id');
    const precedence = this.getHeader(headers, 'Precedence');
    const autoSubmitted = this.getHeader(headers, 'Auto-Submitted');

    return !!(
      listUnsubscribe ||
      listId ||
      /bulk|list|junk/i.test(precedence) ||
      (autoSubmitted && !/no/i.test(autoSubmitted))
    );
  }

  private shouldSkipByLabels(labelIds: string[]): 'spamTrash' | 'promotions' | null {
    if (labelIds.includes('SPAM') || labelIds.includes('TRASH')) {
      return 'spamTrash';
    }

    if (labelIds.includes('CATEGORY_PROMOTIONS') || labelIds.includes('CATEGORY_SOCIAL')) {
      return 'promotions';
    }

    return null;
  }

  private extractBodyFromPayload(payload: any): string {
    if (!payload) {
      return '';
    }

    if (payload.body?.data) {
      return Buffer.from(payload.body.data, 'base64').toString('utf-8');
    }

    if (!payload.parts?.length) {
      return '';
    }

    let plainText = '';
    let htmlText = '';

    for (const part of payload.parts) {
      const nested = this.extractBodyFromPayload(part);
      if (!nested) {
        continue;
      }

      if (part.mimeType === 'text/html') {
        htmlText += nested;
      } else {
        plainText += nested;
      }
    }

    return plainText || htmlText;
  }

  // Adaptive rate limiting configuration
  private rateLimitConfig = {
    baseDelayMs: 200, // Base delay between API calls (200ms = 5 req/sec max)
    currentDelayMs: 200,
    maxDelayMs: 5000, // Max 5 seconds between retries
    backoffMultiplier: 2, // Double delay on errors
    consecutiveErrors: 0,
    maxConsecutiveErrors: 5, // Reset if too many errors
  };

  constructor(
    @InjectRepository(Email)
    private readonly emailRepository: Repository<Email>,
    private readonly llmCategorizationService: LLMCategorizationService,
    private readonly scanProgressService: ScanProgressService,
    private readonly customersService: CustomersService,
    private readonly filterValidator: FilterValidator,
    private readonly sendEligibilityService: SendEligibilityService,
    private readonly bounceRecoveryService: BounceRecoveryService,
  ) {
    this.initializeOAuth2();
  }

  /**
   * Sleep utility for rate limiting
   */
  private async sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private getSendEligibilityUpdate(updateData: any, existingEmail?: Email) {
    const merged = {
      ...(existingEmail || {}),
      ...updateData,
    };

    return this.sendEligibilityService.buildUpdate({
      verificationStatus: merged.verificationStatus,
      previousVerificationStatus: existingEmail?.verificationStatus,
      qualityScore: Number(merged.qualityScore || 0),
      gmailCategory: merged.gmailCategory,
      hasTypo: merged.hasTypo,
      typoResolutionStatus: merged.typoResolutionStatus,
      isDisposable: merged.isDisposable,
      isRoleBased: merged.isRoleBased,
      hasValidSyntax: merged.hasValidSyntax,
      hasValidDns: merged.hasValidDns,
      hasValidSmtp: merged.hasValidSmtp,
    }, ExternalValidationProvider.INTERNAL);
  }

  private isQualityGateTestEmail(email?: Email | null): boolean {
    return email?.acquisitionSource === 'quality_gate_test';
  }

  private isSuppressedEmail(email?: Email | null): boolean {
    return !!email && [
      VerificationStatus.UNSUBSCRIBED,
      VerificationStatus.INVALID,
      VerificationStatus.DISPOSABLE,
    ].includes(email.verificationStatus);
  }

  private shouldPreserveExistingProtection(email?: Email | null): boolean {
    return this.isQualityGateTestEmail(email) || this.isSuppressedEmail(email) || !!email?.hasTypo;
  }

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

  /**
   * Apply adaptive delay based on current rate limit state
   */
  private async applyRateLimit(): Promise<void> {
    await this.sleep(this.rateLimitConfig.currentDelayMs);
  }

  /**
   * Handle rate limit error with exponential backoff
   */
  private async handleRateLimitError(error: any): Promise<void> {
    const isRateLimitError =
      error.code === 429 ||
      (error.code === 403 && error.message?.includes('rateLimitExceeded'));

    if (isRateLimitError) {
      this.rateLimitConfig.consecutiveErrors++;
      this.rateLimitConfig.currentDelayMs = Math.min(
        this.rateLimitConfig.currentDelayMs * this.rateLimitConfig.backoffMultiplier,
        this.rateLimitConfig.maxDelayMs
      );

      this.logger.warn(
        `Rate limit hit! Backing off to ${this.rateLimitConfig.currentDelayMs}ms delay ` +
        `(consecutive errors: ${this.rateLimitConfig.consecutiveErrors})`
      );

      // If too many consecutive errors, reset to base delay and wait longer
      if (this.rateLimitConfig.consecutiveErrors >= this.rateLimitConfig.maxConsecutiveErrors) {
        this.logger.error('Too many consecutive rate limit errors, resetting and waiting 10s');
        this.rateLimitConfig.currentDelayMs = this.rateLimitConfig.baseDelayMs;
        this.rateLimitConfig.consecutiveErrors = 0;
        await this.sleep(10000);
      } else {
        await this.sleep(this.rateLimitConfig.currentDelayMs);
      }
    } else {
      throw error; // Re-throw if not a rate limit error
    }
  }

  /**
   * Reset rate limit state on successful API calls
   */
  private resetRateLimit(): void {
    if (this.rateLimitConfig.consecutiveErrors > 0) {
      this.logger.log('API calls successful, resetting rate limit state');
      this.rateLimitConfig.consecutiveErrors = 0;
      this.rateLimitConfig.currentDelayMs = this.rateLimitConfig.baseDelayMs;
    }
  }

  /**
   * Parse name from email From header
   * Supports formats:
   * - "Ion Popescu <ion@email.com>"
   * - "Popescu, Ion <ion@email.com>"
   * - "ion@email.com" (returns null)
   */
  private parseNameFromHeader(fromHeader: string): {
    firstName?: string;
    lastName?: string;
    fullName?: string;
  } {
    // Remove email address to get just the name part
    const nameMatch = fromHeader.match(/^([^<]+)<.+>$/);
    if (!nameMatch) {
      return {}; // No name found, just email address
    }

    let namePart = nameMatch[1].trim();

    // Remove quotes if present
    namePart = namePart.replace(/^["']|["']$/g, '');

    // Check if format is "LastName, FirstName"
    if (namePart.includes(',')) {
      const [lastName, firstName] = namePart.split(',').map(s => s.trim());
      return {
        firstName,
        lastName,
        fullName: `${firstName} ${lastName}`.trim(),
      };
    }

    // Otherwise assume "FirstName LastName"
    const parts = namePart.split(/\s+/).filter(p => p.length > 0);
    if (parts.length === 0) {
      return {};
    } else if (parts.length === 1) {
      // Single word - could be first or last name, use as fullName
      return {
        fullName: parts[0],
      };
    } else {
      // Multiple words - first is firstName, rest is lastName
      const firstName = parts[0];
      const lastName = parts.slice(1).join(' ');
      return {
        firstName,
        lastName,
        fullName: namePart,
      };
    }
  }

  private splitFullName(fullName?: string): {
    firstName?: string;
    lastName?: string;
    fullName?: string;
  } {
    if (!fullName) {
      return {};
    }

    const parts = fullName.trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) {
      return {};
    }

    if (parts.length === 1) {
      return { firstName: parts[0], fullName: parts[0] };
    }

    return {
      firstName: parts[0],
      lastName: parts.slice(1).join(' '),
      fullName: parts.join(' '),
    };
  }

  private parsePaymentMethod(paymentText?: string): PaymentMethod {
    const normalized = (paymentText || '').toLowerCase();

    if (/(numerar|ramburs|cash)/i.test(normalized)) {
      return PaymentMethod.CASH_ON_DELIVERY;
    }

    if (/(visa|mastercard|card|stripe|mobilpay|netopia)/i.test(normalized)) {
      return PaymentMethod.CARD;
    }

    if (/(transfer|ordin de plata|bank)/i.test(normalized)) {
      return PaymentMethod.BANK_TRANSFER;
    }

    return PaymentMethod.UNKNOWN;
  }

  private parseWooCommerceOrderCustomer(body: string): ParsedOrderCustomer | null {
    const normalizedBody = body
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n')
      .replace(/\t+/g, '\n')
      .replace(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})(Adres[ăa] de livrare)/gi, '$1\n$2')
      .replace(/(Total:\s*[^\n]+)(Adres[ăa] de facturare)/gi, '$1\n$2')
      .replace(/(Adres[ăa] de livrare)([^\n])/gi, '$1\n$2');

    const billingMatch = normalizedBody.match(
      /Adres[ăa] de facturare\s+([\s\S]*?)(?:\n\s*Adres[ăa] de livrare|\n\s*Administrezi comanda|\n\s*Sesizari|\n\s*Fabricadeasternuturi\.ro|\n\s*Felicitari|\n\s*Iti multumim|$)/i,
    );
    if (!billingMatch) {
      return null;
    }

    const billingLines = billingMatch[1]
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !/^<mailto:/i.test(line) && !/^<tel:/i.test(line));

    const emailLineIndex = billingLines.findIndex((line) =>
      /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/.test(line),
    );

    if (emailLineIndex === -1) {
      return null;
    }

    const email = this.extractEmailAddress(billingLines[emailLineIndex]);
    if (!email) {
      return null;
    }

    if (/@fabricadeasternuturi\.ro$/i.test(email)) {
      return null;
    }

    const phoneIndex = billingLines
      .slice(0, emailLineIndex)
      .findIndex((line) => /^\+?\d[\d\s().-]{6,}$/.test(line));
    const absolutePhoneIndex = phoneIndex === -1 ? -1 : phoneIndex;

    if (!billingLines[0] || billingLines[0].includes('@') || emailLineIndex < 2) {
      return null;
    }

    const fullName = billingLines[0];
    const addressLines = billingLines.slice(1, absolutePhoneIndex === -1 ? emailLineIndex : absolutePhoneIndex);
    const phone = absolutePhoneIndex === -1 ? undefined : billingLines[absolutePhoneIndex];
    const paymentMethodMatch = body.match(/Metod[ăa] de plat[ăa]:\s*([\s\S]*?)(?:\n\s*Total:|\n\s*Adres[ăa] de facturare|$)/i);

    const parsedName = this.splitFullName(fullName);

    return {
      email,
      ...parsedName,
      phone,
      address_1: addressLines[0],
      address_2: addressLines.length > 3 ? addressLines.slice(1, -3).join(', ') : undefined,
      city: addressLines.length >= 3 ? addressLines[addressLines.length - 3] : undefined,
      state: addressLines.length >= 2 ? addressLines[addressLines.length - 2] : undefined,
      postcode: addressLines.length >= 1 ? addressLines[addressLines.length - 1] : undefined,
      country: 'RO',
      preferredPaymentMethod: this.parsePaymentMethod(paymentMethodMatch?.[1]),
    };
  }

  /**
   * Initialize OAuth2 client
   */
  private initializeOAuth2() {
    this.oauth2Client = new google.auth.OAuth2(
      process.env.GMAIL_CLIENT_ID,
      process.env.GMAIL_CLIENT_SECRET,
      process.env.GMAIL_REDIRECT_URI || 'http://localhost:3001/api/gmail/oauth2callback',
    );

    // Set credentials if refresh token is available
    if (process.env.GMAIL_REFRESH_TOKEN) {
      this.oauth2Client.setCredentials({
        refresh_token: process.env.GMAIL_REFRESH_TOKEN,
      });
    }
  }

  /**
   * Get authorization URL for OAuth2
   */
  getAuthUrl(): string {
    const scopes = [
      'https://www.googleapis.com/auth/gmail.readonly',
    ];

    return this.oauth2Client.generateAuthUrl({
      access_type: 'offline',
      scope: scopes,
      prompt: 'consent',
    });
  }

  /**
   * Exchange authorization code for tokens
   */
  async getTokenFromCode(code: string): Promise<any> {
    const { tokens } = await this.oauth2Client.getToken(code);
    this.oauth2Client.setCredentials(tokens);
    return tokens;
  }

  /**
   * Smart single-pass Gmail scan.
   *
   * Lists message IDs first, reads only metadata for every message, and fetches
   * full body only for messages that can update the database.
   */
  async scanGmailSmart(options: SmartGmailScanOptions = {}): Promise<SmartGmailScanResult> {
    const result: SmartGmailScanResult = {
      scanned: 0,
      bodyFetched: 0,
      llmAnalyzed: 0,
      ignored: {
        spamTrash: 0,
        promotions: 0,
        newsletters: 0,
        marketing: 0,
        clean: 0,
      },
      ordersDetected: 0,
      unsubscribeDetected: 0,
      bounceDetected: 0,
      abuseDetected: 0,
      updated: 0,
      created: 0,
      errors: 0,
    };

    try {
      const gmail = google.gmail({ version: 'v1', auth: this.oauth2Client });
      const query = this.buildSmartScanQuery(options);
      const maxResultsPerPage = 500;
      const totalMaxResults = options.maxResults || 500;
      let allMessages = [];
      let pageToken: string | undefined = options.pageToken;
      let fetchedCount = 0;

      this.logger.log(`Starting smart Gmail scan with query: ${query}`);
      this.scanProgressService.updateProgress({ phase: 'smart' });

      do {
        const pageFetchLimit = Math.min(maxResultsPerPage, totalMaxResults - fetchedCount);

        try {
          await this.applyRateLimit();
          const response = await gmail.users.messages.list({
            userId: 'me',
            q: query,
            maxResults: pageFetchLimit,
            pageToken,
          });

          const pageMessages = response.data.messages || [];
          allMessages = allMessages.concat(pageMessages);
          fetchedCount += pageMessages.length;
          pageToken = response.data.nextPageToken;
          this.resetRateLimit();

          if (!pageToken || fetchedCount >= totalMaxResults) {
            break;
          }
        } catch (error) {
          await this.handleRateLimitError(error);
        }
      } while (pageToken && fetchedCount < totalMaxResults);

      for (const message of allMessages) {
        try {
          await this.applyRateLimit();
          const metadataMessage = await gmail.users.messages.get({
            userId: 'me',
            id: message.id,
            format: 'metadata',
            metadataHeaders: [
              'From',
              'To',
              'Subject',
              'Date',
              'In-Reply-To',
              'References',
              'List-Unsubscribe',
              'List-Id',
              'Precedence',
              'Auto-Submitted',
            ],
          });
          this.resetRateLimit();

          result.scanned++;
          if (result.scanned % 10 === 0) {
            this.scanProgressService.updateProgress({ scanned: 10 });
          }

          const headers = metadataMessage.data.payload?.headers || [];
          const context: GmailMessageContext = {
            id: message.id,
            labelIds: metadataMessage.data.labelIds || [],
            headers,
            fromHeader: this.getHeader(headers, 'From'),
            toHeader: this.getHeader(headers, 'To'),
            subjectHeader: this.getHeader(headers, 'Subject'),
            dateHeader: this.getHeader(headers, 'Date'),
            snippet: metadataMessage.data.snippet || '',
          };

          const skipByLabel = this.shouldSkipByLabels(context.labelIds);
          if (skipByLabel) {
            result.ignored[skipByLabel]++;
            continue;
          }

          const quickText = `${context.fromHeader} ${context.subjectHeader} ${context.snippet}`;
          const isOrderCandidate = this.isOrderEmail(
            context.fromHeader,
            context.subjectHeader,
            context.snippet,
            context.headers,
          );
          const isBounceCandidate = this.hasAnyPattern(this.bouncePatterns, quickText);
          const isUnsubscribeCandidate = this.hasAnyPattern(this.unsubscribePatterns, quickText);
          const isAbuseCandidate = this.hasAnyPattern(this.abusePatterns, quickText);
          const isReply = this.isReplyEmail(context.subjectHeader, context.headers);

          if (
            !isOrderCandidate &&
            !isReply &&
            this.isNewsletterByHeaders(context.headers, context.subjectHeader)
          ) {
            result.ignored.newsletters++;
            continue;
          }

          if (
            !isOrderCandidate &&
            !isReply &&
            this.isMarketingEmailReceived(context.fromHeader, context.toHeader, context.headers)
          ) {
            result.ignored.marketing++;
            continue;
          }

          if (
            !isOrderCandidate &&
            !isBounceCandidate &&
            !isUnsubscribeCandidate &&
            !isAbuseCandidate &&
            !isReply
          ) {
            result.ignored.clean++;
            continue;
          }

          await this.applyRateLimit();
          const fullMessage = await gmail.users.messages.get({
            userId: 'me',
            id: message.id,
            format: 'full',
          });
          this.resetRateLimit();
          result.bodyFetched++;

          const fullHeaders = fullMessage.data.payload?.headers || context.headers;
          const body = this.extractBodyFromPayload(fullMessage.data.payload);
          const fullText = `${context.subjectHeader} ${body}`;
          const messageDate = context.dateHeader ? new Date(context.dateHeader) : undefined;

          if (this.isOrderEmail(context.fromHeader, context.subjectHeader, body, fullHeaders)) {
            const orderCustomer = this.parseWooCommerceOrderCustomer(body);
            if (!orderCustomer) {
              this.logger.warn(`Smart scan detected order but could not parse customer: ${context.subjectHeader}`);
              result.errors++;
              continue;
            }

            result.ordersDetected++;
            this.scanProgressService.updateProgress({ orders: 1 });

            if (options.autoUpdate !== false) {
              const wasCreated = await this.markEmailAsValid(orderCustomer.email, {
                firstName: orderCustomer.firstName,
                lastName: orderCustomer.lastName,
                fullName: orderCustomer.fullName,
                phone: orderCustomer.phone,
                address_1: orderCustomer.address_1,
                address_2: orderCustomer.address_2,
                city: orderCustomer.city,
                state: orderCustomer.state,
                postcode: orderCustomer.postcode,
                country: orderCustomer.country,
                preferredPaymentMethod: orderCustomer.preferredPaymentMethod,
                gmailMessageDate: messageDate,
              });
              wasCreated ? result.created++ : result.updated++;
            }
            continue;
          }

          const fromEmail = this.extractEmailAddress(context.fromHeader);
          if (!fromEmail) {
            result.ignored.clean++;
            continue;
          }

          if (this.hasAnyPattern(this.bouncePatterns, fullText)) {
            result.bounceDetected++;
            this.scanProgressService.updateProgress({ bounces: 1 });

            if (options.autoUpdate !== false) {
              const failedRecipient = this.extractFailedRecipientFromBounce(fullHeaders, body, fromEmail);
              const bouncedEmail = failedRecipient || fromEmail;
              const parsedName = failedRecipient ? {} : this.parseNameFromHeader(context.fromHeader);
              const wasCreated = await this.markEmailAsInvalid(bouncedEmail, {
                ...parsedName,
                gmailMessageDate: messageDate,
              });
              wasCreated ? result.created++ : result.updated++;
            }
            continue;
          }

          const hasUnsubscribePattern = this.hasAnyPattern(this.unsubscribePatterns, fullText);
          const hasAbusePattern = this.hasAnyPattern(this.abusePatterns, fullText);
          let category: 'unsubscribe' | 'abuse' | 'clean' | 'ignore' | 'uncertain' = hasUnsubscribePattern
            ? 'unsubscribe'
            : hasAbusePattern
              ? 'abuse'
              : 'clean';
          let confidence = hasUnsubscribePattern || hasAbusePattern ? 85 : 0;

          if (
            this.llmCategorizationService.isAvailable() &&
            (isReply || (!hasUnsubscribePattern && !hasAbusePattern))
          ) {
            const llmResult = await this.llmCategorizationService.categorizeEmail({
              from: context.fromHeader,
              subject: context.subjectHeader,
              body,
            });
            result.llmAnalyzed++;

            const hasPatternCategory = hasUnsubscribePattern || hasAbusePattern;
            const llmHasUsefulResult = llmResult.category !== 'uncertain' && llmResult.confidence > 0;

            if (!hasPatternCategory || llmHasUsefulResult) {
              category = llmResult.category;
              confidence = llmResult.confidence;
            }
          }

          if (category === 'unsubscribe' && confidence >= 60) {
            result.unsubscribeDetected++;
            this.scanProgressService.updateProgress({ unsubscribes: 1 });

            if (options.autoUpdate !== false) {
              const parsedName = this.parseNameFromHeader(context.fromHeader);
              const wasCreated = await this.markEmailAsUnsubscribed(fromEmail, {
                ...parsedName,
                gmailMessageDate: messageDate,
              });
              wasCreated ? result.created++ : result.updated++;
            }
          } else if (category === 'abuse' && confidence >= 70) {
            result.abuseDetected++;
            this.scanProgressService.updateProgress({ abuse: 1 });

            if (options.autoUpdate !== false) {
              const parsedName = this.parseNameFromHeader(context.fromHeader);
              const wasCreated = await this.markEmailAsRisky(fromEmail, {
                ...parsedName,
                gmailMessageDate: messageDate,
              });
              wasCreated ? result.created++ : result.updated++;
            }
          } else {
            result.ignored.clean++;
          }
        } catch (error) {
          this.logger.error(`Smart scan error for message ${message.id}: ${error.message}`);
          result.errors++;
        }
      }

      result.nextPageToken = pageToken;
      this.logger.log(
        `Smart scan complete: ${result.scanned} metadata scanned, ${result.bodyFetched} bodies fetched, ` +
        `${result.ordersDetected} orders, ${result.unsubscribeDetected} unsubscribes, ` +
        `${result.bounceDetected} bounces, ${result.abuseDetected} abuse, nextPageToken: ${pageToken ? 'yes' : 'no'}`,
      );

      return result;
    } catch (error) {
      this.logger.error(`Smart Gmail scan failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * Scan Gmail inbox for unsubscribe requests and bounced emails
   */
  async scanGmailForUnsubscribes(
    options: {
      maxResults?: number;
      daysBack?: number;
      autoUpdate?: boolean;
      pageToken?: string;
    } = {},
  ): Promise<GmailScanResult> {
    const result: GmailScanResult = {
      scanned: 0,
      unsubscribeDetected: 0,
      bounceDetected: 0,
      updated: 0,
      created: 0,
      errors: 0,
    };

    try {
      const gmail = google.gmail({ version: 'v1', auth: this.oauth2Client });

      // Calculate date filter (default: last 90 days)
      const daysBack = options.daysBack || 90;
      const afterDate = new Date();
      afterDate.setDate(afterDate.getDate() - daysBack);
      const afterDateString = afterDate.toISOString().split('T')[0].replace(/-/g, '/');

      // Search for potential unsubscribe emails
      const query = `after:${afterDateString} (unsubscribe OR dezabonare OR "delivery failed" OR "mailer-daemon" OR "out of office")`;

      this.logger.log(`Searching Gmail with query: ${query}, pageToken: ${options.pageToken ? 'continuing' : 'starting'}`);

      // Gmail API has a hard limit of 500 per request, so we need to paginate
      const maxResultsPerPage = 500;
      const totalMaxResults = options.maxResults || 500;
      let allMessages = [];
      let pageToken: string | undefined = options.pageToken;
      let fetchedCount = 0;

      // Fetch messages with pagination (single batch for queue-based scanning)
      do {
        const pageFetchLimit = Math.min(maxResultsPerPage, totalMaxResults - fetchedCount);

        try {
          // Apply rate limiting before API call
          await this.applyRateLimit();

          const response = await gmail.users.messages.list({
            userId: 'me',
            q: query,
            maxResults: pageFetchLimit,
            pageToken: pageToken,
          });

          const pageMessages = response.data.messages || [];
          allMessages = allMessages.concat(pageMessages);
          fetchedCount += pageMessages.length;
          pageToken = response.data.nextPageToken;

          this.logger.log(`Fetched ${pageMessages.length} messages (total: ${fetchedCount})`);

          // Reset rate limit on success
          this.resetRateLimit();

          // Stop if we've reached the desired total or no more pages
          if (!pageToken || fetchedCount >= totalMaxResults) {
            break;
          }
        } catch (error) {
          await this.handleRateLimitError(error);
          // Continue with same pageToken to retry
        }
      } while (pageToken && fetchedCount < totalMaxResults);

      const messages = allMessages;
      this.logger.log(`Found ${messages.length} messages to scan`);

      const detectedEmails: DetectedEmail[] = [];

      // Update progress: starting unsubscribe scan
      this.scanProgressService.updateProgress({ phase: 'unsubscribe' });

      // Process each message
      for (const message of messages) {
        try {
          // Apply rate limiting before each message fetch
          await this.applyRateLimit();

          const msg = await gmail.users.messages.get({
            userId: 'me',
            id: message.id,
            format: 'full',
          });

          result.scanned++;

          // Update progress every 10 emails
          if (result.scanned % 10 === 0) {
            this.scanProgressService.updateProgress({
              scanned: 10,
              unsubscribes: 0, // Will be updated when detected
              bounces: 0,
            });
          }

          // Reset rate limit on successful fetch
          this.resetRateLimit();

          // Extract headers
          const headers = msg.data.payload?.headers || [];
          const fromHeader = headers.find((h) => h.name === 'From')?.value || '';
          const toHeader = headers.find((h) => h.name === 'To')?.value || '';
          const subjectHeader = headers.find((h) => h.name === 'Subject')?.value || '';
          const dateHeader = headers.find((h) => h.name === 'Date')?.value || '';

          // CRITICAL: SKIP marketing emails received by us (newsletters, promotions)
          // These are NOT customer emails - we subscribed to them!
          if (this.isMarketingEmailReceived(fromHeader, toHeader, headers)) {
            this.logger.debug(`SKIP marketing email: ${fromHeader} → ${toHeader}`);
            continue;
          }

          // Extract email address from "From" header
          const emailMatch = fromHeader.match(/<?([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})>?/);
          if (!emailMatch) continue;

          const emailAddress = emailMatch[1].toLowerCase().trim();

          // Get message body
          let body = '';
          if (msg.data.payload?.body?.data) {
            body = Buffer.from(msg.data.payload.body.data, 'base64').toString('utf-8');
          } else if (msg.data.payload?.parts) {
            for (const part of msg.data.payload.parts) {
              if (part.mimeType === 'text/plain' && part.body?.data) {
                body += Buffer.from(part.body.data, 'base64').toString('utf-8');
              }
            }
          }

          const fullText = `${subjectHeader} ${body}`;

          // HYBRID DETECTION APPROACH:
          // 1. Check if this is an order email (pattern-based, free)
          // 2. If NOT an order, use LLM for smart detection (unsubscribe/abuse)
          // 3. Fallback to pattern matching if LLM unavailable

          // Skip orders from expensive LLM analysis
          const isOrder = this.isOrderEmail(fromHeader, subjectHeader, body, headers);
          if (isOrder) {
            // This is an order confirmation, skip it (will be handled by scanGmailForOrders)
            continue;
          }

          let isUnsubscribe = false;
          let isBounce = false;

          // Use LLM for intelligent categorization if available
          if (this.llmCategorizationService.isAvailable()) {
            try {
              const llmResult = await this.llmCategorizationService.categorizeEmail({
                from: fromHeader,
                subject: subjectHeader,
                body: body,
              });

              this.logger.debug(
                `LLM categorized "${subjectHeader}": ${llmResult.category} (confidence: ${llmResult.confidence}%)`,
              );

              if (llmResult.category === 'unsubscribe' && llmResult.confidence >= 60) {
                isUnsubscribe = true;
              }
              // Note: isBounce is handled separately with pattern matching
            } catch (error) {
              this.logger.warn(`LLM categorization failed for ${emailAddress}, falling back to patterns: ${error.message}`);
            }
          }

          // Fallback to pattern matching if LLM not available or failed
          if (!this.llmCategorizationService.isAvailable() || (!isUnsubscribe && !isBounce)) {
            // Check for unsubscribe patterns (fallback)
            for (const pattern of this.unsubscribePatterns) {
              if (pattern.test(fullText)) {
                isUnsubscribe = true;
                break;
              }
            }
          }

          // Always check for bounces with patterns (LLM not needed for technical bounces)
          for (const pattern of this.bouncePatterns) {
            if (pattern.test(fullText)) {
              isBounce = true;
              break;
            }
          }

          if (isUnsubscribe) {
            result.unsubscribeDetected++;
            this.scanProgressService.updateProgress({ unsubscribes: 1 });
            detectedEmails.push({
              email: emailAddress,
              reason: 'Unsubscribe request detected',
              type: 'unsubscribe',
              subject: subjectHeader,
              date: dateHeader,
            });

            if (options.autoUpdate) {
              // Parse name and date from email headers
              const parsedName = this.parseNameFromHeader(fromHeader);
              const messageDate = dateHeader ? new Date(dateHeader) : undefined;

              const wasCreated = await this.markEmailAsUnsubscribed(emailAddress, {
                ...parsedName,
                gmailMessageDate: messageDate,
              });
              if (wasCreated) {
                result.created++;
              } else {
                result.updated++;
              }
            }
          } else if (isBounce) {
            result.bounceDetected++;
            this.scanProgressService.updateProgress({ bounces: 1 });
            const bounceEmail = this.extractFailedRecipientFromBounce(headers, body, emailAddress) || emailAddress;
            detectedEmails.push({
              email: bounceEmail,
              reason: 'Bounce-back detected',
              type: 'bounce',
              subject: subjectHeader,
              date: dateHeader,
            });

            if (options.autoUpdate) {
              // Parse name and date from email headers
              const parsedName = bounceEmail === emailAddress ? this.parseNameFromHeader(fromHeader) : {};
              const messageDate = dateHeader ? new Date(dateHeader) : undefined;

              const wasCreated = await this.markEmailAsInvalid(bounceEmail, {
                ...parsedName,
                gmailMessageDate: messageDate,
              });
              if (wasCreated) {
                result.created++;
              } else {
                result.updated++;
              }
            }
          }
        } catch (error) {
          this.logger.error(`Error processing message ${message.id}: ${error.message}`);
          result.errors++;
        }
      }

      this.logger.log(`Scan complete: ${result.scanned} scanned, ${result.unsubscribeDetected} unsubscribes, ${result.bounceDetected} bounces, nextPageToken: ${pageToken ? 'yes' : 'no'}`);

      result.nextPageToken = pageToken;
      return result;
    } catch (error) {
      this.logger.error(`Gmail scan failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * Mark email as UNSUBSCRIBED in database (creates if doesn't exist)
   * @returns true if created new email, false if updated existing
   */
  private async markEmailAsUnsubscribed(
    emailAddress: string,
    gmailData?: {
      firstName?: string;
      lastName?: string;
      fullName?: string;
      gmailMessageDate?: Date;
    },
  ): Promise<boolean> {
    try {
      const email = await this.emailRepository.findOne({
        where: { email: emailAddress },
      });

      if (this.isQualityGateTestEmail(email)) {
        this.logger.warn(`Skipped unsubscribe update for ${emailAddress}: manually marked as test/ignored`);
        return false;
      }

      const updateData: any = {
        verificationStatus: VerificationStatus.UNSUBSCRIBED,
        lastGmailScanDate: new Date(),
        gmailCategory: 'unsubscribe' as const,
      };

      if (gmailData) {
        if (gmailData.firstName) updateData.firstName = this.normalizeOptionalString(gmailData.firstName, 100);
        if (gmailData.lastName) updateData.lastName = this.normalizeOptionalString(gmailData.lastName, 100);
        if (gmailData.fullName) updateData.fullName = this.normalizeOptionalString(gmailData.fullName, 255);
        if (gmailData.gmailMessageDate) updateData.gmailMessageDate = gmailData.gmailMessageDate;
      }
      Object.assign(updateData, this.getSendEligibilityUpdate(updateData, email || undefined));

      if (email) {
        // Update existing email (preserve existing firstName/lastName if not in gmailData)
        await this.emailRepository.update(email.id, updateData);
        this.logger.log(`Updated ${emailAddress} as UNSUBSCRIBED`);
        return false;
      } else {
        // Create new email entry
        const domain = emailAddress.split('@')[1];
        await this.emailRepository.save({
          email: emailAddress,
          emailDomain: domain,
          qualityScore: 0,
          ...updateData,
        });
        this.logger.log(`Created ${emailAddress} as UNSUBSCRIBED`);
        return true;
      }
    } catch (error) {
      this.logger.error(`Failed to mark ${emailAddress} as unsubscribed: ${error.message}`);
      throw error;
    }
  }

  /**
   * Mark email as INVALID in database (creates if doesn't exist)
   * @returns true if created new email, false if updated existing
   */
  private async markEmailAsInvalid(
    emailAddress: string,
    gmailData?: {
      firstName?: string;
      lastName?: string;
      fullName?: string;
      gmailMessageDate?: Date;
    },
  ): Promise<boolean> {
    try {
      const email = await this.emailRepository.findOne({
        where: { email: emailAddress },
      });

      if (this.isQualityGateTestEmail(email)) {
        this.logger.warn(`Skipped bounce update for ${emailAddress}: existing protected status`);
        return false;
      }

      const updateData: any = {
        verificationStatus: VerificationStatus.INVALID,
        smtpErrorMessage: email?.verificationStatus === VerificationStatus.UNSUBSCRIBED
          ? 'Bounce-back detected from Gmail after unsubscribe'
          : 'Bounce-back detected from Gmail',
        lastGmailScanDate: new Date(),
        gmailCategory: 'bounce' as const,
      };

      if (gmailData) {
        if (gmailData.firstName) updateData.firstName = this.normalizeOptionalString(gmailData.firstName, 100);
        if (gmailData.lastName) updateData.lastName = this.normalizeOptionalString(gmailData.lastName, 100);
        if (gmailData.fullName) updateData.fullName = this.normalizeOptionalString(gmailData.fullName, 255);
        if (gmailData.gmailMessageDate) updateData.gmailMessageDate = gmailData.gmailMessageDate;
      }
      Object.assign(updateData, this.getSendEligibilityUpdate(updateData, email || undefined));

      if (email) {
        // Update existing email
        await this.emailRepository.update(email.id, updateData);
        await this.createBounceRecoveryCandidate(emailAddress, gmailData);
        this.logger.log(`Updated ${emailAddress} as INVALID`);
        return false;
      } else {
        // Create new email entry
        const domain = emailAddress.split('@')[1];
        await this.emailRepository.save({
          email: emailAddress,
          emailDomain: domain,
          qualityScore: 0,
          ...updateData,
        });
        await this.createBounceRecoveryCandidate(emailAddress, gmailData);
        this.logger.log(`Created ${emailAddress} as INVALID`);
        return true;
      }
    } catch (error) {
      this.logger.error(`Failed to mark ${emailAddress} as invalid: ${error.message}`);
      throw error;
    }
  }

  private async createBounceRecoveryCandidate(
    emailAddress: string,
    gmailData?: {
      firstName?: string;
      lastName?: string;
      fullName?: string;
      gmailMessageDate?: Date;
    },
  ): Promise<void> {
    try {
      await this.bounceRecoveryService.createCandidateFromBounce(emailAddress, {
        bouncedAt: gmailData?.gmailMessageDate,
        source: 'gmail_bounce',
        firstName: gmailData?.firstName,
        lastName: gmailData?.lastName,
        fullName: gmailData?.fullName,
      });
    } catch (error) {
      this.logger.warn(`Failed to create bounce recovery candidate for ${emailAddress}: ${error.message}`);
    }
  }

  /**
   * Scan Gmail inbox for order/purchase confirmation emails
   */
  async scanGmailForOrders(
    options: {
      maxResults?: number;
      daysBack?: number;
      autoUpdate?: boolean;
      pageToken?: string;
    } = {},
  ): Promise<OrderScanResult> {
    const result: OrderScanResult = {
      scanned: 0,
      ordersDetected: 0,
      updated: 0,
      created: 0,
      errors: 0,
    };

    try {
      const gmail = google.gmail({ version: 'v1', auth: this.oauth2Client });

      // Calculate date filter
      const daysBack = options.daysBack || 90;
      const afterDate = new Date();
      afterDate.setDate(afterDate.getDate() - daysBack);
      const afterDateString = afterDate.toISOString().split('T')[0].replace(/-/g, '/');

      // Search for order confirmation emails
      const query = `after:${afterDateString} (subject:comandă OR subject:comanda OR subject:order OR subject:"order confirmation" OR subject:"purchase confirmation")`;

      this.logger.log(`Searching Gmail for orders with query: ${query}, pageToken: ${options.pageToken ? 'continuing' : 'starting'}`);

      // Gmail API has a hard limit of 500 per request, so we need to paginate
      const maxResultsPerPage = 500;
      const totalMaxResults = options.maxResults || 500;
      let allMessages = [];
      let pageToken: string | undefined = options.pageToken;
      let fetchedCount = 0;

      // Fetch messages with pagination (single batch for queue-based scanning)
      do {
        const pageFetchLimit = Math.min(maxResultsPerPage, totalMaxResults - fetchedCount);

        try {
          // Apply rate limiting before API call
          await this.applyRateLimit();

          const response = await gmail.users.messages.list({
            userId: 'me',
            q: query,
            maxResults: pageFetchLimit,
            pageToken: pageToken,
          });

          const pageMessages = response.data.messages || [];
          allMessages = allMessages.concat(pageMessages);
          fetchedCount += pageMessages.length;
          pageToken = response.data.nextPageToken;

          this.logger.log(`Fetched ${pageMessages.length} order messages (total: ${fetchedCount})`);

          // Reset rate limit on success
          this.resetRateLimit();

          if (!pageToken || fetchedCount >= totalMaxResults) {
            break;
          }
        } catch (error) {
          await this.handleRateLimitError(error);
          // Continue with same pageToken to retry
        }
      } while (pageToken && fetchedCount < totalMaxResults);

      const messages = allMessages;
      this.logger.log(`Found ${messages.length} order messages to scan`);

      // Update progress: starting orders scan
      this.scanProgressService.updateProgress({ phase: 'orders' });

      // Process each message
      for (const message of messages) {
        try {
          // Apply rate limiting before each message fetch
          await this.applyRateLimit();

          const msg = await gmail.users.messages.get({
            userId: 'me',
            id: message.id,
            format: 'full',
          });

          result.scanned++;

          // Update progress every 10 emails
          if (result.scanned % 10 === 0) {
            this.scanProgressService.updateProgress({
              scanned: 10,
              orders: 0, // Will be updated when detected
            });
          }

          // Reset rate limit on successful fetch
          this.resetRateLimit();

          // Extract headers
          const headers = msg.data.payload?.headers || [];
          const fromHeader = headers.find((h) => h.name === 'From')?.value || '';
          const toHeader = headers.find((h) => h.name === 'To')?.value || '';
          const subjectHeader = headers.find((h) => h.name === 'Subject')?.value || '';
          const dateHeader = headers.find((h) => h.name === 'Date')?.value || '';

          // CRITICAL: SKIP marketing emails received by us (newsletters, promotions)
          // These are NOT customer emails - we subscribed to them!
          if (this.isMarketingEmailReceived(fromHeader, toHeader, headers)) {
            this.logger.debug(`SKIP marketing email: ${fromHeader} → ${toHeader}`);
            continue;
          }

          // Get message body for pattern validation
          let body = '';
          if (msg.data.payload?.body?.data) {
            body = Buffer.from(msg.data.payload.body.data, 'base64').toString('utf-8');
          } else if (msg.data.payload?.parts) {
            for (const part of msg.data.payload.parts) {
              if (part.mimeType === 'text/plain' && part.body?.data) {
                body += Buffer.from(part.body.data, 'base64').toString('utf-8');
              }
            }
          }

          // Use pattern matching to validate this is truly an order
          const isOrder = this.isOrderEmail(fromHeader, subjectHeader, body, headers);
          if (!isOrder) {
            this.logger.debug(`Email "${subjectHeader}" matched order query but failed pattern validation, skipping`);
            continue;
          }

          const orderCustomer = this.parseWooCommerceOrderCustomer(body);
          if (!orderCustomer) {
            this.logger.warn(`Order "${subjectHeader}" detected but customer details could not be parsed, skipping database update`);
            result.errors++;
            continue;
          }

          result.ordersDetected++;
          this.scanProgressService.updateProgress({ orders: 1 });

          if (options.autoUpdate) {
            const messageDate = dateHeader ? new Date(dateHeader) : undefined;

            const wasCreated = await this.markEmailAsValid(orderCustomer.email, {
              firstName: orderCustomer.firstName,
              lastName: orderCustomer.lastName,
              fullName: orderCustomer.fullName,
              phone: orderCustomer.phone,
              address_1: orderCustomer.address_1,
              address_2: orderCustomer.address_2,
              city: orderCustomer.city,
              state: orderCustomer.state,
              postcode: orderCustomer.postcode,
              country: orderCustomer.country,
              preferredPaymentMethod: orderCustomer.preferredPaymentMethod,
              gmailMessageDate: messageDate,
            });
            if (wasCreated) {
              result.created++;
            } else {
              result.updated++;
            }
          }
        } catch (error) {
          this.logger.error(`Error processing order message ${message.id}: ${error.message}`);
          result.errors++;
        }
      }

      this.logger.log(`Order scan complete: ${result.scanned} scanned, ${result.ordersDetected} orders detected, nextPageToken: ${pageToken ? 'yes' : 'no'}`);

      result.nextPageToken = pageToken;
      return result;
    } catch (error) {
      this.logger.error(`Gmail order scan failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * Scan Gmail inbox for abusive/offensive emails
   */
  async scanGmailForAbuse(
    options: {
      maxResults?: number;
      daysBack?: number;
      autoUpdate?: boolean;
      pageToken?: string;
    } = {},
  ): Promise<AbuseScanResult> {
    const result: AbuseScanResult = {
      scanned: 0,
      abuseDetected: 0,
      updated: 0,
      created: 0,
      errors: 0,
    };

    try {
      const gmail = google.gmail({ version: 'v1', auth: this.oauth2Client });

      // Calculate date filter
      const daysBack = options.daysBack || 90;
      const afterDate = new Date();
      afterDate.setDate(afterDate.getDate() - daysBack);
      const afterDateString = afterDate.toISOString().split('T')[0].replace(/-/g, '/');

      // Get all messages (we'll filter by content patterns)
      const query = `after:${afterDateString}`;

      this.logger.log(`Searching Gmail for abuse with query: ${query}, pageToken: ${options.pageToken ? 'continuing' : 'starting'}`);

      // Abusive patterns (Romanian and English)
      const abusePatterns = [
        /\b(fuck|shit|damn|bastard|asshole|bitch)\b/i,
        /\b(muie|pula|pizda|futut|cacat|labagiu)\b/i,
        /\b(idiot|cretin|prost|tembel|imbecil)\b/i,
      ];

      // Gmail API has a hard limit of 500 per request, so we need to paginate
      const maxResultsPerPage = 500;
      const totalMaxResults = options.maxResults || 500;
      let allMessages = [];
      let pageToken: string | undefined = options.pageToken;
      let fetchedCount = 0;

      // Fetch messages with pagination (single batch for queue-based scanning)
      do {
        const pageFetchLimit = Math.min(maxResultsPerPage, totalMaxResults - fetchedCount);

        try {
          // Apply rate limiting before API call
          await this.applyRateLimit();

          const response = await gmail.users.messages.list({
            userId: 'me',
            q: query,
            maxResults: pageFetchLimit,
            pageToken: pageToken,
          });

          const pageMessages = response.data.messages || [];
          allMessages = allMessages.concat(pageMessages);
          fetchedCount += pageMessages.length;
          pageToken = response.data.nextPageToken;

          this.logger.log(`Fetched ${pageMessages.length} messages for abuse scan (total: ${fetchedCount})`);

          // Reset rate limit on success
          this.resetRateLimit();

          if (!pageToken || fetchedCount >= totalMaxResults) {
            break;
          }
        } catch (error) {
          await this.handleRateLimitError(error);
          // Continue with same pageToken to retry
        }
      } while (pageToken && fetchedCount < totalMaxResults);

      const messages = allMessages;
      this.logger.log(`Found ${messages.length} messages to scan for abuse`);

      // Update progress: starting abuse scan
      this.scanProgressService.updateProgress({ phase: 'abuse' });

      // Process each message
      for (const message of messages) {
        try {
          // Apply rate limiting before each message fetch
          await this.applyRateLimit();

          const msg = await gmail.users.messages.get({
            userId: 'me',
            id: message.id,
            format: 'full',
          });

          result.scanned++;

          // Update progress every 10 emails
          if (result.scanned % 10 === 0) {
            this.scanProgressService.updateProgress({
              scanned: 10,
              abuse: 0, // Will be updated when detected
            });
          }

          // Reset rate limit on successful fetch
          this.resetRateLimit();

          // Extract headers
          const headers = msg.data.payload?.headers || [];
          const fromHeader = headers.find((h) => h.name === 'From')?.value || '';
          const toHeader = headers.find((h) => h.name === 'To')?.value || '';
          const subjectHeader = headers.find((h) => h.name === 'Subject')?.value || '';
          const dateHeader = headers.find((h) => h.name === 'Date')?.value || '';

          // CRITICAL: SKIP marketing emails received by us (newsletters, promotions)
          // These are NOT customer emails - we subscribed to them!
          if (this.isMarketingEmailReceived(fromHeader, toHeader, headers)) {
            this.logger.debug(`SKIP marketing email: ${fromHeader} → ${toHeader}`);
            continue;
          }

          // Extract email address from "From" header
          const emailMatch = fromHeader.match(/<?([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})>?/);
          if (!emailMatch) continue;

          const emailAddress = emailMatch[1].toLowerCase().trim();

          // Get message body
          let body = '';
          if (msg.data.payload?.body?.data) {
            body = Buffer.from(msg.data.payload.body.data, 'base64').toString('utf-8');
          } else if (msg.data.payload?.parts) {
            for (const part of msg.data.payload.parts) {
              if (part.mimeType === 'text/plain' && part.body?.data) {
                body += Buffer.from(part.body.data, 'base64').toString('utf-8');
              }
            }
          }

          const fullText = `${subjectHeader} ${body}`;

          // HYBRID DETECTION APPROACH:
          // 1. Check if this is an order email (pattern-based, free)
          // 2. If NOT an order, use LLM for smart abuse detection
          // 3. Fallback to pattern matching if LLM unavailable

          // Skip orders from expensive LLM analysis
          const isOrder = this.isOrderEmail(fromHeader, subjectHeader, body, headers);
          if (isOrder) {
            // This is an order confirmation, skip it (will be handled by scanGmailForOrders)
            continue;
          }

          let isAbusive = false;

          // Use LLM for intelligent abuse categorization if available
          if (this.llmCategorizationService.isAvailable()) {
            try {
              const llmResult = await this.llmCategorizationService.categorizeEmail({
                from: fromHeader,
                subject: subjectHeader,
                body: body,
              });

              this.logger.debug(
                `LLM categorized "${subjectHeader}": ${llmResult.category} (confidence: ${llmResult.confidence}%)`,
              );

              if (llmResult.category === 'abuse' && llmResult.confidence >= 70) {
                isAbusive = true;
              }
            } catch (error) {
              this.logger.warn(`LLM abuse categorization failed for ${emailAddress}, falling back to patterns: ${error.message}`);
            }
          }

          // Fallback to pattern matching if LLM not available or failed
          if (!this.llmCategorizationService.isAvailable() && !isAbusive) {
            // Check for abuse patterns (fallback)
            for (const pattern of abusePatterns) {
              if (pattern.test(fullText)) {
                isAbusive = true;
                break;
              }
            }
          }

          if (isAbusive) {
            result.abuseDetected++;
            this.scanProgressService.updateProgress({ abuse: 1 });

            if (options.autoUpdate) {
              // Parse name and date from email headers
              const parsedName = this.parseNameFromHeader(fromHeader);
              const messageDate = dateHeader ? new Date(dateHeader) : undefined;

              const wasCreated = await this.markEmailAsRisky(emailAddress, {
                ...parsedName,
                gmailMessageDate: messageDate,
              });
              if (wasCreated) {
                result.created++;
              } else {
                result.updated++;
              }
            }
          }
        } catch (error) {
          this.logger.error(`Error processing message for abuse ${message.id}: ${error.message}`);
          result.errors++;
        }
      }

      this.logger.log(`Abuse scan complete: ${result.scanned} scanned, ${result.abuseDetected} abusive emails detected, nextPageToken: ${pageToken ? 'yes' : 'no'}`);

      result.nextPageToken = pageToken;
      return result;
    } catch (error) {
      this.logger.error(`Gmail abuse scan failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * Mark email as VALID in database (creates if doesn't exist)
   * @returns true if created new email, false if updated existing
   */
  private async markEmailAsValid(
    emailAddress: string,
    gmailData?: {
      firstName?: string;
      lastName?: string;
      fullName?: string;
      phone?: string;
      address_1?: string;
      address_2?: string;
      city?: string;
      state?: string;
      postcode?: string;
      country?: string;
      preferredPaymentMethod?: PaymentMethod;
      gmailMessageDate?: Date;
    },
  ): Promise<boolean> {
    try {
      const normalizedEmail = emailAddress.trim().toLowerCase();
      const filterResult = this.filterValidator.validate(normalizedEmail);

      if (filterResult.hasSuggestedCorrection) {
        const wasCreated = await this.markEmailAsTypoReview(normalizedEmail, {
          ...gmailData,
          suggestedEmail: filterResult.suggestedEmail,
          isDisposable: filterResult.isDisposable,
          isRoleBased: filterResult.isRoleBased,
        });

        this.logger.warn(
          `Stored ${normalizedEmail} for typo review instead of marking valid. Suggested: ${filterResult.suggestedEmail}`,
        );

        return wasCreated;
      }

      const email = await this.emailRepository.findOne({
        where: { email: normalizedEmail },
      });

      if (this.isQualityGateTestEmail(email)) {
        this.logger.warn(`Skipped ${normalizedEmail}: manually marked as test/ignored`);
        return false;
      }

      const customer = await this.customersService.upsert({
        email: normalizedEmail,
        firstName: gmailData?.firstName,
        lastName: gmailData?.lastName,
        phone: gmailData?.phone,
        address_1: gmailData?.address_1,
        address_2: gmailData?.address_2,
        city: gmailData?.city,
        state: gmailData?.state,
        postcode: gmailData?.postcode,
        country: gmailData?.country,
        preferredPaymentMethod: gmailData?.preferredPaymentMethod,
      });

      const updateData: any = {
        verificationStatus: VerificationStatus.VALID,
        qualityScore: 100,
        customerId: customer.id,
        lastGmailScanDate: new Date(),
        gmailCategory: 'order' as const,
      };

      const preserveExistingStatus =
        this.shouldPreserveExistingProtection(email) ||
        email?.verificationStatus === VerificationStatus.RISKY;

      if (preserveExistingStatus) {
        delete updateData.verificationStatus;
        delete updateData.qualityScore;
        delete updateData.gmailCategory;
      }

      if (gmailData) {
        if (gmailData.firstName) updateData.firstName = this.normalizeOptionalString(gmailData.firstName, 100);
        if (gmailData.lastName) updateData.lastName = this.normalizeOptionalString(gmailData.lastName, 100);
        if (gmailData.fullName) updateData.fullName = this.normalizeOptionalString(gmailData.fullName, 255);
        if (gmailData.phone) updateData.phone = this.normalizeOptionalString(gmailData.phone, 50);
        if (gmailData.country) updateData.country = this.normalizeOptionalString(gmailData.country, 10);
        if (gmailData.city) updateData.city = this.normalizeOptionalString(gmailData.city, 100);
        if (gmailData.gmailMessageDate) updateData.gmailMessageDate = gmailData.gmailMessageDate;
      }
      if (!preserveExistingStatus) {
        Object.assign(updateData, this.getSendEligibilityUpdate(updateData, email || undefined));
      }

      if (email) {
        // Update existing email
        await this.emailRepository.update(email.id, updateData);
        this.logger.log(`Updated ${normalizedEmail} as VALID`);
        return false;
      } else {
        // Create new email entry
        const domain = normalizedEmail.split('@')[1];
        await this.emailRepository.save({
          email: normalizedEmail,
          emailDomain: domain,
          ...updateData,
        });
        this.logger.log(`Created ${normalizedEmail} as VALID`);
        return true;
      }
    } catch (error) {
      this.logger.error(`Failed to mark ${emailAddress} as valid: ${error.message}`);
      throw error;
    }
  }

  private async markEmailAsTypoReview(
    emailAddress: string,
    gmailData?: {
      firstName?: string;
      lastName?: string;
      fullName?: string;
      phone?: string;
      country?: string;
      city?: string;
      gmailMessageDate?: Date;
      suggestedEmail?: string;
      isDisposable?: boolean;
      isRoleBased?: boolean;
    },
  ): Promise<boolean> {
    const email = await this.emailRepository.findOne({
      where: { email: emailAddress },
    });

    if (this.shouldPreserveExistingProtection(email)) {
      this.logger.warn(`Skipped typo review for ${emailAddress}: existing protected status`);
      return false;
    }

    const updateData: any = {
      verificationStatus: VerificationStatus.RISKY,
      qualityScore: 45,
      hasTypo: true,
      typoSuggestion: gmailData?.suggestedEmail || null,
      isDisposable: !!gmailData?.isDisposable,
      isRoleBased: !!gmailData?.isRoleBased,
      lastGmailScanDate: new Date(),
      gmailCategory: 'order' as const,
      smtpErrorMessage: 'Common-domain typo detected; review suggested correction before sending',
    };

    if (email?.verificationStatus === VerificationStatus.UNSUBSCRIBED) {
      delete updateData.verificationStatus;
      delete updateData.qualityScore;
    }

    if (gmailData) {
      if (gmailData.firstName) updateData.firstName = this.normalizeOptionalString(gmailData.firstName, 100);
      if (gmailData.lastName) updateData.lastName = this.normalizeOptionalString(gmailData.lastName, 100);
      if (gmailData.fullName) updateData.fullName = this.normalizeOptionalString(gmailData.fullName, 255);
      if (gmailData.phone) updateData.phone = this.normalizeOptionalString(gmailData.phone, 50);
      if (gmailData.country) updateData.country = this.normalizeOptionalString(gmailData.country, 10);
      if (gmailData.city) updateData.city = this.normalizeOptionalString(gmailData.city, 100);
      if (gmailData.gmailMessageDate) updateData.gmailMessageDate = gmailData.gmailMessageDate;
    }
    Object.assign(updateData, this.getSendEligibilityUpdate(updateData, email || undefined));

    if (email) {
      await this.emailRepository.update(email.id, updateData);
      return false;
    }

    await this.emailRepository.save({
      email: emailAddress,
      emailDomain: emailAddress.split('@')[1] || null,
      ...updateData,
    });
    return true;
  }

  /**
   * Mark email as RISKY in database (creates if doesn't exist)
   * @returns true if created new email, false if updated existing
   */
  private async markEmailAsRisky(
    emailAddress: string,
    gmailData?: {
      firstName?: string;
      lastName?: string;
      fullName?: string;
      gmailMessageDate?: Date;
    },
  ): Promise<boolean> {
    try {
      const email = await this.emailRepository.findOne({
        where: { email: emailAddress },
      });

      if (this.shouldPreserveExistingProtection(email)) {
        this.logger.warn(`Skipped abuse update for ${emailAddress}: existing protected status`);
        return false;
      }

      const updateData: any = {
        verificationStatus: VerificationStatus.RISKY,
        smtpErrorMessage: 'Abusive/offensive content detected',
        lastGmailScanDate: new Date(),
        gmailCategory: 'abuse' as const,
      };

      if (gmailData) {
        if (gmailData.firstName) updateData.firstName = this.normalizeOptionalString(gmailData.firstName, 100);
        if (gmailData.lastName) updateData.lastName = this.normalizeOptionalString(gmailData.lastName, 100);
        if (gmailData.fullName) updateData.fullName = this.normalizeOptionalString(gmailData.fullName, 255);
        if (gmailData.gmailMessageDate) updateData.gmailMessageDate = gmailData.gmailMessageDate;
      }
      Object.assign(updateData, this.getSendEligibilityUpdate(updateData, email || undefined));

      if (email) {
        // Update existing email
        await this.emailRepository.update(email.id, updateData);
        this.logger.log(`Updated ${emailAddress} as RISKY`);
        return false;
      } else {
        // Create new email entry
        const domain = emailAddress.split('@')[1];
        await this.emailRepository.save({
          email: emailAddress,
          emailDomain: domain,
          qualityScore: 0,
          ...updateData,
        });
        this.logger.log(`Created ${emailAddress} as RISKY`);
        return true;
      }
    } catch (error) {
      this.logger.error(`Failed to mark ${emailAddress} as risky: ${error.message}`);
      throw error;
    }
  }

  /**
   * Get statistics about Gmail-scanned emails
   */
  async getGmailScanStats(): Promise<{
    total: number;
    scanned: number;
    notScanned: number;
    byCategory: {
      unsubscribe: number;
      order: number;
      abuse: number;
      bounce: number;
      clean: number;
    };
    withNames: number;
    withMessageDate: number;
    recentScans: {
      last24h: number;
      last7days: number;
      last30days: number;
    };
  }> {
    try {
      // Get total emails
      const total = await this.emailRepository.count();

      // Get scanned emails (has lastGmailScanDate)
      const scanned = await this.emailRepository.count({
        where: { lastGmailScanDate: Not(IsNull()) },
      });

      // Get emails by category
      const [unsubscribe, order, abuse, bounce, clean] = await Promise.all([
        this.emailRepository.count({ where: { gmailCategory: 'unsubscribe' } }),
        this.emailRepository.count({ where: { gmailCategory: 'order' } }),
        this.emailRepository.count({ where: { gmailCategory: 'abuse' } }),
        this.emailRepository.count({ where: { gmailCategory: 'bounce' } }),
        this.emailRepository.count({ where: { gmailCategory: 'clean' } }),
      ]);

      // Get emails with names extracted
      const withNames = await this.emailRepository.count({
        where: { fullName: Not(IsNull()) },
      });

      // Get emails with message date
      const withMessageDate = await this.emailRepository.count({
        where: { gmailMessageDate: Not(IsNull()) },
      });

      // Get recent scans
      const now = new Date();
      const last24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      const last7days = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      const last30days = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

      const [recentScans24h, recentScans7days, recentScans30days] = await Promise.all([
        this.emailRepository.count({
          where: { lastGmailScanDate: MoreThan(last24h) },
        }),
        this.emailRepository.count({
          where: { lastGmailScanDate: MoreThan(last7days) },
        }),
        this.emailRepository.count({
          where: { lastGmailScanDate: MoreThan(last30days) },
        }),
      ]);

      return {
        total,
        scanned,
        notScanned: total - scanned,
        byCategory: {
          unsubscribe,
          order,
          abuse,
          bounce,
          clean,
        },
        withNames,
        withMessageDate,
        recentScans: {
          last24h: recentScans24h,
          last7days: recentScans7days,
          last30days: recentScans30days,
        },
      };
    } catch (error) {
      this.logger.error(`Failed to get Gmail scan stats: ${error.message}`);
      throw error;
    }
  }

  /**
   * Get sample emails for pattern analysis
   * Returns raw email content (subject + body) for LLM training/testing
   */
  async getSampleEmails(options: {
    category: 'orders' | 'unsubscribe' | 'abuse' | 'bounce';
    maxSamples: number;
    daysBack: number;
  }): Promise<Array<{ from: string; subject: string; body: string; date: string }>> {
    try {
      const gmail = google.gmail({ version: 'v1', auth: this.oauth2Client });

      // Calculate date filter
      const afterDate = new Date();
      afterDate.setDate(afterDate.getDate() - options.daysBack);
      const afterDateString = afterDate.toISOString().split('T')[0].replace(/-/g, '/');

      // Build query based on category
      let query = `after:${afterDateString}`;

      switch (options.category) {
        case 'orders':
          query += ' (subject:comandă OR subject:comanda OR subject:order OR subject:"order confirmation" OR subject:"purchase confirmation")';
          break;
        case 'unsubscribe':
          query += ' (unsubscribe OR dezabonare OR "delivery failed" OR "mailer-daemon" OR "out of office")';
          break;
        case 'abuse':
          query += ' subject:(complaint OR reclamatie OR abuse OR ofensiv)';
          break;
        case 'bounce':
          query += ' (subject:"delivery failed" OR subject:"mailer-daemon" OR subject:"undelivered")';
          break;
      }

      this.logger.log(`Fetching ${options.maxSamples} sample emails for category: ${options.category}`);

      // Fetch messages
      await this.applyRateLimit();
      const response = await gmail.users.messages.list({
        userId: 'me',
        q: query,
        maxResults: options.maxSamples,
      });
      this.resetRateLimit();

      const messages = response.data.messages || [];
      const samples = [];

      // Get full content for each message
      for (const message of messages) {
        try {
          await this.applyRateLimit();
          const msg = await gmail.users.messages.get({
            userId: 'me',
            id: message.id,
            format: 'full',
          });
          this.resetRateLimit();

          // Extract headers
          const headers = msg.data.payload?.headers || [];
          const fromHeader = headers.find((h) => h.name === 'From')?.value || '';
          const subjectHeader = headers.find((h) => h.name === 'Subject')?.value || '';
          const dateHeader = headers.find((h) => h.name === 'Date')?.value || '';

          // Extract body
          let body = '';
          if (msg.data.payload?.body?.data) {
            body = Buffer.from(msg.data.payload.body.data, 'base64').toString('utf-8');
          } else if (msg.data.payload?.parts) {
            for (const part of msg.data.payload.parts) {
              if (part.mimeType === 'text/plain' && part.body?.data) {
                body += Buffer.from(part.body.data, 'base64').toString('utf-8');
              } else if (part.mimeType === 'text/html' && part.body?.data && !body) {
                // Fallback to HTML if no plain text
                body += Buffer.from(part.body.data, 'base64').toString('utf-8');
              }
            }
          }

          // Truncate body to first 1000 chars for analysis
          const truncatedBody = body.substring(0, 1000);

          samples.push({
            from: fromHeader,
            subject: subjectHeader,
            body: truncatedBody,
            date: dateHeader,
          });
        } catch (error) {
          this.logger.error(`Error fetching sample message: ${error.message}`);
        }
      }

      this.logger.log(`Retrieved ${samples.length} sample emails for category: ${options.category}`);
      return samples;
    } catch (error) {
      this.logger.error(`Failed to get sample emails: ${error.message}`);
      throw error;
    }
  }

  /**
   * Get OAuth2 status
   */
  getOAuthStatus(): {
    configured: boolean;
    hasRefreshToken: boolean;
  } {
    return {
      configured: !!(process.env.GMAIL_CLIENT_ID && process.env.GMAIL_CLIENT_SECRET),
      hasRefreshToken: !!process.env.GMAIL_REFRESH_TOKEN,
    };
  }
}
