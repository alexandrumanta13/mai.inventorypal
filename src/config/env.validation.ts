const VALID_NODE_ENVS = ['development', 'production', 'test'] as const;
const VALID_PROCESS_ROLES = ['api', 'worker', 'all'] as const;

type NodeEnv = (typeof VALID_NODE_ENVS)[number];
type ProcessRole = (typeof VALID_PROCESS_ROLES)[number];

function getString(config: Record<string, unknown>, key: string): string | undefined {
  const value = config[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function validateRequired(
  config: Record<string, unknown>,
  key: string,
  errors: string[],
): void {
  if (!getString(config, key)) {
    errors.push(`${key} is required`);
  }
}

function validateInteger(
  config: Record<string, unknown>,
  key: string,
  errors: string[],
  options: { required?: boolean; min?: number } = {},
): void {
  const value = getString(config, key);

  if (!value) {
    if (options.required) {
      errors.push(`${key} is required`);
    }
    return;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed)) {
    errors.push(`${key} must be an integer`);
    return;
  }

  if (options.min !== undefined && parsed < options.min) {
    errors.push(`${key} must be greater than or equal to ${options.min}`);
  }
}

function validateBoolean(config: Record<string, unknown>, key: string, errors: string[]): void {
  const value = getString(config, key);
  if (!value) {
    return;
  }

  if (!['true', 'false'].includes(value)) {
    errors.push(`${key} must be either "true" or "false"`);
  }
}

export function validateEnv(config: Record<string, unknown>): Record<string, unknown> {
  const errors: string[] = [];
  const nodeEnv = getString(config, 'NODE_ENV') || 'development';

  if (!VALID_NODE_ENVS.includes(nodeEnv as NodeEnv)) {
    errors.push(`NODE_ENV must be one of: ${VALID_NODE_ENVS.join(', ')}`);
  }

  const processRole = getString(config, 'INVENTORYPAL_PROCESS_ROLE') || 'all';
  if (!VALID_PROCESS_ROLES.includes(processRole as ProcessRole)) {
    errors.push(`INVENTORYPAL_PROCESS_ROLE must be one of: ${VALID_PROCESS_ROLES.join(', ')}`);
  }

  const isProduction = nodeEnv === 'production';

  validateInteger(config, 'PORT', errors, { min: 1 });
  validateRequired(config, 'DB_HOST', errors);
  validateInteger(config, 'DB_PORT', errors, { required: true, min: 1 });
  validateRequired(config, 'DB_USERNAME', errors);
  validateRequired(config, 'DB_DATABASE', errors);
  validateRequired(config, 'JWT_SECRET', errors);

  if (isProduction) {
    validateRequired(config, 'DB_PASSWORD', errors);
    validateRequired(config, 'REDIS_HOST', errors);
    validateInteger(config, 'REDIS_PORT', errors, { required: true, min: 1 });
    validateRequired(config, 'REDIS_PASSWORD', errors);
  } else {
    validateInteger(config, 'REDIS_PORT', errors, { min: 1 });
  }

  validateInteger(config, 'REDIS_DB', errors, { min: 0 });
  validateInteger(config, 'EMAIL_VERIFICATION_TIMEOUT', errors, { min: 1 });
  validateInteger(config, 'BULLMQ_CONCURRENCY', errors, { min: 1 });
  validateInteger(config, 'BULLMQ_RATE_LIMIT_MAX', errors, { min: 1 });
  validateInteger(config, 'BULLMQ_RATE_LIMIT_DURATION', errors, { min: 1 });
  validateBoolean(config, 'DB_LOGGING', errors);
  validateBoolean(config, 'DB_SYNCHRONIZE', errors);
  validateBoolean(config, 'ALLOW_PUBLIC_REGISTRATION', errors);

  if (errors.length > 0) {
    throw new Error(`Invalid environment configuration:\n- ${errors.join('\n- ')}`);
  }

  return {
    ...config,
    NODE_ENV: nodeEnv,
    INVENTORYPAL_PROCESS_ROLE: processRole,
  };
}
