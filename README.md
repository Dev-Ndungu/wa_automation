# WhatsApp Group Control

A self-hosted, privacy-conscious administration dashboard for a WhatsApp account that you legitimately control. The system discovers WhatsApp group invite links posted in groups, lets an administrator explicitly confirm joining one selected invite at a time, and forwards a specifically selected existing message to an explicit group allowlist. It does not automatically join groups, message individuals, collect group members, or use evasion features.

> Baileys is an unofficial WhatsApp Web library and is not affiliated with, endorsed by, or supported by WhatsApp. Ensure your use complies with WhatsApp's terms and with applicable law.

## Current status

The dashboard, SQLite/Drizzle data layer, multi-account management, WhatsApp
QR linking with local session backup/restore, group synchronization, invite-link
scanning, manual group joining, and the persistent campaign sender are all
implemented and run locally. Pacing and safety caps are built in and cannot be
configured away (see "Account safety" below).

## Account safety

WhatsApp restricts numbers that look automated. This project takes the
following fixed, non-configurable precautions:

- The connection uses a stock, unbranded browser profile (Safari on macOS), not
  a custom client identity.
- Presence is never marked online, and full chat history is never synced.
- Sends are paced with random gaps (60s–4min), random campaign warm-up, a quiet
  window after every reconnect, and a hard cap of 50 messages per account per
  day. Reaching the cap pauses the campaign for the rest of the day; it resumes
  itself once the cap resets at UTC midnight and the 06:00 EAT send window is
  open again, so no operator action is needed for a new day.
- Group joins are limited to 2 per 3 hours and 3 per day, and only ever happen
  when an administrator presses Join on a saved link. The scanner never joins
  groups automatically.
- Every group gets a random 18–48h cooldown, and freshly joined groups get a
  120–360 minute grace period before their first campaign message.
- Failed connection attempts back off on a widening ladder and stop entirely;
  a refused (403) session never reconnects automatically.

These measures reduce, but cannot eliminate, restriction risk. A new or
previously restricted number should be used normally on the phone for a while
before any campaign is run.

## Repository structure

```text
apps/
  api/                 Fastify API, auth, database, later WhatsApp coordination
  web/                 React + Vite + Tailwind administrator dashboard
  worker/              Reserved for the persistent forwarding worker (Phase 9)
packages/              Shared types and future infrastructure adapters
data/                  Local SQLite database (ignored by Git)
whatsapp-auth/         Local Baileys credentials (ignored by Git)
```

## Application architecture

```text
Admin browser → React dashboard → Fastify API → SQLite through Drizzle
                                         ├─ WhatsApp connection + group synchronizer
                                         ├─ group-only invite-link scanner
                                         └─ persistent sequential campaign worker
```

The scanner and sender are separate services. The future sender will only act after an administrator selects target groups from an allowlist and explicitly starts a campaign. Docker/Caddy deployment is deliberately scheduled for Phase 11; local development uses two local processes and does not need Docker.

## Database schema

The initialized SQLite schema includes:

- `admin_users`, `sessions`, `app_settings` for dashboard access and configuration.
- `groups` for group identity, scanner/target/exclusion flags, and cooldown timestamp only.
- `discovered_links`, `link_occurrences` for normalized group-invite URLs and their lightweight sightings.
- `source_messages`, `campaigns`, `campaign_targets` for selected campaign sources and persistent, duplicate-protected sending state.
- `operational_logs` for privacy-safe operational events.

No group membership, profile data, complete conversation history, or private-chat messages is stored.

## Environment variables

Copy `.env.example` to `.env`. The first local dashboard visit asks you to create your own administrator email and password; no default administrator exists.

| Variable | Purpose |
| --- | --- |
| `PORT` | API port; defaults to `3001`. |
| `WEB_ORIGIN` | Local dashboard origin; defaults to `http://localhost:5173`. |
| `DATABASE_PATH` | Local SQLite file path. |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | Optional local override; both are required in production to seed the first administrator. The password is hashed with Argon2id. |
| `SESSION_TTL_HOURS` | Admin session lifetime. |
| `COOKIE_SECURE` | Keep `false` for local HTTP; set `true` behind HTTPS in production. |
| `WHATSAPP_AUTH_DIR` | Reserved private directory for Baileys credentials. |

## Run locally on this PC

You need Node.js 22+ and an internet connection only when installing the packages. Once installed, the dashboard and SQLite database run locally; later WhatsApp functionality will naturally require internet access.

```powershell
npm install
.\start-local.ps1
```
#run this command to start the server and web frontend 
powershell -ExecutionPolicy Bypass -File .\start-local.ps1

Then open `http://localhost:5173`. Sign in with the credentials in `.env`. The API health check is `http://127.0.0.1:3001/health`.

For a production installation, do not use the development server: the later Docker/Caddy phase will provide HTTPS, persistent volumes, health checks, and restart policies.

## Phase 1 implementation plan

1. Create the workspace, environment template, ignored local data directories, and scripts.
2. Add a database layer that is portable from SQLite to PostgreSQL through Drizzle.
3. Seed one Argon2id-hashed administrator from protected environment settings.
4. Implement login rate limiting, signed-in HTTP-only cookies, CSRF validation for authenticated mutations, origin checks, and Pino redaction.
5. Run type checks, production builds, and an API health/login verification locally.

## Delivery roadmap

The subsequent phases follow the requested order: Baileys linking/reconnect, group sync, group-only listener, URL extraction/deduplication, links UI, source-message forwarding, allowlist UI, persistent campaign worker, controls, Docker/Caddy, then a security review and production tests.

## Backups

Back up the SQLite database and non-secret configuration only. Do not place `whatsapp-auth/` in ordinary backups. If authentication state must be backed up later, it will be encrypted and documented separately.
