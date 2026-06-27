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
