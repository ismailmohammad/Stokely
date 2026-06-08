# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Stokely is a full-stack habit tracking app. Users register/login with session auth (password or passkey), then track "build" (positive) and "curb" (negative) habits with flexible daily recurrence. Containerized with Docker Compose.

**Stack:** React 18 + TypeScript + Vite (frontend) · Go + Gin (backend) · Supabase (PostgreSQL) + GORM · Session-based auth (gorilla/sessions via gin-contrib/sessions) · WebAuthn/passkeys (go-webauthn/webauthn)

## Commands

### Frontend (`stokely-frontend/`)
```bash
npm run dev       # Start Vite dev server (proxies /api → localhost:9090)
npm run lint      # ESLint (zero-warnings policy)
npm run test:run  # Run Vitest unit tests once
```
TypeScript is checked via `./node_modules/typescript/bin/tsc --noEmit` (note: `tsc` global not available in this WSL env).

### Backend (`backend/`)
```bash
go run .          # Start server on :9090 (requires PostgreSQL via DB_DSN)
go build ./...    # Compile check
go test ./...     # Run backend unit tests
go mod tidy       # Update dependencies after go.mod changes
```

### Docker (root)
```bash
docker compose up --build   # Build and start frontend + backend
docker compose down -v      # Stop and remove volumes
```

## Architecture

### Data Flow
Browser → nginx (port 80) → `/api/*` proxied to backend:9090 · static assets served directly from nginx.
In dev, Vite proxies `/api` to `localhost:9090` (see `vite.config.ts`).

### Secrets
Secrets are loaded via environment variables. Copy `.env.example` → `.env` (git-ignored) and fill in values. Docker Compose reads `.env` automatically for `${VAR}` substitution. **Never commit `.env`.**

Required env vars: `DB_DSN` (Supabase PostgreSQL URI), `SESSION_SECRET` (32+ char random string), `FRONTEND_ORIGIN`.

Optional passkey env vars: `WEBAUTHN_RPID` (effective domain, e.g. `localhost` or `stokely.quest`), `WEBAUTHN_ORIGINS` (comma-separated full origins). Leave both unset to disable passkeys.

### Backend (`backend/`)
Files:
- `main.go` — Gin setup, CORS, session store, route registration, `getEnv` helper, `initWebAuthn` call
- `models.go` — GORM models: `User`, `Habit`, `HabitLog`, `PushSubscription`, `StreakFreeze`, `UserSession`, `EmailToken`, `Passkey`. `AutoMigrate` runs on startup.
- `handlers.go` — All route handlers + `requireAuth`/`requireCSRF` middleware
- `passkeys.go` — WebAuthn passkey handlers: registration ceremony, login ceremony, list/rename/delete. `initWebAuthn()` configures the relying party from env vars.
- `scheduler.go` — Background job for push reminder delivery
- `email.go` — SMTP email helpers

**API routes** (all under `/api`):

Auth (unauthenticated unless noted):
- `POST /auth/register`, `POST /auth/login`, `POST /auth/logout` (auth+csrf)
- `GET /auth/me` (auth), `PUT /auth/password` (auth+csrf)
- `POST /auth/welcome-seen`, `PUT /auth/daily-spark` (auth+csrf)
- `POST /auth/email/verify`, `GET /auth/email/verify`, `DELETE /auth/email` (auth+csrf)
- `POST /auth/password/forgot`, `POST /auth/password/reset`
- `POST /auth/passkey/begin`, `POST /auth/passkey/finish` — **passkey login** (unauthenticated; WebAuthn challenge acts as CSRF)

Habits (all require auth):
- `GET/POST /habits`, `PUT/DELETE /habits/:id`
- `POST/DELETE /habits/:id/log`, `GET /habits/:id/streak`, `GET /habits/achievements`

Passkeys (all require auth except login endpoints above):
- `GET /passkeys` — list registered passkeys
- `POST /passkeys/register/begin` (csrf), `POST /passkeys/register/finish` (csrf) — registration ceremony
- `PUT /passkeys/:id` (csrf) — rename passkey
- `DELETE /passkeys/:id` (csrf) — remove passkey

Other authenticated groups: `/user`, `/e2ee`, `/sessions`, `/push`

Session stores `userID` and `sessionID` as strings in a gorilla/sessions cookie store.

