import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { resolveMx, MxRecord } from 'dns';
import { promisify } from 'util';

const resolveMxAsync = promisify(resolveMx);

export interface DnsValidationResult {
  isValid: boolean;
  hasMxRecords: boolean;
  mxRecords?: MxRecord[];
  reason?: string;
  fromCache?: boolean;
}

/**
 * Layer 2: DNS/MX Record Validation
 *
 * Checks if the email domain has valid MX (Mail Exchange) records
 * - Verifies domain can receive emails
 * - Caches results in Redis (24h TTL) to reduce DNS queries
 * - Handles DNS timeouts and errors gracefully
 *
 * Uses: Node.js built-in dns module
 * Speed: ~50-200ms per domain (first time), ~1ms (cached)
 * Cache: 24 hours per domain
 */
@Injectable()
export class DnsValidator implements OnModuleInit {
  private readonly logger = new Logger(DnsValidator.name);
  private readonly CACHE_TTL = 24 * 60 * 60; // 24 hours in seconds
  private readonly CACHE_PREFIX = 'dns:mx:';
  private redis: Redis;

  constructor(private readonly configService: ConfigService) {}

  onModuleInit() {
    // Initialize Redis client
    this.redis = new Redis({
      host: this.configService.get('redis.host'),
      port: this.configService.get('redis.port'),
      username: this.configService.get('redis.username') || undefined,
      password: this.configService.get('redis.password'),
      db: this.configService.get('redis.db'),
    });
  }

  /**
   * Validate email domain has MX records
   */
  async validate(email: string): Promise<DnsValidationResult> {
    // Extract domain from email
    const domain = this.extractDomain(email);

    if (!domain) {
      return {
        isValid: false,
        hasMxRecords: false,
        reason: 'Invalid email format (cannot extract domain)',
      };
    }

    // Check cache first
    const cachedResult = await this.getCachedResult(domain);
    if (cachedResult) {
      return {
        ...cachedResult,
        fromCache: true,
      };
    }

    // Perform DNS lookup
    try {
      const mxRecords = await resolveMxAsync(domain);

      if (!mxRecords || mxRecords.length === 0) {
        const result: DnsValidationResult = {
          isValid: false,
          hasMxRecords: false,
          reason: 'No MX records found for domain',
        };

        // Cache negative result (shorter TTL)
        await this.cacheResult(domain, result, this.CACHE_TTL / 4); // 6 hours

        return result;
      }

      // Sort MX records by priority (lower number = higher priority)
      const sortedRecords = mxRecords.sort((a, b) => a.priority - b.priority);

      const result: DnsValidationResult = {
        isValid: true,
        hasMxRecords: true,
        mxRecords: sortedRecords,
      };

      // Cache positive result
      await this.cacheResult(domain, result, this.CACHE_TTL);

      return result;
    } catch (error) {
      // DNS lookup failed
      const errorMessage = error.code || error.message;

      this.logger.warn(`DNS lookup failed for ${domain}: ${errorMessage}`);

      const result: DnsValidationResult = {
        isValid: false,
        hasMxRecords: false,
        reason: `DNS lookup failed: ${errorMessage}`,
      };

      // Cache error result (short TTL)
      await this.cacheResult(domain, result, 60 * 60); // 1 hour

      return result;
    }
  }

  /**
   * Validate multiple domains in batch
   */
  async validateBatch(emails: string[]): Promise<Map<string, DnsValidationResult>> {
    const results = new Map<string, DnsValidationResult>();

    // Process in parallel (with concurrency limit to avoid DNS overload)
    const CONCURRENCY = 10;
    const chunks = this.chunkArray(emails, CONCURRENCY);

    for (const chunk of chunks) {
      const chunkResults = await Promise.all(
        chunk.map(async (email) => {
          const normalizedEmail = email.trim().toLowerCase();
          const result = await this.validate(normalizedEmail);
          return { email: normalizedEmail, result };
        }),
      );

      chunkResults.forEach(({ email, result }) => {
        results.set(email, result);
      });
    }

    return results;
  }

  /**
   * Extract domain from email address
   */
  private extractDomain(email: string): string | null {
    const normalizedEmail = email?.trim().toLowerCase();

    if (!normalizedEmail || !normalizedEmail.includes('@')) {
      return null;
    }

    const parts = normalizedEmail.split('@');
    if (parts.length !== 2) {
      return null;
    }

    return parts[1];
  }

  /**
   * Get cached DNS result from Redis
   */
  private async getCachedResult(domain: string): Promise<DnsValidationResult | null> {
    try {
      const cacheKey = `${this.CACHE_PREFIX}${domain}`;
      const cached = await this.redis.get(cacheKey);

      if (!cached) {
        return null;
      }

      return JSON.parse(cached);
    } catch (error) {
      this.logger.error(`Cache read error for ${domain}: ${error.message}`);
      return null;
    }
  }

  /**
   * Cache DNS result in Redis
   */
  private async cacheResult(
    domain: string,
    result: DnsValidationResult,
    ttl: number,
  ): Promise<void> {
    try {
      const cacheKey = `${this.CACHE_PREFIX}${domain}`;
      await this.redis.setex(cacheKey, ttl, JSON.stringify(result));
    } catch (error) {
      this.logger.error(`Cache write error for ${domain}: ${error.message}`);
    }
  }

  /**
   * Split array into chunks
   */
  private chunkArray<T>(array: T[], chunkSize: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < array.length; i += chunkSize) {
      chunks.push(array.slice(i, i + chunkSize));
    }
    return chunks;
  }

  /**
   * Clear cache for specific domain
   */
  async clearCache(domain: string): Promise<void> {
    const cacheKey = `${this.CACHE_PREFIX}${domain}`;
    await this.redis.del(cacheKey);
  }

  /**
   * Get cache statistics
   */
  async getCacheStats(): Promise<{
    totalKeys: number;
    domains: string[];
  }> {
    const pattern = `${this.CACHE_PREFIX}*`;
    const keys = await this.redis.keys(pattern);

    const domains = keys.map((key) => key.replace(this.CACHE_PREFIX, ''));

    return {
      totalKeys: keys.length,
      domains,
    };
  }
}
