# Design: Engram production deployment + hardening via Dokploy CI/CD

_Date: 2026-06-27 · Repo: `github.com/caisergan/engram` · Working branch: `feat/social-sync`_

## 1. Goal

Stand up Engram for the first time on the user's Google VM as a **hardened, HTTPS, self-hosted
production deployment** that the user's Mac, iPhone, browser extension, and hourly social-sync cron
can all reach. This is the first item ("server hardening") in the broader
`ENGRAM_SAVE_SYSTEM_REPORT.md` roadmap and unblocks every client-side workflow.

"Hardening" here means: trusted TLS, a correct public URL, strong secrets, production database
settings, locked signups, internal-only sidecars, and a reproducible CI/CD pipeline — rather than
patching an already-running stack (nothing is deployed yet).

## 2. Established facts & constraints

- **Nothing is deployed yet** — Engram currently runs only locally on the Mac. This is a clean
  first deployment.
- **VM:** Google VM, 16 GB RAM, **shared with other projects**. Build load must stay off the VM →
  build in CI.
- **Dokploy is already installed and running** on the VM, with its **Traefik** proxy owning ports
  80/443 and managing Let's Encrypt for the other projects. Engram becomes a new Dokploy app.
  Therefore **we do not add Caddy or any other reverse proxy** — Traefik/Dokploy owns TLS + domains.
- **Domain available:** the user owns a domain and can add an `A` record to the VM's public IP.
  Enables fully-trusted Let's Encrypt HTTPS (required for the iPhone, which rejects self-signed certs).
- **Engram is a fork** with custom social-sync code → the public Karakeep images cannot be used; the
  AIO image must be built from this repo's source (`docker/Dockerfile`, target `aio`).
- **Registry:** GitHub Container Registry, `ghcr.io/caisergan/engram`.
- **Stack:** `web` = all-in-one container (Next.js + workers + SQLite via s6-overlay); `chrome` and
  `meilisearch` sidecars (internal only). Queue is in-process liteque (no Redis). Persistent state:
  SQLite + assets under `/data`, and the Meilisearch index under `/meili_data`.
- **Division of labor:** the assistant produces repo artifacts and a runbook; the user performs the
  VM/Dokploy/DNS/GitHub-settings actions (the assistant cannot reach the VM or the Dokploy UI) with
  step-by-step guidance.

## 3. Chosen approach

**Approach A — CI builds → GHCR → Dokploy Compose pulls.** (Selected over: B, Dokploy builds from
git on the VM — rejected because it loads the shared VM and doesn't cleanly cover the sidecars; and
C, separate Dokploy app per service — rejected as more moving parts than one declarative Compose.)

GitHub Actions builds the `linux/amd64` AIO image and pushes it to GHCR. A Dokploy **Compose** app
runs `web` (the GHCR image) + `chrome` + `meilisearch`. Domain + TLS are attached via Dokploy/Traefik.
After each push, CI calls Dokploy's deploy webhook to pull the new image and redeploy.

## 4. Architecture & data flow

```
git push (main / manual dispatch)
   │
   ▼
GitHub Actions ──build linux/amd64 AIO image──▶ ghcr.io/caisergan/engram:{sha,latest}
   │                                                   │ (private; Dokploy pulls via registry cred)
   └──── curl Dokploy deploy webhook ────┐             │
                                         ▼             │
                                 Dokploy (on VM) ──────┘ runs Compose:
                                         │
                                         ▼
              ┌──────────────── dokploy-network ────────────────┐
  Traefik ◀───┤  web (AIO: next + workers + sqlite, port 3000)  │
  (80/443,    │  chrome      (internal, no host port)           │
   LE certs)  │  meilisearch (internal, no host port)           │
      ▲       └─────────────────────────────────────────────────┘
      │ A record
engram.<domain> ◀── iPhone / Mac / browser extension / social-sync cron
```

The `web` container is unchanged from the existing AIO image. Only Traefik is exposed publicly.

## 5. Repo artifacts (assistant-owned)

| File | Purpose |
|---|---|
| `docker/docker-compose.dokploy.yml` | Dokploy stack. `web` uses `image: ghcr.io/caisergan/engram:latest` (no `build:`), joins the external `dokploy-network`, **no host port mapping**. `chrome` + `meilisearch` as in the existing compose, internal only. Named volumes `data` + `meilisearch`. |
| `.github/workflows/deploy.yml` | Build AIO image via `docker/build-push-action` (buildx, `linux/amd64`, GHA layer cache), push `:latest` + `:sha-<short>` to GHCR, then `curl` the Dokploy deploy webhook. Triggers: push to `main`, `workflow_dispatch`. Permissions: `packages: write` (uses `GITHUB_TOKEN`). |
| `docker/.env.example` | Documents every required env var with placeholders and the `openssl` commands to generate secrets. No real secrets committed. |
| `docs/deployment/dokploy-runbook.md` | Step-by-step VM/Dokploy/DNS/GitHub runbook (Section 7). |

