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
| `GET` / `PUT /api/nutrition/goals` | `{calories, protein_g, carbs_g, fat_g}`, each a number or null |
| `GET` / `PUT /api/admin/nutrition` | admin: `{ enabled, aiDailyCap (0–500, 0 = AI off, default 30) }` |

The AI allowance is its own counter (`reserveAi` / `refundAi` in `store.js`), separate from the
Coach's cap, counted per profile per UTC day.
