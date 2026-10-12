# Deploying Nutrition (fork build)

Two images change: **api** (new `nutrition/` module, coach target) and **web** (new frontend).
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

Notes
- Container names `api` / `web` and the deployment name are from the upstream manifest; use
  `kubectl -n <ns> get deploy -o wide` to confirm yours.
- No new env vars, volumes, ports or secrets. Existing `/data` PVC and `/coach-auth` mount are reused;
  Nutrition writes `/data/nutrition/`.
- Use a new tag per build (not `latest`) so the node pulls it and the PWA service worker sees a new
  build. After the first load, close and reopen the app once (or hard-refresh) to pick up the new
  frontend.
- Roll back: `kubectl rollout undo deploy/<deployment>`. `/data/nutrition/` is left in place and
  ignored by the old image.
