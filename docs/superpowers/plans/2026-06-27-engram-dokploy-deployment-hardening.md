# Engram Dokploy Deployment + Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the repo artifacts (Dokploy Compose file, GHCR build/deploy CI workflow, env template, and a deployment runbook) that let the user's Google VM run Engram as a hardened, HTTPS, self-hosted production deployment.

**Architecture:** GitHub Actions builds the all-in-one (`aio`) image for `linux/amd64` and pushes it to `ghcr.io/caisergan/engram`. A Dokploy **Compose** app pulls that image and runs `web` + `chrome` + `meilisearch`; Dokploy's Traefik terminates TLS (Let's Encrypt) and routes the domain to `web:3000`. After each push, CI calls Dokploy's deploy webhook to redeploy.

**Tech Stack:** Docker Compose, GitHub Actions (buildx), GitHub Container Registry (GHCR), Dokploy + Traefik, the existing `docker/Dockerfile` `aio` target (Next.js + workers + SQLite under s6-overlay).

**Spec:** `docs/superpowers/specs/2026-06-27-engram-dokploy-deployment-hardening-design.md`

> **Note on "tests":** These artifacts are infrastructure config (YAML/CI/docs), not application code, so there are no unit tests. The objective check for each artifact is a **lint / dry-run validation** (`docker compose config`, YAML parse). True end-to-end verification happens when the user executes the runbook on the VM — that checklist is Task 5 and mirrors spec §8. All validation commands below run locally on the user's Mac (which has Docker + Python).

---

## File Structure

| File | Responsibility |
|---|---|
| `docker/docker-compose.dokploy.yml` | Declarative production stack for Dokploy: `web` (GHCR image, no host ports, joined to `dokploy-network`), `chrome` + `meilisearch` (internal). |
| `docker/.env.example` | Documents every required env var with placeholders + secret-generation commands. No real secrets. |
| `.github/workflows/deploy.yml` | Build `aio` → push to GHCR → trigger Dokploy webhook. Triggers: push to `main` + manual dispatch. |
| `.github/workflows/docker.yml` | (Modify) Guard upstream Karakeep build jobs so they don't run — and fail — on this fork. |
| `docs/deployment/dokploy-runbook.md` | The user-run VM/Dokploy/DNS/GitHub steps + the end-to-end verification checklist. |

---

## Task 1: Dokploy Compose stack

**Files:**
- Create: `docker/docker-compose.dokploy.yml`

- [ ] **Step 1: Write the Compose file**

```yaml
# Dokploy production stack for Engram.
# The `web` image is built in CI (.github/workflows/deploy.yml) and pulled from GHCR.
# Traefik (managed by Dokploy) terminates TLS and routes the public domain to web:3000,
# so NO host ports are published here. chrome + meilisearch stay internal.
#
# Secrets/config (NEXTAUTH_URL, NEXTAUTH_SECRET, MEILI_MASTER_KEY, ...) are provided by
# Dokploy's Environment tab and interpolated into ${VARS} below. See docker/.env.example.
services:
  web:
    image: ghcr.io/caisergan/engram:latest
    restart: unless-stopped
    volumes:
      - data:/data
    environment:
      NEXTAUTH_URL: ${NEXTAUTH_URL}
      NEXTAUTH_SECRET: ${NEXTAUTH_SECRET}
      MEILI_ADDR: http://meilisearch:7700
      MEILI_MASTER_KEY: ${MEILI_MASTER_KEY}
      BROWSER_WEB_URL: http://chrome:9222
      DATA_DIR: /data
      DB_WAL_MODE: ${DB_WAL_MODE:-true}
      DISABLE_SIGNUPS: ${DISABLE_SIGNUPS:-true}
      OPENAI_API_KEY: ${OPENAI_API_KEY:-}
    networks:
      - default
      - dokploy-network
    # Preferred: attach the domain via the Dokploy UI (Domains tab → service `web`, port 3000).
    # Fallback ONLY if your Dokploy version needs manual Traefik labels for Compose domains —
    # uncomment and replace engram.YOURDOMAIN:
    # labels:
    #   - traefik.enable=true
    #   - traefik.http.routers.engram.rule=Host(`engram.YOURDOMAIN`)
    #   - traefik.http.routers.engram.entrypoints=websecure
    #   - traefik.http.routers.engram.tls.certresolver=letsencrypt
    #   - traefik.http.services.engram.loadbalancer.server.port=3000
  chrome:
    image: gcr.io/zenika-hub/alpine-chrome:124
    restart: unless-stopped
    command:
      - --no-sandbox
      - --disable-gpu
      - --disable-dev-shm-usage
      - --remote-debugging-address=0.0.0.0
      - --remote-debugging-port=9222
      - --hide-scrollbars
    networks:
      - default
  meilisearch:
    image: getmeili/meilisearch:v1.41.0
    restart: unless-stopped
    environment:
      MEILI_NO_ANALYTICS: "true"
      MEILI_ENV: production
      MEILI_MASTER_KEY: ${MEILI_MASTER_KEY}
    volumes:
      - meilisearch:/meili_data
    networks:
      - default

volumes:
  meilisearch:
  data:

networks:
  default:
  dokploy-network:
    external: true
```

