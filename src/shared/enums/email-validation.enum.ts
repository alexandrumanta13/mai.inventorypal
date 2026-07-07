export enum ExternalValidationProvider {
  INTERNAL = 'internal',
  ZEROBOUNCE = 'zerobounce',
  NEVERBOUNCE = 'neverbounce',
  ELASTIC_EMAIL = 'elastic_email',
  MANUAL = 'manual',
  UNKNOWN = 'unknown',
}

export enum EmailValidationBatchStatus {
  DRAFT = 'draft',
  QUEUED = 'queued',
  SUBMITTED = 'submitted',
  RUNNING = 'running',
  COMPLETED = 'completed',
  FAILED = 'failed',
  CANCELLED = 'cancelled',
}

export enum EmailValidationSourceSegment {
  SUPPLIKIT_INTAKE = 'supplikit_intake',
  EXISTING_DOMAIN = 'existing_domain',
  TYPO_RESOLVED = 'typo_resolved',
  BOUNCE_RECOVERY = 'bounce_recovery',
  MANUAL = 'manual',
  CSV_IMPORT = 'csv_import',
  UNKNOWN = 'unknown',
}

export enum EmailValidationMappedStatus {
  PENDING = 'pending',
  VALID = 'valid',
  INVALID = 'invalid',
  RISKY = 'risky',
  DISPOSABLE = 'disposable',
  UNKNOWN = 'unknown',
  CATCH_ALL = 'catch_all',
  DO_NOT_MAIL = 'do_not_mail',
  SPAMTRAP = 'spamtrap',
  ABUSE = 'abuse',
}

export enum SendEligibility {
  PENDING = 'pending',
  SAFE_TO_SEND = 'safe_to_send',
  REVIEW = 'review',
  DO_NOT_SEND = 'do_not_send',
}
