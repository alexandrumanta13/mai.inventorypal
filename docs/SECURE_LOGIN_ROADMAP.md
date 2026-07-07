# Secure Login Roadmap

## Status

Parked for later implementation. The current priority remains production hardening, schema migrations, and deploy stability.

## Recommended Direction

Implement Google Sign-In first, then add TOTP-based 2FA for local admin fallback accounts.

### Phase 1: Google Sign-In

- Use Google OpenID Connect for authentication, not Gmail API scopes.
- Request only `openid email profile`.
- Add an allowlist:
  - `GOOGLE_ALLOWED_EMAILS` for exact admin/operator emails.
  - `GOOGLE_ALLOWED_DOMAINS` only if a full domain should be trusted.
- Continue issuing the existing internal JWT after successful Google authentication.
- Keep local password login as a break-glass fallback.

Required environment variables:

```env
GOOGLE_AUTH_ENABLED=false
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_CALLBACK_URL=https://mailpal.inventorypal.ro/api/auth/google/callback
GOOGLE_ALLOWED_EMAILS=
GOOGLE_ALLOWED_DOMAINS=
```

Expected endpoints:

```text
GET /api/auth/google
GET /api/auth/google/callback
```

### Phase 2: Local Login Hardening

- Keep public registration disabled by default.
- Add login rate limiting.
- Use generic login failure messages.
- Add audit events for login success/failure.
- Restrict admin creation to the `seed:admin` flow and environment-provided credentials.

### Phase 3: TOTP 2FA

- Require TOTP for admin users who use local password login.
- Store TOTP secrets encrypted or otherwise protected at rest.
- Store recovery codes hashed, not plaintext.
- Flow:
  - Email/password succeeds.
  - Backend returns a pending 2FA state.
  - User submits TOTP code.
  - Backend issues the normal JWT.

Suggested environment variables:

```env
TOTP_REQUIRED_FOR_ADMINS=true
TOTP_ISSUER=InventoryPal Email
```

## Notes

- Avoid SMS-based 2FA.
- Prefer passkeys/WebAuthn later if this becomes a broader admin surface with more users.
- Gmail API OAuth credentials should remain separate from Google Sign-In credentials unless the OAuth app is deliberately configured for both use cases.