### Frontend (`stokely-frontend/src/`)
- **`api/api.ts`** — Typed fetch wrapper. All calls use `credentials: 'include'` for cookie sessions. Includes `passkeys` group: `list`, `registerBegin`, `registerFinish`, `rename`, `delete`, `loginBegin`, `loginFinish`.
- **`types/habit.d.ts`** — `HabitType`, `UserInfo` (includes `hasPasskeys?: boolean`), `PasskeyInfo` interfaces.
- **`redux/store.ts`** — Single `user` slice storing `UserInfo | null`.
- **`utils/passkey.ts`** — WebAuthn browser helpers: `isWebAuthnAvailable()` (sync), `isPasskeySupported()` (async, uses `isUserVerifyingPlatformAuthenticatorAvailable`), `registerPasskey(name)`, `authenticateWithPasskey()`. Handles base64url ↔ ArrayBuffer conversion internally.
- **`components/Header.tsx`** — Reads Redux user state; shows Login/Register when logged out, Dashboard/Logout when logged in.
- **`components/Dashboard/Dashboard.tsx`** — Fetches habits from API on mount; calls `GET /auth/me` to rehydrate Redux user on page refresh. Shows passkey prompt modal after daily spark dismisses when `userInfo.hasPasskeys === false` and user hasn't dismissed it permanently (localStorage key `stokely_passkey_prompt_dismissed_v1_{userId}`).
- **`components/Dashboard/NewHabitModal.tsx`** — Handles both create and edit via `habitToEdit` prop.
- **`components/Dashboard/Habit.tsx`** — Clicking the cube toggles `complete`.
- **`components/SettingsModal.tsx`** — Includes passkey management section: list passkeys, add new (with label prompt), delete. Uses async `isPasskeySupported()` to conditionally show/hide the add form.
- **`components/UserActionPages/LoginPage.tsx`** — Standard password form plus "Sign in with a passkey" button (shown only when `isWebAuthnAvailable()` is true). `NotAllowedError` (user dismissed OS picker) is swallowed silently.

### Passkey Flow
**Registration** (settings or post-spark prompt):
1. `POST /api/passkeys/register/begin` → server returns `PublicKeyCredentialCreationOptions` with `residentKey: required` (creates a synced passkey, not a plain FIDO2 key)
2. Browser calls `navigator.credentials.create()` with decoded options
3. `POST /api/passkeys/register/finish?name=<label>` → server verifies and stores credential

**Authentication** (login page):
1. `POST /api/auth/passkey/begin` → server returns `PublicKeyCredentialRequestOptions`
2. Browser calls `navigator.credentials.get()` → OS shows passkey picker
3. `POST /api/auth/passkey/finish` → server looks up user via `userHandle`, verifies assertion, signs in

### Routing
React Router v6 with `createBrowserRouter`. Routes: `/`, `/dashboard`, `/login`, `/register`, `/forgot-password`, `/reset-password`, `/verify-email`. The dashboard redirects to `/login` if `GET /auth/me` returns 401.

### Containerization
- `backend/Dockerfile` — Multi-stage Go build → alpine runtime
- `stokely-frontend/Dockerfile` — Multi-stage Node build → nginx:alpine
- `stokely-frontend/nginx.conf` — Serves SPA with `try_files`, proxies `/api/` to `http://backend:9090/api/`
- `docker-compose.yml` — `backend` + `frontend` only (no local DB — Supabase is the external PostgreSQL host)

### Habit Model
`recurrence` is a dash-separated string of 2-letter day codes: `"Su-Mo-Tu-We-Th-Fr-Sa"` (Daily), `"Mo-Tu-We-Th-Fr"` (Weekdays), `"Su-Sa"` (Weekends), or any custom subset. `positiveType: true` = build habit (green cubes); `false` = curb habit (red cubes). `complete` is a user-toggled boolean (no automatic daily reset).

### Passkey Model
`Passkey` stores one registered WebAuthn credential per row: `UserID` (UUID FK), `CredentialData` (full `webauthn.Credential` JSON — includes public key, sign counter, transports), `Name` (user-supplied label, max 120 chars), `LastUsedAt` (updated after each successful authentication).

### Styling
Dark-first design (`#121212` background). Styled-components for layout components, plain CSS for card/form/modal details. All layouts are mobile-responsive with media queries at 480px and 720px breakpoints. `clamp()` used for fluid typography.
