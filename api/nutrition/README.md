# api/nutrition

Self-contained Nutrition backend. Wired into `server.js` by one `...nutritionRoutes(...)` line.
Not listed in `openapi.yaml` on purpose (the upstream route-parity test scans only server.js and
coach/routes.js); the routes are documented here instead.

Data: `data/nutrition/<uid>.json` (0600, atomic + fsync writes, per-profile write queue) and
`data/nutrition/config.json` (admin settings). Single API replica only.

All user routes need a session (401 otherwise) and answer 503 `{code:'off'}` when an admin has
switched Nutrition off.

| Route | Purpose |
| --- | --- |
| `GET /api/nutrition/config` | `{ ai:{limit,used,remaining}, meals }` |
| `GET /api/nutrition/day?date=YYYY-MM-DD` | entries, totals, per-meal totals, goals |
| `GET /api/nutrition/range?from=&to=` | per-day totals (≤ 400 days) + goals |
| `POST /api/nutrition/entries` | `{date, meal, name, calories, protein_g, carbs_g, fat_g, qty?, serving?, grams?, source?, confidence?, foodId?}` or `{date, meal?, entries:[…]}` (≤ 30). With `foodId` and no macros, macros = food × `qty` |
| `PUT /api/nutrition/entries?date=&id=` | partial edit; body `newDate` moves it to another day |
| `DELETE /api/nutrition/entries?date=&id=` | |
| `GET /api/nutrition/foods?scope=all\|custom\|favorite\|recent&q=` | |
| `POST /api/nutrition/foods` | custom food `{name, brand?, serving?, grams?, per:{calories,protein_g,carbs_g,fat_g}, ext?}` |
| `PUT /api/nutrition/foods?id=` | edit a custom food, or set `favorite` on any food |
| `DELETE /api/nutrition/foods?id=` | already-logged entries keep their numbers |
| `GET /api/nutrition/search?q=&source=all\|off\|usda` | Open Food Facts + USDA (key set by an admin), each hit as `bases[]` (label serving, 100 g). Only hits containing every typed word are returned, best first (`rank`, comparable across sources: USDA Foundation/SR Legacy reference foods lead). Per-source status in `sources`; ask `source=off` and `source=usda` separately and merge by `rank` to show whichever answers first. One source down never fails the search. A source that times out or errors is retried once. 40 lookups/min/profile |
| `GET /api/nutrition/barcode?code=` | Open Food Facts product by 8–14 digit barcode |
| `POST /api/nutrition/analyze` | `{kind:'photo', image:<base64 jpeg/png/webp>, note?}` or `{kind:'text', text}` → an editable **draft** (nothing saved). Coach's Claude Agent SDK path, inline image, own daily allowance |
| `PUT /api/nutrition/coach-share` | `{share:boolean}` opt in/out of the numbers-only summary the Coach may read (default off) |
| `POST /api/nutrition/health` | **Apple Health ingest.** `Authorization: Bearer ogh_…` (no cookie): `{date, active_kcal, resting_kcal, steps?}`. The ONLY route that accepts the Health token; replaces that day's numbers; both energies 0 is refused (a locked iPhone). 60/hour per token, wrong tokens lock the address. Guide: `docs/NUTRITION_APPLE_HEALTH.md` |
| `POST /api/nutrition/health/hae` | **Health Auto Export ingest** (same Bearer token, same limits). Reads `data.metrics` (`active_energy`, `basal_energy_burned`, `step_count`, `apple_exercise_time`, `weight_body_mass`) and `data.workouts`; per-day replace, partial exports never lower a day; workouts/minutes/weight are display only (workout kcal never reach Burned or Net). `hae.js` is the parser. Guide: `docs/NUTRITION_HEALTH_AUTO_EXPORT.md` |
| `GET /api/nutrition/weight?date=` | latest weight (kg) and the last 30 days of readings |
| `GET` / `DELETE /api/admin/nutrition/health-debug` | admin only: the in-memory shape of the last HAE payload (option `healthDebug` in `PUT /api/admin/nutrition`, off by default, 1 hour) |
| `GET` / `POST` / `DELETE /api/nutrition/health/token` | status (hint, created, last used) / make or replace (the full token is in this response only) / revoke |
| `PUT /api/nutrition/health/settings` | `{eatBack:{enabled, percent 0–100}}`, off by default |
| `GET` / `PUT /api/nutrition/goals` | `{calories, protein_g, carbs_g, fat_g}`, each a number or null |
| `GET` / `PUT /api/admin/nutrition` | admin: `{ enabled, aiDailyCap (0–500, 0 = AI off, default 30), usdaKey }` (the key is write-only, encrypted at rest; reads return `usdaKeySet` and the last 4 characters) |
| `POST /api/admin/nutrition/test-usda` | admin: checks the stored USDA key with a real search |

The AI allowance is its own counter (`reserveAi` / `refundAi` in `store.js`), separate from the
Coach's cap, counted per profile per UTC day.

## Search behaviour
`rank.js` decides relevance and order, `lookup.js` the transport. Timeouts: 10 s first try, 8 s retry, ~21 s
budget per source. Identical searches are cached for 5 minutes and share an in-flight request. Open Food Facts is
asked for English-language, US-market products first (sorted by popularity) and the whole catalogue only if that
yields fewer than 5 relevant hits: `NUTRITION_OFF_COUNTRY` (default `united-states`) and `NUTRITION_OFF_LANG`
(default `english`); set either to an empty string to switch that filter off. An answer of an unexpected shape is a
failure and is logged (service, kind, HTTP status and top-level key names only), at most once a minute per service.

## Outbound network
`world.openfoodfacts.org` (search, barcode) and `api.nal.usda.gov` (only when a key is set), HTTPS, 6 s
timeout each. Mirrors/tests: `NUTRITION_OFF_BASE`, `NUTRITION_USDA_BASE`. AI logging adds no new
destination: the Claude runtime talks to Anthropic exactly as the Coach does.

## Files in this module
`routes.js` (HTTP), `store.js` (per-profile file, write queue), `validate.js`, `config.js` (admin settings),
`lookup.js` (OFF/USDA), `analyze.js` + `vision.js` + `pipeline.js` + `meal.js` + `prompt.js` (AI estimate),
`health.js` (Apple Health token + ingest), `jobdir.js`, `coach-summary.js` (the Coach's read-only view), `spike/` (Phase 1 live check).