The existing `docker/docker-compose.yml` (local-build) is left untouched for local use; the Dokploy
compose is a separate file so the two configurations don't conflict.

## 6. Production config & hardening

Environment variables set in **Dokploy's UI** (encrypted at rest, never committed):

| Var | Value | Why |
|---|---|---|
| `NEXTAUTH_URL` | `https://engram.<domain>` | Public base URL for all clients; resolves `publicApiUrl`. Without it, generated links point at localhost. |
| `NEXTAUTH_SECRET` | `openssl rand -base64 36` | Session / JWT signing secret. |
| `MEILI_MASTER_KEY` | `openssl rand -base64 36` | Meilisearch v1.41 requires a master key in production. |
| `DB_WAL_MODE` | `true` | SQLite WAL — concurrency for web + workers on one DB file. |
| `DISABLE_SIGNUPS` | `false`, then `true` | Open only long enough to create the first account, then lock the server. |
| `MEILI_ADDR` | `http://meilisearch:7700` | Internal; already in compose. |
| `BROWSER_WEB_URL` | `http://chrome:9222` | Internal; already in compose. |
| `DATA_DIR` | `/data` | Persistent storage root; already in compose. |
| `OPENAI_API_KEY` | optional | Enables AI auto-tagging/summary if desired. |

Structural hardening:
- `chrome` and `meilisearch` expose **no host ports** — reachable only on the internal Docker network.
- `web` is reachable **only through Traefik** (no `:3030` host mapping in the Dokploy compose).
- `restart: unless-stopped` on all services.
- **Named volumes** `data` → `/data` and `meilisearch` → `/meili_data` so redeploys never wipe data
  (proven in verification, Section 8 step 5).
- Plain HTTP redirects to HTTPS (Traefik default once HTTPS is enabled).

## 7. Manual VM/Dokploy/DNS steps (user-run, assistant-guided)

The runbook documents these precisely:
1. **DNS:** add `A` record `engram.<domain>` → VM public IP.
2. **Dokploy:** create a **Compose** app from `docker/docker-compose.dokploy.yml`.
3. **Dokploy → Registry:** add a GHCR read credential (GitHub username + PAT with `read:packages`)
   so Dokploy can pull the private image.
4. **Dokploy → Environment:** enter the env vars from Section 6.
5. **Dokploy → Domains:** attach `engram.<domain>` to the `web` service on port `3000`, enable
   HTTPS (Let's Encrypt). _Confirm the exact Compose-domain mechanism against the installed Dokploy
   version rather than relying on hardcoded Traefik labels — see Section 9._
6. **GitHub:** add repo secret `DOKPLOY_DEPLOY_WEBHOOK` (the per-app deploy webhook URL from Dokploy).
7. **First deploy** → create the account → set `DISABLE_SIGNUPS=true` → redeploy.

## 8. Verification

1. `https://engram.<domain>` loads with a valid Let's Encrypt cert (browser + `curl -I`).
2. Plain `http://` redirects to `https://`; the raw `:3030` is not reachable externally.
3. Create account → save a test bookmark → it crawls/enriches (workers alive).
4. Connect Instagram social sync → a run completes (full stack wired end-to-end).
5. **Redeploy test:** re-trigger CI → new image deploys → existing bookmarks persist (volume durability).
6. `DISABLE_SIGNUPS=true` confirmed — the signup page is blocked.

## 9. Decisions & known risks

- **Private GHCR image + Dokploy pull credential** (chosen) over a public image, to avoid exposing the
  fork's compiled code. Cost: one registry credential configured once in Dokploy.
- **Deploy `feat/social-sync` now via `workflow_dispatch`**, while making `main` the production branch;
  merge social-sync into `main` when ready, after which pushes to `main` auto-deploy.
- **Dokploy Compose domain/label mechanism varies by version.** Risk mitigated by confirming the
  domain step against the installed version in the runbook instead of hardcoding Traefik labels that
  could be wrong.
- **GHCR pull PAT** is a long-lived credential in Dokploy; scope it to `read:packages` only.
- **Cookie/secret rotation, backups, and observability** are acknowledged but out of scope for this
  spec (see Section 10).

## 10. Out of scope (future work)

- Automated volume/database backups (the app has a `BackupQueue`; Dokploy also offers volume backups).
- Social-sync provider work (X / YouTube / Reddit) and cookie-expiry notifications — separate roadmap items.
- Mac `Cmd+Shift+D` shortcut and iOS Back Tap wiring — separate roadmap items.
- Staging environment / blue-green deploys.
