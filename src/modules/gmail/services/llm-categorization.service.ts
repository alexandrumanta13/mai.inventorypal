import { Injectable, Logger } from '@nestjs/common';
import OpenAI from 'openai';

/**
 * LLM-based Email Categorization Service
 *
 * Uses OpenAI GPT-4o-mini for intelligent email categorization
 * Focuses on unsubscribe requests and abuse/offensive content detection
 *
 * Cost: ~$0.15/1M input tokens (~400 tokens/email = $0.00006/email)
 */
@Injectable()
export class LLMCategorizationService {
  private readonly logger = new Logger(LLMCategorizationService.name);
  private openai: OpenAI;

  constructor() {
    const apiKey = process.env.OPENAI_API_KEY;

    if (!apiKey) {
      this.logger.warn('OpenAI API key not configured. LLM categorization will be disabled.');
      this.openai = null;
    } else {
      this.openai = new OpenAI({ apiKey });
      this.logger.log('OpenAI LLM categorization service initialized');
    }
  }

  /**
   * Check if LLM is configured and available
   */
  isAvailable(): boolean {
    return !!this.openai;
  }

  /**
   * Categorize email using OpenAI GPT-4o-mini
   * Returns category: 'unsubscribe' | 'abuse' | 'clean' | 'ignore' | 'uncertain'
   *
   * IMPORTANT: Only call this for non-order, non-bounce emails
   * Order emails should be filtered out BEFORE calling this method
   */
  async categorizeEmail(emailData: {
    from: string;
    subject: string;
    body: string;
  }): Promise<{
    category: 'unsubscribe' | 'abuse' | 'clean' | 'ignore' | 'uncertain';
    confidence: number; // 0-100
    reasoning?: string;
  }> {
    if (!this.isAvailable()) {
      this.logger.warn('LLM not available, returning uncertain');
      return { category: 'uncertain', confidence: 0 };
    }

    try {
      // Truncate body to ~1000 chars to reduce token usage
      const truncatedBody = emailData.body.substring(0, 1000);

      const prompt = `Analyze this email and categorize it precisely.

EMAIL DATA:
From: ${emailData.from}
Subject: ${emailData.subject}
Body (first 1000 chars): ${truncatedBody}

TASK:
Categorize this email into ONE of these categories:
1. "unsubscribe" - Client wants to UNSUBSCRIBE from marketing emails/newsletter (dezabonare, stop receiving promotional emails, opt-out from mailing list)
2. "abuse" - Offensive, threatening, spam complaints, or abusive language
3. "clean" - Normal customer email, customer service requests, questions, etc.
4. "ignore" - Newsletter, promotion, automated marketing, unrelated spam, or non-customer bulk email

CRITICAL DISTINCTIONS:
❌ "Vreau să anulez comanda" = ORDER CANCELLATION (customer service) → "clean"
✅ "Vreau să mă dezabonez" / "Stop sending me emails" → "unsubscribe"
❌ "Am o problemă cu comanda" = CUSTOMER SERVICE → "clean"
✅ "Remove me from your mailing list" → "unsubscribe"

IMPORTANT CONTEXT:
- This email is NOT an order confirmation (already filtered out)
- This email is NOT a delivery bounce (already filtered out)
- Look for INTENT, not just keywords containing "comanda"/"order"
- Order cancellation/returns/refunds = customer service = "clean"
- Only mark "unsubscribe" if specifically requesting to stop receiving emails/newsletters
- Replies to order emails might contain unsubscribe/abuse requests
- Be precise: only mark as unsubscribe/abuse if truly relevant

Romanian and English emails are both common.

RESPOND ONLY WITH VALID JSON:
{
  "category": "unsubscribe" | "abuse" | "clean" | "ignore",
  "confidence": 0-100,
  "reasoning": "brief explanation in 1 sentence"
}`;

      const response = await this.openai.chat.completions.create({
        model: 'gpt-4o-mini', // Cheapest, fastest model
        messages: [
          {
            role: 'system',
            content: 'You are an expert email categorization system. Respond ONLY with valid JSON.',
          },
          {
            role: 'user',
            content: prompt,
          },
        ],
        temperature: 0.1, // Low temperature for consistent, deterministic results
        max_tokens: 150, // Small response = lower cost
        response_format: { type: 'json_object' }, // Force JSON response
      });

      const content = response.choices[0]?.message?.content;
      if (!content) {
        throw new Error('Empty response from OpenAI');
      }

      const result = JSON.parse(content);

      this.logger.log(
        `LLM categorized email: ${result.category} (confidence: ${result.confidence}%) - ${emailData.subject.substring(0, 50)}`,
      );

      return {
      category: result.category || 'uncertain',
        confidence: result.confidence || 0,
        reasoning: result.reasoning,
      };
    } catch (error) {
      this.logger.error(`LLM categorization failed: ${error.message}`);
      return { category: 'uncertain', confidence: 0 };
    }
  }

  /**
   * Batch categorize multiple emails
   * Processes emails sequentially to respect rate limits
   * Returns array of categorization results
   */
  async categorizeEmailBatch(
    emails: Array<{ from: string; subject: string; body: string }>,
  ): Promise<
    Array<{
      category: 'unsubscribe' | 'abuse' | 'clean' | 'ignore' | 'uncertain';
      confidence: number;
      reasoning?: string;
    }>
  > {
    const results = [];

    for (const email of emails) {
      const result = await this.categorizeEmail(email);
      results.push(result);

      // Small delay to respect rate limits (10 req/sec for gpt-4o-mini tier 1)
      await new Promise((resolve) => setTimeout(resolve, 120)); // 120ms = ~8 req/sec
    }

    return results;
  }

  /**
   * Get estimated cost for categorizing N emails
   */
  getEstimatedCost(emailCount: number): {
    inputTokens: number;
    outputTokens: number;
    totalCost: number;
  } {
    // Estimates:
    // - Input: ~400 tokens/email (prompt + email data)
    // - Output: ~50 tokens/email (JSON response)
    // - gpt-4o-mini pricing: $0.15/1M input, $0.60/1M output

    const inputTokens = emailCount * 400;
    const outputTokens = emailCount * 50;

    const inputCost = (inputTokens / 1_000_000) * 0.15;
    const outputCost = (outputTokens / 1_000_000) * 0.6;
    const totalCost = inputCost + outputCost;

    return {
      inputTokens,
      outputTokens,
      totalCost: Math.round(totalCost * 100) / 100, // Round to 2 decimals
    };
  }
}
