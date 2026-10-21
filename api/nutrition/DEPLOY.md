# Deploying Nutrition (fork build)

Two images change: **api** (the `nutrition/` module, coach target) and **web** (new frontend).
The api must stay at **one replica** — state is JSON files under /data, written with an
in-process queue. The upstream manifest (`kubernetes/deployment.yaml`) already runs api + web as
two containers of one pod with `replicas: 1`, `strategy: Recreate` and a single `/data` PVC.

**Nothing is built on the server.** GitHub Actions builds both images (`.github/workflows/build-fork-images.yml`), tests
them as the exact images that get pushed, and pushes them to private packages on ghcr.io:

| image | name |
|---|---|
| api (`--target coach`) | `ghcr.io/aethernet404/opengym-api-coach-fork:nutrition-<7-char commit>` |
| web | `ghcr.io/aethernet404/opengym-web-fork:nutrition-<7-char commit>` |

The run's **Summary** page lists each image's `sha256:` digest. The operator (Cascade) then only pulls: it keeps the pull
secret `ghcr-pull` in namespace `fitness-test` and runs, for the deployment `opengym-test`:

```bash
kubectl -n fitness-test set image deploy/opengym-test \
  api=ghcr.io/aethernet404/opengym-api-coach-fork@sha256:<api digest> \
  web=ghcr.io/aethernet404/opengym-web-fork@sha256:<web digest>
kubectl -n fitness-test rollout status deploy/opengym-test
kubectl -n fitness-test get deploy/opengym-test -o jsonpath='{.spec.replicas}{"\n"}'   # must print 1
```

The api must stay at **one replica**: state is JSON files written by an in-process queue. The strategy stays `Recreate`.
See `docs/NUTRITION_FORK_IMAGES.md` (first-time GitHub setup, private packages, the pull token) and
`docs/NUTRITION_OVERVIEW.md` (the whole picture).

## Settings, env vars, network
- **Optional env vars (api container), none required:** `NUTRITION_OFF_COUNTRY` (default `united-states`) and
  `NUTRITION_OFF_LANG` (default `english`) choose which Open Food Facts products are preferred; empty = no filter.
  `NUTRITION_USDA_HOURLY_CAP` (800, at most 1000), `NUTRITION_USDA_DAILY_CAP` (6000), `NUTRITION_USDA_USER_HOURLY_CAP` (200),
  `NUTRITION_WRITES_PER_MINUTE` (120), and the two FatSecret caps below.
- **No new volumes, ports or secrets.** Nutrition data is `/data/nutrition/` on the existing PVC.
- **Outbound HTTPS from the api container** (egress policies / proxies must allow it):
  - `world.openfoodfacts.org:443` — food search and barcodes (always)
  - `api.nal.usda.gov:443` — USDA search, stand-in lookups and details (only once an admin has pasted a USDA key)
  - AI logging needs nothing new: the Claude runtime already reaches Anthropic for the Coach.
- **In the app (admin):** Nutrition → Goals → *USDA food search* (key), *Admin* (AI analyses per day, default 30; on/off).
- AI logging needs the Coach **switched on and connected to Claude** (Admin → Coach, `claude setup-token`).
- nginx: no change. Photos are shrunk to ~1280 px JPEG (a few hundred KB) before upload, well inside the
  existing 5 MB `/api/` limit; the AI call has a 90 s server budget inside nginx's 300 s read timeout.

## Roll out / back
- Every build has its own tag and digest (there is no `latest`), so the node pulls it and the PWA service worker sees a new build.
  After the first load, close and reopen the app once (or hard-refresh) to pick up the new frontend.
- Roll back: `kubectl -n fitness-test rollout undo deploy/opengym-test`. `/data/nutrition/` is left in place and an older image ignores fields it does not know.
- **Health Auto Export** (`POST /api/nutrition/health/hae`): no new env vars, volumes or outbound hosts. The iPhone
  app calls your public address, so Cloudflare/nginx must let `POST /api/nutrition/health/hae` through with its
  `Authorization` header (same as the Shortcut route). Payloads are small with Summarize Data on; the 5 MB `/api/`
  limit in nginx applies. The optional admin debug switch (Goals → Health Auto Export debug) keeps data in memory only.
- **FatSecret (optional, admin)**: Nutrition → Goals → *FatSecret food search* (Client ID + Secret; see `docs/NUTRITION_FATSECRET.md`).
  Outbound HTTPS from the api container to `oauth.fatsecret.com:443` and `platform.fatsecret.com:443`. FatSecret only answers
  requests from IP addresses registered in its dashboard: register the server's public IP there. Optional env vars (api container):
  `NUTRITION_FATSECRET_DAILY_CAP` (default 4000, max 5000) and `NUTRITION_FATSECRET_USER_CAP` (default 400).

## Backups
`data/` (including `secret`, which decrypts the stored API keys) is copied nightly at **03:30** into
`/home/aether/backups/opengym-test` on the server (set up by the operator; the exact job and its restore steps are the
operator's, see `docs/NUTRITION_OVERVIEW.md` section 3). To restore: stop the api (scale the deployment to 0), put the
backed-up files back with the same owner and permissions (files 0600, folders 0700), scale back to 1, check
Goals → Admin and the diary. A damaged `data/nutrition/config.json` can be restored from its own `config.json.bak`
in Goals → Admin without touching the backup.
