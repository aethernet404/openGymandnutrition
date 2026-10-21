# Photo spike (a diagnostic; the app does not use it)

Needs the **coach** image target (`API_TARGET=coach`), the Coach set to *Claude* in Admin → Coach,
and the setup token connected. Uses the Coach's own credential; writes nothing under `/data`.

```bash
# Docker
docker compose exec api node nutrition/spike/run.mjs /tmp/meal.jpg
# (copy a photo in first:  docker compose cp ./meal.jpg api:/tmp/meal.jpg)

# k3s
kubectl cp ./meal.jpg <ns>/<api-pod>:/tmp/meal.jpg
kubectl -n <ns> exec deploy/<api-deployment> -- node nutrition/spike/run.mjs /tmp/meal.jpg
```

Text-only fallback check: `... run.mjs --text "two fried eggs and a slice of toast"`.
Flags: `--uid`, `--mode auto|inline|read`, `--timeout <s>`, `--note`, `--keep`.
Exit code 0 = an answer was parsed and validated.
