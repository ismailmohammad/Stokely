<p align="center">
  <img src="stokely-frontend/src/assets/kindling/kindling-shield.png" alt="Kindling Shield mascot" width="220" />
</p>

<h1 align="center">Stokely</h1>

<p align="center" style="margin-top: 1.1rem;"><strong>Build your streaks. Stoke your momentum.</strong></p>

<p align="center">
  <a href="https://github.com/ismailmohammad/kuhabit/actions/workflows/prod-ci-cd.yml"><img src="https://github.com/ismailmohammad/kuhabit/actions/workflows/prod-ci-cd.yml/badge.svg?branch=main" alt="Prod CI/CD" /></a>
  <img src="https://img.shields.io/badge/Playwright-E2E%20Smoke-45BA63?logo=playwright&logoColor=white" alt="Playwright E2E" />
  <img src="https://img.shields.io/badge/Docker-Containerized-2496ED?logo=docker&logoColor=white" alt="Docker" />
  <img src="https://img.shields.io/badge/Go-1.25%2B-00ADD8?logo=go&logoColor=white" alt="Go 1.25+" />
  <img src="https://img.shields.io/badge/React%20%2B%20TypeScript-Frontend-3178C6?logo=react&logoColor=white" alt="React + TypeScript" />
</p>

Stokely is a full-stack habit tracker for building good habits and curbing bad ones, with optional account-wide end-to-end encryption (E2EE), streak mechanics, and device-level reminder notifications.

