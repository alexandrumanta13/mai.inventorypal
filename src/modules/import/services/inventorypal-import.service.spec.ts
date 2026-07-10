import { ExternalValidationProvider, SendEligibility } from '@shared/enums/email-validation.enum';
import { VerificationStatus } from '@shared/enums/verification-status.enum';
import { InventoryPalImportService } from './inventorypal-import.service';

describe('InventoryPalImportService recovery email selection', () => {
  const service = InventoryPalImportService.prototype as any;

  it('uses the accepted correction for a recoverable order', () => {
    expect(service.getEffectiveRecoverableEmail({
      candidateEmail: 'maria@gmial.com',
      candidateTypoResolutionStatus: 'accepted',
      candidateTypoResolvedEmail: 'maria@gmail.com',
    })).toBe('maria@gmail.com');
  });

  it('keeps the original candidate before a correction is accepted', () => {
    expect(service.getEffectiveRecoverableEmail({
      candidateEmail: 'maria@gmial.com',
      candidateTypoResolutionStatus: 'pending',
      candidateTypoResolvedEmail: null,
    })).toBe('maria@gmial.com');
  });

  it('inherits only successful external validation', () => {
    expect(service.canInheritRecoveredExternalValidation({
      verificationStatus: VerificationStatus.VALID,
      sendEligibility: SendEligibility.SAFE_TO_SEND,
      lastValidationSource: ExternalValidationProvider.ZEROBOUNCE,
    })).toBe(true);

    expect(service.canInheritRecoveredExternalValidation({
      verificationStatus: VerificationStatus.VALID,
      sendEligibility: SendEligibility.SAFE_TO_SEND,
      lastValidationSource: ExternalValidationProvider.INTERNAL,
    })).toBe(false);
  });

  it('removes accepted corrections from the import needs-validation queue', () => {
    expect(service.needsExternalValidationForRecoverableCandidate({
      verificationStatus: VerificationStatus.RISKY,
      sendEligibility: SendEligibility.REVIEW,
      doNotSendReason: 'typo_accepted_external_validation_required',
      typoResolutionStatus: 'accepted',
      typoResolvedEmail: 'maria@gmail.com',
    }, false)).toBe(false);
  });
});