- [ ] **Step 2: Validate the Compose file renders**

Run:
```bash
NEXTAUTH_URL=https://x NEXTAUTH_SECRET=x MEILI_MASTER_KEY=x \
  docker compose -f docker/docker-compose.dokploy.yml config >/dev/null && echo OK
```
Expected: prints `OK` with no errors. (A warning that `dokploy-network` is external is fine; it exists on the VM, not locally.)

- [ ] **Step 3: Confirm no host ports and no `build:` are present**

Run:
```bash
grep -nE "ports:|build:" docker/docker-compose.dokploy.yml || echo "none (correct)"
```
Expected: `none (correct)` — the web service must be reachable only via Traefik, and the image comes from GHCR, not a local build.

- [ ] **Step 4: Commit**

```bash
git add docker/docker-compose.dokploy.yml
git commit -m "feat(deploy): Dokploy production Compose stack for Engram"
```

---

## Task 2: Production env template

**Files:**
- Create: `docker/.env.example`

- [ ] **Step 1: Write the env template**

```bash
# ─── Engram production environment (Dokploy) ───────────────────────────────
# Set these in the Dokploy app's "Environment" tab. Do NOT commit real values.
# Generate the two secrets with:  openssl rand -base64 36

# Public HTTPS URL Traefik serves. MUST match the domain you attach in Dokploy.
# Used as the base URL for all clients (mobile, extension, API).
NEXTAUTH_URL=https://engram.YOURDOMAIN

# Auth/session signing secret. Generate: openssl rand -base64 36
NEXTAUTH_SECRET=replace-me

# Meilisearch master key, shared by the web and meilisearch services.
# Generate: openssl rand -base64 36
MEILI_MASTER_KEY=replace-me

# SQLite WAL mode — recommended ON for concurrent web + workers on one DB file.
DB_WAL_MODE=true

# Keep "false" ONLY long enough to create your first account through the web UI,
# then set to "true" and redeploy to lock the server.
DISABLE_SIGNUPS=false

# Optional: enables AI auto-tagging / summaries. Leave blank to disable.
OPENAI_API_KEY=
```

- [ ] **Step 2: Confirm no real secrets were committed by mistake**

Run:
```bash
grep -nE "replace-me|YOURDOMAIN" docker/.env.example && echo "placeholders present (correct)"
```
Expected: shows the placeholder lines and prints `placeholders present (correct)`.

- [ ] **Step 3: Commit**

```bash
git add docker/.env.example
git commit -m "docs(deploy): document production env vars for Dokploy"
```

---

## Task 3: CI build + push + deploy workflow

**Files:**
- Create: `.github/workflows/deploy.yml`

- [ ] **Step 1: Write the workflow**

