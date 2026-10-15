# Deploying Nutrition (fork build)

Two images change: **api** (the `nutrition/` module, coach target) and **web** (new frontend).
The api must stay at **one replica** — state is JSON files under /data, written with an
in-process queue. The upstream manifest (`kubernetes/deployment.yaml`) already runs api + web as
two containers of one pod with `replicas: 1`, `strategy: Recreate` and a single `/data` PVC.

```bash
# from the repo root, on the branch you are deploying
REG=<your-registry>            # e.g. registry.example.lan:5000 or ghcr.io/<you>
TAG=nutrition-$(git rev-parse --short HEAD)

# 1. api — the coach target (Claude Agent SDK present). Build context is ./api.
docker build --target coach -t $REG/opengym-api:$TAG ./api

# 2. web — context is the REPO ROOT (the Dockerfile copies frontend/ and api/coach/core/).
docker build -f web/Dockerfile -t $REG/opengym-web:$TAG --build-arg VERSION=$TAG .

docker push $REG/opengym-api:$TAG
docker push $REG/opengym-web:$TAG

# 3. roll both containers of the pod to the new tag (replicas stays 1)
kubectl -n <ns> set image deploy/<deployment> api=$REG/opengym-api:$TAG web=$REG/opengym-web:$TAG
kubectl -n <ns> rollout status deploy/<deployment>
kubectl -n <ns> get deploy/<deployment> -o jsonpath='{.spec.replicas}{"\n"}'   # must print 1
```

## Settings, env vars, network
- **Optional env vars (api container), none required:** `NUTRITION_OFF_COUNTRY` (default `united-states`) and
  `NUTRITION_OFF_LANG` (default `english`) choose which Open Food Facts products are preferred; empty = no filter.
- **No new volumes, ports or secrets.** Nutrition data is `/data/nutrition/` on the existing PVC.
- **Outbound HTTPS from the api container** (egress policies / proxies must allow it):
  - `world.openfoodfacts.org:443` — food search and barcodes (always)
  - `api.nal.usda.gov:443` — USDA search (only once an admin has pasted a USDA key)
  - AI logging needs nothing new: the Claude runtime already reaches Anthropic for the Coach.
- **In the app (admin):** Nutrition → Goals → *USDA food search* (key), *Admin* (AI analyses per day, default 30; on/off).
- AI logging needs the Coach **switched on and connected to Claude** (Admin → Coach, `claude setup-token`).
- nginx: no change. Photos are shrunk to ~1280 px JPEG (a few hundred KB) before upload, well inside the
  existing 5 MB `/api/` limit; the AI call has a 90 s server budget inside nginx's 300 s read timeout.

## Roll out / back
- Use a new tag per build (not `latest`) so the node pulls it and the PWA service worker sees a new build.
  After the first load, close and reopen the app once (or hard-refresh) to pick up the new frontend.
- Roll back: `kubectl rollout undo deploy/<deployment>`. `/data/nutrition/` is left in place and ignored by the old image.
- **Health Auto Export** (`POST /api/nutrition/health/hae`): no new env vars, volumes or outbound hosts. The iPhone
  app calls your public address, so Cloudflare/nginx must let `POST /api/nutrition/health/hae` through with its
  `Authorization` header (same as the Shortcut route). Payloads are small with Summarize Data on; the 5 MB `/api/`
  limit in nginx applies. The optional admin debug switch (Goals → Health Auto Export debug) keeps data in memory only.
- **FatSecret (optional, admin)**: Nutrition → Goals → *FatSecret food search* (Client ID + Secret; see `docs/NUTRITION_FATSECRET.md`).
  Outbound HTTPS from the api container to `oauth.fatsecret.com:443` and `platform.fatsecret.com:443`. FatSecret only answers
  requests from IP addresses registered in its dashboard: register the server's public IP there. Optional env vars (api container):
  `NUTRITION_FATSECRET_DAILY_CAP` (default 4000, max 5000) and `NUTRITION_FATSECRET_USER_CAP` (default 400).
