# SalonBook — Authentication Audit, Fixes & Operations

This document records the email/password authentication audit for NF Signature
Salon (client + `salonbook-server`), the root causes found, the fixes applied,
and how to verify/recover accounts. It contains **no credentials or secrets**.

---

## 1. Verified architecture

| Piece | Implementation |
| --- | --- |
| API | Express 5, routes under `/api/auth` |
| Database | MongoDB via Mongoose (`users` collection) |
| Passwords | `bcryptjs`, cost 12, stored as `passwordHash` (`select: false`) |
| Sessions | JWT (`HS256`, 7-day expiry) in `Authorization: Bearer <token>` |
| Client | React + Vite; token in `localStorage`; `AuthProvider` restores/validates it |
| Config | `salonbook-server/.env` (ignored), validated by `src/config/env.ts` |

Endpoints:

| Method | Path | Notes |
| --- | --- | --- |
| POST | `/api/auth/register` | 201 + token; 400 invalid input; 409 duplicate email |
| POST | `/api/auth/login` | 200 + token; 401 invalid credentials |
| GET | `/api/auth/me` | 200 current user; 401 token invalid/expired |
| POST | `/api/auth/logout` | 200 (clears the client session) |
| GET | `/api/auth/google/*` | Optional Google OAuth (disabled unless configured) |

---

## 2. Database health (read-only audit)

Audited with `scripts/audit-users.cjs` and `scripts/audit-email-normalization.cjs`:

- 15 user documents, **all** with a valid bcrypt hash (`$2b$…`, 60 chars).
- **0** documents missing or null `passwordHash`.
- **0** email-normalization anomalies (all `trim + lowercase`).
- Indexes: `email_1` unique, `googleId_1` unique **and sparse**.

Conclusion: registration, hashing and email normalization were already
functioning; the reported failures were not caused by corrupted hashes.

---

## 3. Root causes

1. **`409 Conflict` on sign-up**
   - Primary cause: the email already existed. The controller correctly returns
     `409` with “An account with this email already exists. Please sign in instead.”
   - Aggravating cause in the old client: the submit button only disabled after a
     React re-render, so a fast double-submit could send **two** registrations.
     The first created the account (201); the second returned 409 and its error
     could overwrite the successful state on screen.
   - **Fix:** a synchronous `useRef` submit lock on both auth forms.

2. **`401 Unauthorized` on login**
   - Primary cause: the submitted password did not match the hash stored for that
     account (e.g. an account created/altered during earlier debugging).
   - Aggravating cause in the old client: on app load `AuthProvider` validated any
     stored token via `GET /auth/me`. A **late 401 from that old request** (or the
     global `nf:unauthorized` event) could clear the session that a *successful*
     login had just created, making login look broken.
   - **Fix:** a `sessionGeneration` guard plus “only invalidate the exact token
     that produced the 401” in the API client.

3. **Inconsistent results between attempts**
   - Several stale `tsx watch` dev-server processes and an outdated production
     preview bundle were in play during earlier debugging.
   - **Fix:** current source is served by one listener; the client production
     bundle was rebuilt (`npm run build`).

4. **Server-side hardening that was uncommitted** (now committed):
   env validation (`MONGODB_URI`, `JWT_SECRET` ≥ 32 bytes, `CLIENT_URL`), CORS for
   localhost dev origins, auth rate limiting, async token validation with a user
   existence check, `passwordHash` hidden by default, sparse `googleId`, central
   error handling, Google OAuth flow.

---

## 4. Files changed

**Server** (`salonbook-server`)

- `src/config/env.ts` *(new)* — validated runtime configuration.
- `src/config/db.ts` — connect using validated URI.
- `src/index.ts` — `.env` path resolution, CORS, JSON limits, error handler.
- `src/controllers/authController.ts` — input validation, safe logging, 409/400
  handling, `passwordHash` checks, consistent formatting.
- `src/middleware/authMiddleware.ts` — HS256 verification, user existence check,
  roles.
- `src/models/User.ts` — `passwordHash` (`select: false`), `googleId` sparse,
  email/phone constraints.
- `src/routes/authRoutes.ts` — rate limiting + Google routes.
- `src/controllers/googleAuthController.ts` *(new)* — optional Google OAuth.
- `scripts/test-auth-flow.cjs` *(new)* — automated end-to-end auth test.
- `scripts/reset-password.cjs` *(new)* — safe password recovery tool.
- `.env.example`, `package.json` — documented variables, new scripts.

**Client**

- `src/services/api/client.ts` — per-request token tracking, race-safe 401.
- `src/services/api/auth.ts` — strict response parsing (`parseAuthUser`).
- `src/context/AuthProvider.tsx` — session generation, `sessionError`,
  `restoreSession`, Google sign-in.
- `src/context/authContext.ts` — extended context API.
- `src/pages/SignInPage.tsx`, `src/pages/SignUpPage.tsx` — validation parity,
  double-submit guards, Google button (hidden unless configured).
- `src/utils/authValidation.ts` *(new)* — shared field limits.
- `src/components/dashboard/*`, `src/index.css` — session/Google UI states.
- `src/services/config.ts` — `VITE_GOOGLE_CLIENT_ID`.

---

## 5. How to verify

Start the API (`salonbook-server`):

```bash
npm run dev          # http://localhost:5000
```

Run the automated authentication regression test:

```bash
npm run test:auth
```

It creates a throwaway account, then checks:

- register → 201 + JWT + normalized email
- login (case-different email) → 200 + JWT
- `GET /auth/me` → 200 same user
- duplicate registration → 409 with an explanatory message
- wrong password → 401
- logout → 200
- throwaway account deleted afterwards

Client checks:

```bash
cd client
npm run build
npm run lint
```

Manual browser check: `/signup` → create account → `/signin` with the same
credentials → dashboard loads → sign out.

---

## 6. Recovering an account that returns 401

If an existing account’s password is unknown (for example it was created during
debugging), reset it safely. The new password is never passed as an argument and
is never printed:

```bash
# hidden prompt
npm run reset-password -- user@example.com

# or via environment variable
RESET_PASSWORD='<new password>' npm run reset-password -- user@example.com

# or piped
echo '<new password>' | npm run reset-password -- user@example.com
```

Password rules: 8–72 bytes, at least one letter and one digit. The tool prints
only a masked email.

---

## 7. Security notes

- `.env` is git-ignored in both repos; only `.env.example` is committed.
- Passwords are bcrypt-hashed (cost 12) and never returned by any endpoint.
- `passwordHash`, `googleId` are `select: false`.
- JWT secret must be at least 32 bytes; tokens are HS256 and expire in 7 days.
- `401` clears the client session only for the token that caused it.
- Auth endpoints are rate-limited (10 failed attempts / 15 minutes).
- No credentials, JWT secrets or database URIs are hardcoded in source.
