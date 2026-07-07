export const PUBLIC_MAILBOX_DOMAINS_CORE_RO = [
  'gmail.com',
  'googlemail.com',
  'yahoo.com',
  'yahoo.ro',
  'ymail.com',
  'rocketmail.com',
  'hotmail.com',
  'outlook.com',
  'live.com',
  'icloud.com',
  'me.com',
  'protonmail.com',
  'proton.me',
] as const;

export const PUBLIC_MAILBOX_DOMAINS_OBSERVE = [
  'aol.com',
  'msn.com',
  'mac.com',
  'mail.com',
  'gmx.com',
  'gmx.net',
] as const;

const PUBLIC_MAILBOX_CORE_SET = new Set<string>(PUBLIC_MAILBOX_DOMAINS_CORE_RO);
const PUBLIC_MAILBOX_OBSERVE_SET = new Set<string>(PUBLIC_MAILBOX_DOMAINS_OBSERVE);

export function normalizeEmailDomain(domain: string | null | undefined): string {
  return String(domain || '').trim().toLowerCase();
}

export function extractEmailDomain(email: string | null | undefined): string {
  const parts = String(email || '').trim().toLowerCase().split('@');
  return parts.length === 2 ? normalizeEmailDomain(parts[1]) : '';
}

export function isPublicMailboxDomain(
  domain: string | null | undefined,
  options: { includeObserve?: boolean } = {},
): boolean {
  const normalizedDomain = normalizeEmailDomain(domain);
  return (
    PUBLIC_MAILBOX_CORE_SET.has(normalizedDomain) ||
    (!!options.includeObserve && PUBLIC_MAILBOX_OBSERVE_SET.has(normalizedDomain))
  );
}