```yaml
name: Deploy Engram (AIO → GHCR → Dokploy)

on:
  push:
    branches:
      - main
  workflow_dispatch:

concurrency:
  group: deploy-${{ github.ref }}
  cancel-in-progress: true

jobs:
  build-and-deploy:
    runs-on: ubuntu-latest
    permissions:
      packages: write
      contents: read
    steps:
      - uses: actions/checkout@v4
        with:
          persist-credentials: false

      - name: Set up Docker Buildx
        uses: docker/setup-buildx-action@v3

      - name: Log in to GHCR
        uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - name: Compute short SHA
        id: vars
        run: echo "sha=${GITHUB_SHA::7}" >> "$GITHUB_OUTPUT"

      - name: Build & push AIO image
        uses: docker/build-push-action@v6
        with:
          context: .
          file: docker/Dockerfile
          target: aio
          platforms: linux/amd64
          push: true
          build-args: SERVER_VERSION=${{ steps.vars.outputs.sha }}
          tags: |
            ghcr.io/caisergan/engram:latest
            ghcr.io/caisergan/engram:sha-${{ steps.vars.outputs.sha }}
          cache-from: type=gha
          cache-to: type=gha,mode=max

      - name: Trigger Dokploy redeploy
        env:
          DEPLOY_HOOK: ${{ secrets.DOKPLOY_DEPLOY_WEBHOOK }}
        run: |
          if [ -z "$DEPLOY_HOOK" ]; then
            echo "DOKPLOY_DEPLOY_WEBHOOK not set — skipping redeploy trigger."
            exit 0
          fi
          curl -fsSL -X POST "$DEPLOY_HOOK"
          echo "Triggered Dokploy redeploy."
```

- [ ] **Step 2: Validate the workflow is well-formed YAML**

Run:
```bash
python3 -c "import yaml; yaml.safe_load(open('.github/workflows/deploy.yml')); print('valid yaml')"
```
Expected: prints `valid yaml`.

- [ ] **Step 3: Sanity-check the image name is lowercase and the target exists**