Live: [stokely.quest](https://stokely.quest)

This was mainly built to test the workflow with Codex/Claude to build an all around application incorporating testing, devops, and security practices to be further enhanced and developed on future projects but also serve as a personal tool as I found reminders on phones lacking in some areas despite some offering encryption and hope others may find some use in it too.

---

## Demo

### Product Walkthrough

<p align="center">
  <video src="https://github.com/user-attachments/assets/91a75004-a278-419f-86a8-c0ad4474aafa" width="700" controls></video>
</p>

### Onboarding and End-to-End Encryption Flow

<p align="center">
  <video src="https://github.com/user-attachments/assets/d7196e99-69bc-44f7-ba91-e0537958c8e4" width="700" controls></video>
</p>

---

## Screenshots

<p align="center">
  <img src="https://github.com/user-attachments/assets/d755eda6-18c0-4cf1-b26b-70421016caf7" width="700"/>
</p>

<p align="center">
  <img src="https://github.com/user-attachments/assets/b0fb9bd5-1d38-4616-bae2-f4e62827d27e" width="700"/>
</p>

<p align="center">
  <img src="https://github.com/user-attachments/assets/a0c6e7ae-276e-4bc5-8550-90d5df98a851" width="700"/>
</p>

<p align="center">
  <img src="https://github.com/ismailmohammad/Stokely/blob/main/stokely-frontend/src/assets/mockups.png" width="700"/>
</p>



## Current Feature Set

- Habit CRUD with recurrence schedules (`daily`, weekdays, weekends, custom day combos)
- Completion logging by date with streak calculations
- Streak freezes + achievements
- Optional push reminder notifications per device
- Account sessions management (list active sessions, revoke individual sessions, logout others)
- Email verification + password reset flows
- Optional Daily Spark toggle
- Passkey authentication (WebAuthn):
  - Register passkeys from Settings or via the post-spark prompt
  - Sign in with Face ID, Touch ID, Windows Hello, or hardware security keys — no password required
  - Passkeys are discoverable credentials (`residentKey: required`) so they sync via iCloud Keychain, Google Password Manager, or Windows Hello across devices
  - Per-passkey labels; multiple passkeys per account supported
  - Sign counter tracking and last-used timestamps per credential
- Optional account-wide E2EE:
  - passphrase-derived key (PBKDF2 + AES-GCM)
  - encrypted habit names/notes
  - vault lock/unlock behavior on client
  - passphrase change and disable flows

## Security & Privacy Posture (Current)

- Server-side session auth with CSRF protection on mutating requests
- Passkey / WebAuthn authentication — challenge-based, replay-safe; no CSRF token needed (origin validated by library)
- Session cookie hardening controls (`COOKIE_SECURE`, `COOKIE_SAMESITE`, host-only cookie support)
- Encrypted session payloads in production (`SESSION_ENCRYPTION_KEY`)
- Privacy minimization:
  - legacy raw session/push metadata scrubbed at startup
  - session persistence avoids storing raw IP/user-agent values
- SQL injection guard script included
- Automated security scans in test workflow (`gosec`, `govulncheck`, `npm audit`)

## Stack

| Layer | Technology |
|---|---|
| Frontend | React 18 + TypeScript + Vite |
| Styling | styled-components + CSS |
| Backend | Go + Gin + GORM |
| Auth | Cookie-backed sessions |
| Database | PostgreSQL (Supabase-compatible) |
| Push | Web Push (VAPID) + service worker |
| Reverse proxy / TLS | Caddy |
| Containers | Docker / Docker Compose |

## Architecture

```text
Browser
  └── Caddy (TLS + routing)
        └── Frontend container (Vite/nginx build output)
              └── /api/* -> Go backend
                            └── PostgreSQL
```

In local frontend development, Vite proxies `/api` to the backend.

---

## Local Development

### Prerequisites

- Node.js 20+
- npm
- Go 1.25+
- PostgreSQL (or Supabase project)

### Setup

1. Copy `.env.example` to `.env` and fill values.
2. Start backend:

```bash
cd backend
go run .
```

3. Start frontend:

```bash
cd stokely-frontend
npm install
npm run dev
```

Frontend defaults to `http://localhost:5173`, backend to `http://localhost:9090`.

---

## Testing & Quality Gates

### Backend

```bash
cd backend
go test ./...
```

```bash
./scripts/check-sql-injection-guard.sh
```

```bash
cd backend
$(go env GOPATH)/bin/gosec ./...
$(go env GOPATH)/bin/govulncheck ./...
```

### Frontend

```bash
cd stokely-frontend
npm run build
npm run test:run
```

### End-to-End (Playwright)

```bash
cd stokely-frontend
npm run test:e2e
```

### Dependency Audit

```bash
cd stokely-frontend
npm audit --omit=dev
```

---

## Deployment

This is due to current VM resource limits. With enough RAM/CPU, you can also build directly on the VM or via CI.

Build and push images:

```bash
./deploy.sh
```

Run production compose on server:

```bash
docker compose -f docker-compose.prod.yml pull
docker compose -f docker-compose.prod.yml up -d
```

## GitHub Actions Prod Deploy (main branch)

Workflow: `.github/workflows/prod-ci-cd.yml`

On every commit to `main`, it will:

1. Run backend tests.
2. Run frontend unit tests + build + Playwright smoke tests.
3. Run SQL injection guard + `npm audit --omit=dev`.
4. Build/push Docker images to Docker Hub.
5. SSH into your VM and run `docker compose pull && docker compose up -d`.

### Required GitHub Repository Secrets

| Secret | Purpose |
|---|---|
| `DOCKERHUB_USERNAME` | Docker Hub username used for image tags/login |
| `DOCKERHUB_TOKEN` | Docker Hub access token (write permissions) |
| `PROD_SSH_PRIVATE_KEY` | Private key used by GitHub Actions to SSH into VM |
| `PROD_SSH_KNOWN_HOSTS` | Host key line(s) from `ssh-keyscan -H <host>` |
| `PROD_SSH_HOST` | Production VM hostname/IP |
| `PROD_SSH_USER` | SSH user (for example `ubuntu`) |
| `PROD_SSH_PORT` | SSH port (optional, defaults to 22 if blank) |
| `PROD_DEPLOY_PATH` | Path to repo on VM (for example `~/kuhabit`) |

### VM Prerequisites

- Repo exists at `PROD_DEPLOY_PATH` and has `docker-compose.prod.yml`.
- Docker + Docker Compose plugin installed.
- `.env` file configured on VM with production values.
- VM can pull images from Docker Hub.
- SSH user has permission to run Docker commands.

---

## Environment Variables

See `.env.example` for the complete list.

### Required

| Variable | Description |
|---|---|
| `DB_DSN` | PostgreSQL connection string |
| `SESSION_SECRET` | 32+ char session signing secret |
| `SESSION_ENCRYPTION_KEY` | Base64 key (16/24/32 byte decoded); required when `GIN_MODE=release` |
| `FRONTEND_ORIGIN` | Allowed frontend origin |
| `COOKIE_SECURE` | `true` in production |

### Session/Cookie Hardening

| Variable | Description |
|---|---|
| `COOKIE_DOMAIN` | Optional cookie domain (leave empty for host-only) |
| `COOKIE_SAMESITE` | `lax` / `strict` / `none` |

### Push Notifications (Optional)

| Variable | Description |
|---|---|
| `VAPID_PUBLIC_KEY` | Public VAPID key |
| `VAPID_PRIVATE_KEY` | Private VAPID key |
| `VAPID_EMAIL` | Contact email / subscriber subject |

### Passkeys / WebAuthn (Optional)

Leave both unset to disable passkey registration and login entirely.

| Variable | Description |
|---|---|
| `WEBAUTHN_RPID` | Effective domain only — no scheme, no port. Dev: `localhost`. Prod: `stokely.quest` |
| `WEBAUTHN_ORIGINS` | Comma-separated full origins. Dev: `http://localhost:5173`. Prod: `https://stokely.quest` |

---

## Notes

- E2EE passphrases are not recoverable by the server.
- If data was encrypted with an old/unknown key layer, it may not be recoverable.
- Privacy Policy is available in-app from the landing page.
