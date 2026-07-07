import { Injectable } from '@nestjs/common';
import { Email } from '../entities/email.entity';
import { ExternalValidationProvider, SendEligibility } from '@shared/enums/email-validation.enum';
import { VerificationStatus } from '@shared/enums/verification-status.enum';

export interface SendEligibilityInput {
  verificationStatus?: VerificationStatus;
  previousVerificationStatus?: VerificationStatus;
  qualityScore?: number;
  gmailCategory?: 'unsubscribe' | 'order' | 'abuse' | 'bounce' | 'clean' | null;
  hasTypo?: boolean | null;
  typoResolutionStatus?: 'pending' | 'accepted' | 'ignored' | null;
  isDisposable?: boolean | null;
  isRoleBased?: boolean | null;
  hasValidSyntax?: boolean | null;
  hasValidDns?: boolean | null;
  hasValidSmtp?: boolean | null;
}

export interface SendEligibilityDecision {
  sendEligibility: SendEligibility;
  doNotSendReason: string | null;
}

@Injectable()
export class SendEligibilityService {
  calculate(input: SendEligibilityInput): SendEligibilityDecision {
    if (input.gmailCategory === 'bounce' || input.verificationStatus === VerificationStatus.INVALID) {
      return this.doNotSend(
        input.previousVerificationStatus === VerificationStatus.UNSUBSCRIBED
          ? 'bounce_after_unsubscribe'
          : input.gmailCategory === 'bounce'
            ? 'bounce'
            : 'invalid',
      );
    }

    if (input.isDisposable || input.verificationStatus === VerificationStatus.DISPOSABLE) {
      return this.doNotSend('disposable');
    }

    if (input.gmailCategory === 'unsubscribe' || input.verificationStatus === VerificationStatus.UNSUBSCRIBED) {
      return this.doNotSend('unsubscribed');
    }

    if (input.gmailCategory === 'abuse' || input.verificationStatus === VerificationStatus.RISKY) {
      return {
        sendEligibility: SendEligibility.REVIEW,
        doNotSendReason: input.gmailCategory === 'abuse' ? 'abuse_detected' : 'risky',
      };
    }

    if (input.hasTypo) {
      if (input.typoResolutionStatus === 'ignored') {
        return this.doNotSend('typo_ignored');
      }

      return {
        sendEligibility: SendEligibility.REVIEW,
        doNotSendReason:
          input.typoResolutionStatus === 'accepted'
            ? 'typo_accepted_external_validation_required'
            : 'typo_pending',
      };
    }

    if (input.isRoleBased) {
      return {
        sendEligibility: SendEligibility.REVIEW,
        doNotSendReason: 'role_based',
      };
    }

    if (input.verificationStatus === VerificationStatus.UNKNOWN) {
      return {
        sendEligibility: SendEligibility.REVIEW,
        doNotSendReason: 'unknown',
      };
    }

    if (input.verificationStatus === VerificationStatus.VALID) {
      const qualityScore = Number(input.qualityScore || 0);
      if (qualityScore >= 60) {
        return {
          sendEligibility: SendEligibility.SAFE_TO_SEND,
          doNotSendReason: null,
        };
      }

      return {
        sendEligibility: SendEligibility.REVIEW,
        doNotSendReason: 'low_quality_score',
      };
    }

    return {
      sendEligibility: SendEligibility.PENDING,
      doNotSendReason: null,
    };
  }

  calculateForEmail(email: Partial<Email>): SendEligibilityDecision {
    return this.calculate({
      verificationStatus: email.verificationStatus,
      qualityScore: Number(email.qualityScore || 0),
      gmailCategory: email.gmailCategory,
      hasTypo: email.hasTypo,
      typoResolutionStatus: email.typoResolutionStatus,
      isDisposable: email.isDisposable,
      isRoleBased: email.isRoleBased,
      hasValidSyntax: email.hasValidSyntax,
      hasValidDns: email.hasValidDns,
      hasValidSmtp: email.hasValidSmtp,
    });
  }

  buildUpdate(
    input: SendEligibilityInput,
    source: ExternalValidationProvider = ExternalValidationProvider.INTERNAL,
  ): {
    sendEligibility: SendEligibility;
    doNotSendReason: string | null;
    lastValidationSource: ExternalValidationProvider;
    lastValidationAt: Date;
  } {
    const decision = this.calculate(input);

    return {
      ...decision,
      lastValidationSource: source,
      lastValidationAt: new Date(),
    };
  }

  private doNotSend(reason: string): SendEligibilityDecision {
    return {
      sendEligibility: SendEligibility.DO_NOT_SEND,
      doNotSendReason: reason,
    };
  }
}