Run:
```bash
grep -n "ghcr.io/caisergan/engram" .github/workflows/deploy.yml && \
grep -nE "^FROM aio_builder AS aio" docker/Dockerfile && echo "target+name OK"
```
Expected: shows the GHCR tags, the `FROM aio_builder AS aio` line, and `target+name OK`. (GHCR requires lowercase names; `caisergan/engram` is already lowercase.)

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/deploy.yml
git commit -m "ci(deploy): build AIO to GHCR and trigger Dokploy redeploy"
```

---

## Task 4: Stop the upstream `docker.yml` from running on this fork

The upstream workflow `.github/workflows/docker.yml` triggers on push to `main` and on releases, builds 5 images × 2 arches, and pushes to `ghcr.io/hoarder-app/*` + `ghcr.io/karakeep-app/*` using `secrets.GHCR_GITHUB_PAT`. On this fork it has neither push access to those orgs nor that secret, so every push to `main` would produce failing runs. Guard both jobs so they no-op here while leaving the file intact for upstream merges.

**Files:**
- Modify: `.github/workflows/docker.yml` (the `build` job at line ~11 and the `manifest` job at line ~113)

- [ ] **Step 1: Add a repository guard to the `build` job**

Find:
```yaml
jobs:
  build:
    strategy:
```
Replace with:
```yaml
jobs:
  build:
    # Upstream-only: skip on forks (this fork uses .github/workflows/deploy.yml instead).
    if: ${{ github.repository == 'karakeep-app/karakeep' }}
    strategy:
```

- [ ] **Step 2: Add the same guard to the `manifest` job**

Find:
```yaml
  manifest:
    needs: build
    runs-on: ubuntu-latest
```
Replace with:
```yaml
  manifest:
    needs: build
    if: ${{ github.repository == 'karakeep-app/karakeep' }}
    runs-on: ubuntu-latest
```

- [ ] **Step 3: Validate YAML still parses**

Run:
```bash
python3 -c "import yaml; yaml.safe_load(open('.github/workflows/docker.yml')); print('valid yaml')"
```
Expected: prints `valid yaml`.

- [ ] **Step 4: Confirm both guards are present**

Run:
```bash
grep -c "github.repository == 'karakeep-app/karakeep'" .github/workflows/docker.yml
```
Expected: `2`.

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/docker.yml
git commit -m "ci: skip upstream Karakeep docker build on this fork"
```

---

## Task 5: Deployment runbook (the user-run steps + verification)

This documents everything the user performs on the VM, in Dokploy, in DNS, and in GitHub — the actions the assistant cannot do remotely — plus the end-to-end verification checklist from spec §8.

**Files:**
- Create: `docs/deployment/dokploy-runbook.md`

- [ ] **Step 1: Write the runbook**

````markdown
# Engram — Dokploy deployment runbook

This is the manual, one-time setup to bring Engram live on the Google VM. The repo already
contains `docker/docker-compose.dokploy.yml`, `docker/.env.example`, and the CI workflow
`.github/workflows/deploy.yml`. You perform the steps below; everything is reversible.

Prereqs: Dokploy already running on the VM (Traefik owns 80/443), you own a domain, and the
repo is `github.com/caisergan/engram`.

## 1. Generate secrets (on your Mac)

```bash
openssl rand -base64 36   # use as NEXTAUTH_SECRET
openssl rand -base64 36   # use as MEILI_MASTER_KEY
```
Keep both handy for step 5.

## 2. DNS

In your domain's DNS, add an **A record**:
- Host: `engram` (i.e. `engram.YOURDOMAIN`)
- Value: the VM's public IP
- TTL: default

Verify it resolves before continuing:
```bash
dig +short engram.YOURDOMAIN
```
Expected: the VM's public IP.

## 3. GitHub: let CI push to GHCR

The workflow uses the built-in `GITHUB_TOKEN`, so no PAT is needed to push. Just run the
pipeline once so the package exists:
- GitHub → repo → **Actions** → "Deploy Engram (AIO → GHCR → Dokploy)" → **Run workflow**
  → choose branch `feat/social-sync` (until it's merged to `main`) → Run.
- Wait for it to finish. The `Trigger Dokploy redeploy` step will print "skipping" — expected,
  because you haven't set the webhook yet (step 6).
- Confirm the package appears at GitHub → your profile → **Packages** → `engram`.

## 4. Dokploy: create the app + registry credential

1. In Dokploy, create a **Registry** credential for GHCR:
   - Registry URL: `ghcr.io`
   - Username: `caisergan`
   - Password: a GitHub **PAT (classic)** with scope `read:packages`
     (GitHub → Settings → Developer settings → Personal access tokens).
2. Create a new **Compose** application (e.g. project "engram").
3. Point it at this repo (`github.com/caisergan/engram`) and the compose path
   `docker/docker-compose.dokploy.yml`, or paste that file's contents. Select the registry
   credential from step 1 so it can pull the private image.

## 5. Dokploy: environment variables

In the app's **Environment** tab, add (values from `docker/.env.example`):

```
NEXTAUTH_URL=https://engram.YOURDOMAIN
NEXTAUTH_SECRET=<from step 1>
MEILI_MASTER_KEY=<from step 1>
DB_WAL_MODE=true
DISABLE_SIGNUPS=false
```
(Optional: `OPENAI_API_KEY=...` for AI tagging.)

## 6. Dokploy: domain + TLS, then deploy

1. In the app's **Domains** tab, add `engram.YOURDOMAIN` → service `web`, container port
   `3000`, and enable **HTTPS (Let's Encrypt)**.
   - If your Dokploy version doesn't expose a Compose "Domains" form, instead uncomment the
     Traefik `labels:` block in `docker/docker-compose.dokploy.yml`, set `engram.YOURDOMAIN`,
     commit, and redeploy.
2. Copy the app's **deploy webhook URL** (Dokploy app → Deployments/Webhook).
3. In GitHub → repo → Settings → **Secrets and variables → Actions**, add secret
   `DOKPLOY_DEPLOY_WEBHOOK` = that URL. (Future pushes will auto-redeploy.)
4. Click **Deploy** in Dokploy.

## 7. First account, then lock signups

1. Open `https://engram.YOURDOMAIN`, create your account.
2. In Dokploy Environment, set `DISABLE_SIGNUPS=true`, then **Redeploy**.

## 8. Verification checklist (spec §8)

- [ ] `https://engram.YOURDOMAIN` loads with a valid Let's Encrypt cert:
  ```bash
  curl -I https://engram.YOURDOMAIN        # expect HTTP/2 200 (or 307 to /dashboard)
  ```
- [ ] HTTP redirects to HTTPS:
  ```bash
  curl -sI http://engram.YOURDOMAIN | grep -i location   # expect https://engram.YOURDOMAIN...
  ```
- [ ] The raw VM port is NOT publicly reachable (no host port published):
  ```bash
  curl -m 5 -I http://<VM_PUBLIC_IP>:3030 ; echo "exit=$?"   # expect connection refused/timeout
  ```
- [ ] Create account → save a test bookmark (paste a URL) → it gets a title/screenshot within a
  minute (crawler + workers alive).
- [ ] Settings → Social Sync → connect Instagram → "Sync now" → a run completes in run history.
- [ ] **Redeploy test:** re-run the deploy workflow → after it redeploys, your test bookmark is
  still there (volume persistence).
- [ ] `DISABLE_SIGNUPS=true`: opening `https://engram.YOURDOMAIN/signup` is blocked.

## Rollback

- Bad image: in Dokploy, redeploy pinning `web.image` to a known-good
  `ghcr.io/caisergan/engram:sha-XXXXXXX` tag (from a previous green CI run), then redeploy.
- Full stop: Dokploy → app → Stop. Data persists in the `data` and `meilisearch` volumes.
````

- [ ] **Step 2: Validate the runbook is well-formed Markdown (no stray code fences)**

Run:
```bash
awk '/^```/{n++} END{print (n%2==0)?"fences balanced":"UNBALANCED fences"}' docs/deployment/dokploy-runbook.md
```
Expected: `fences balanced`.

- [ ] **Step 3: Commit**

```bash
git add docs/deployment/dokploy-runbook.md
git commit -m "docs(deploy): Dokploy deployment runbook + verification checklist"
```

---

## Task 6: Final coverage check

- [ ] **Step 1: Confirm all four artifacts exist**

Run:
```bash
ls docker/docker-compose.dokploy.yml docker/.env.example \
   .github/workflows/deploy.yml docs/deployment/dokploy-runbook.md && echo "all artifacts present"
```
Expected: lists all four files and prints `all artifacts present`.

- [ ] **Step 2: Confirm the working tree is clean (everything committed)**

Run:
```bash
git status --porcelain docker/docker-compose.dokploy.yml docker/.env.example \
  .github/workflows/deploy.yml .github/workflows/docker.yml docs/deployment/dokploy-runbook.md
```
Expected: no output (all changes committed).

- [ ] **Step 3: Hand off to the runbook**

The remaining work is the user executing `docs/deployment/dokploy-runbook.md` on the VM, with the assistant guiding each step. No further code changes are required for this plan.

---

## Self-Review

**Spec coverage:**
- §5 repo artifacts → Tasks 1 (compose), 2 (.env.example), 3 (workflow), 5 (runbook). ✓
- §6 config/hardening (NEXTAUTH_URL/SECRET, MEILI_MASTER_KEY, DB_WAL_MODE, DISABLE_SIGNUPS, no host ports on chrome/meili/web, named volumes, restart policy) → encoded in Task 1 compose + Task 2 env + Task 5 runbook steps 5/7. ✓
- §7 manual VM/Dokploy/DNS steps → Task 5 runbook steps 1–7. ✓
- §8 verification → Task 5 step "Verification checklist". ✓
- §9 decisions (private GHCR + Dokploy cred, deploy `feat/social-sync` via dispatch, Dokploy-version label caveat) → runbook steps 3/4/6 + compose label fallback. ✓
- Extra: upstream `docker.yml` would fail on the fork (not in spec, but a real consequence of deploying) → Task 4. ✓

**Placeholder scan:** No TBD/TODO. `YOURDOMAIN` / `replace-me` / `sha-XXXXXXX` are intentional user-fill placeholders in templates and rollback examples, each with adjacent instructions. ✓

**Type/name consistency:** Image name `ghcr.io/caisergan/engram` identical across compose (Task 1), workflow tags (Task 3), and runbook (Task 5). Env var names identical across compose, `.env.example`, and runbook. Build target `aio` matches `docker/Dockerfile:206`. Webhook secret name `DOKPLOY_DEPLOY_WEBHOOK` identical in workflow and runbook. ✓
