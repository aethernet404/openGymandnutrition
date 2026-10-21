# Nutrition in openGym: the handoff document

This is the one page to read first if you pick this project up months from now, whether you are the owner
(not a developer) or a new engineer. It says what the nutrition module does, where its data lives, which
keys and settings it has, how it is built and deployed, what to maintain, and what to do when something
breaks. It links to the detailed guides instead of repeating them.

*Written 2026-10-21 against branch `claude/opengym-nutrition-tracker-7x1675`. Anything marked **(unverified)** was
not checked against the real service and should be confirmed before you rely on it.*

Contents: [1 What it is](#1-what-it-is) · [2 Features](#2-features-one-by-one) · [3 Data](#3-where-the-data-lives) ·
[4 Keys and settings](#4-keys-settings-and-what-they-cost) · [5 Maintenance calendar](#5-things-that-expire-or-need-maintenance) ·
[6 Build and deploy](#6-build-and-deploy) · [7 Limitations and decisions](#7-known-limitations-and-decisions) ·
[8 Troubleshooting](#8-troubleshooting-what-we-actually-hit) · [9 Where the code is](#9-where-the-code-is)

---

## 1. What it is

openGym is a self-hosted gym and body-weight tracker (a web app you install on your phone's home screen).
This fork adds a **food, calorie, macro, vitamin and supplement tracker** next to it. Everything runs on your own
server: two containers (`api` and `web`) and one folder of data. There is no third-party account and no
telemetry. The only outside services it talks to are the food databases and, if you switch it on, Claude.

The nutrition code is deliberately kept in its own folders so upstream updates stay easy to merge:
`api/nutrition/` (server) and `frontend/src/nutrition/` (screens), plus guides in `docs/NUTRITION_*.md`.
The upstream files this fork did touch are few and small: `api/server.js` (7 lines: plug in the routes, delete a
profile's nutrition file with the account, and an optional size limit on `readBody`), `api/coach/jobs.js`, `api/coach/core/prompts.js` and
`api/coach/prompts/common.md` (the opt-in Coach food summary), `frontend/src/App.jsx` (routes),
`frontend/src/views/Home.jsx` (Home cards), `frontend/src/views/Settings.jsx` (a Settings row, and the "Source code" link, which points at this fork because the AGPL asks for the source of the modified version) and its test `Settings.reset.test.jsx`,
`frontend/package.json` (**one new dependency, `zxing-wasm`, used to read a barcode from a photo**; upstream's rule
is "dependency-light", so this one was a deliberate exception), `NOTICE.md`, and the fork's CI workflow.

## 2. Features, one by one

### Diary and meals
The Nutrition screen shows one day at a time (previous / next day, a date picker, Today). At the top: calories
eaten against your goal, how many are left, and protein, carbs and fat against their goals. Below: four meal
cards (Breakfast, Lunch, Dinner, Snacks) and a **Vitamins & supplements** card. Tap an entry to edit it (name,
amount, numbers, meal, date, delete).

**The per-meal Macros button.** Each meal card has a small *Macros* button with a chevron beside the meal's calorie
total. It is hidden by default every time you open the diary. Tap it and the meal shows its calories, protein,
carbs and fat in grams, each macro's share of the meal's calories, and a thin proportion bar. The meals' numbers
are rounded so they add up exactly to the day's totals at the top. An empty meal has no button; the supplements
card only gets one if you entered calories or macros for a supplement. If some entries have calories but no
macros, the panel says the shares add up to less than 100%.

### Goals
Goals → set a calorie goal and optional protein / carbs / fat goals (grams). There is an optional **eat back**
setting (off by default): a share of the day's active calories from Apple Health is added to that day's calorie
goal.

### Quick add
For when you know the calories but not the food. Name (optional), calories, and optionally protein, carbs, fat
and vitamins and minerals ("More nutrients"). Quick adds have **no micronutrient data unless you type it** or
fill it in later from a USDA stand-in.

### My foods and saved AI estimates
*My foods* is your own list of foods: ones you created, favourites, and recents. Logging a saved food is one tap.
An AI estimate (from a photo or description) can be **saved as a food** from its review screen ("Save to My foods",
off by default) so you can log the same thing again without asking the AI. Foods from search results are kept as
**recents** so repeated logging is quick. FatSecret foods are the exception: their terms let us keep them only
24 hours, so they drop out of Recent after a day and cannot be starred. Numbers in a diary entry stay forever
(see section 7).

### Search sources (Add → Search)
Typing in the search box asks several sources at once and merges the answers. Only results that contain every
word you typed are shown. Reference foods come first.

| Source | Good for | Cannot do | Needs |
|---|---|---|---|
| **Your own foods** | everything you saved | | nothing |
| **Open Food Facts** | packaged foods and **barcodes** worldwide; volunteer-entered, so quality varies; US products and English are preferred | many products lack vitamins and minerals; no restaurant menus | nothing (free, no key) |
| **USDA FoodData Central** | plain foods and cooking ingredients (Foundation and SR Legacy: the best data), **mixed dishes such as burritos, taquitos and pizza (Survey (FNDDS), labelled "Mixed dish", ranked after the reference foods)**, and US branded labels | no restaurant menus | a free USDA key an admin pastes in |
| **FatSecret (Basic edition)** | restaurant, chain and convenience-store foods such as "7-Eleven taquitos" | **no barcodes** (a paid-tier feature), the search list shows only one line of calories and macros: the full servings load when you tap a result; results cannot be starred and are kept 24 h only; 5,000 calls a day | free Client ID and Secret, and the server's public IP registered at FatSecret |

Full details: `docs/NUTRITION_FATSECRET.md` (FatSecret) and `docs/NUTRITION_MICRONUTRIENTS.md` (what each source
carries for vitamins and minerals).

### Barcode scan
The barcode icon in Add → Search. You can type the number, take or pick a **photo of the barcode** (decoded on
your phone), or use the live camera scanner where the browser supports it. The number goes to **Open Food Facts**
only. FatSecret is not used for barcodes on the free Basic edition. A product Open Food Facts does not know can
be added as your own food.

### AI photo and Describe logging
In the Add sheet: **Photo** (take a picture of a meal) and **Describe** (type "two eggs and buttered toast").
The AI returns an **editable draft**: items, portions, calories, macros, a confidence and notes. **Nothing is
saved until you press Save.** You can fix any number first.
- It runs through the **Coach's Claude connection**: the admin must switch the Coach on and connect it to Claude
  with a `claude setup-token` token (Admin → Coach). It uses that one account; there is no separate API key.
  A Coach set to any other provider means AI logging is unavailable. If the token belongs to a different profile,
  the Coach's one-account rule refuses (this is upstream's rule and was left untouched).
- It has **no tools and no file access** (the Coach's lockdown) and runs as the unprivileged `coach` user.
- **Daily allowance:** each profile gets a number of AI analyses per UTC day (default 30, maximum 500, 0 = AI
  off), set by an admin in Goals → Admin. An analysis is counted when it starts and **given back if the model
  never ran** (runtime missing, credential rejected, provider error). A timeout or an unreadable answer stays counted.
- **Photos are shrunk on the phone, sent to Claude through the server, kept in memory for the length of the call
  and never written to disk or stored.**

### Micronutrients and the USDA stand-in fill-in
Foods, portions and entries can carry up to **29 vitamins, minerals and similar nutrients**. The rule that shapes
everything: **no data is not zero.** A nutrient is either known (a number) or absent. Absent is never shown as 0
and never summed as 0.
- The **Micronutrients card** under the day's summary (closed until tapped) shows each known nutrient's amount and
  percent of the FDA Daily Value, grouped Vitamins / Minerals / Other, with *Food only* / *Food + supplements*,
  and a neutral note when a nutrient is above the usual adult upper limit (general reference, not medical advice).
- Its coverage line has three groups: *from labels and databases · estimated from USDA stand-ins · no data*.
- **Fill in micronutrients** (Edit entry, or *Fill in missing* on the card, or an optional box when you log):
  the server searches USDA by the entry's food name; the AI is given the entry (name, brand, amount, calories,
  macros) and up to 8 candidate USDA foods and **only picks which candidate is closest, or says none is**.
  The AI never supplies a number: anything numeric in its answer is ignored. The server fetches the chosen USDA
  food and scales **USDA's own numbers** to your portion (your grams, or the weight worked out from calories).
  You review each one (*Accept*, *Choose another*, *Cancel*); a stand-in with very different calories or macros
  is flagged ("about twice the fat"). Nothing is saved until you accept.
- Accepted values are stored **separately and marked as estimates**; they never overwrite label or database
  values. The card shows a **≈** on amounts that include estimates and has an *Include estimated values* switch
  (remembered on the device, on by default). Upper-limit notes say when they include estimates.
- Cost: **one AI analysis per batch of up to 12 entries**. Details: `docs/NUTRITION_MICRONUTRIENTS.md`.

### Vitamins & supplements
A section of its own. Add a supplement by name with the nutrients in one serving (a "More nutrients" list with
chips for the common ones), save it to **My supplements**, and keep a **usual stack** that logs several in one
tap. Supplements are listed apart from food, have no calories by default, and can be summed with food on the
Micronutrients card. Upper limits that apply to supplements only (magnesium, niacin, folic acid, vitamin E,
preformed vitamin A) are compared with the supplement total. The NIH supplement database (DSLD) was researched
and deliberately **not** built; the reasoning is in `docs/NUTRITION_MICRONUTRIENTS.md`.

### Apple Health: Health Auto Export (and the Shortcut route)
A web page cannot read Apple Health, so the iPhone sends it. openGym accepts two ways, both with the same
personal **token** (made in the app, shown once):
1. **Health Auto Export** (an iPhone app): a REST automation posts active and resting energy, steps, workouts,
   exercise minutes and body weight to `POST /api/nutrition/health/hae`. Automatic syncing in that app is a
   **paid subscription** inside it (price **unverified**); **Manual Export** works without. Guide:
   `docs/NUTRITION_HEALTH_AUTO_EXPORT.md`.
2. **An iOS Shortcut** (free): posts the day's active and resting energy (and optionally steps) to
   `POST /api/nutrition/health`. Guide: `docs/NUTRITION_APPLE_HEALTH.md`. Less reliable automation than the app.

What you see: **Eaten, Burned (active + resting) and Net** on the diary, workouts and exercise minutes (display
only: workout calories are already inside Active and are never added again), the latest weight with a 30-day
line, an Apple Health stats page and a Home card. Sending a day again **replaces** it; it never adds. Nutrition
data from Health is deliberately not imported (you log food here).

### Coach summary sharing
The AI Coach (an upstream feature) can optionally see a **numbers-only** food summary: calories and macros per
logged day for the last 14 days, their averages and your goals. **No food names, brands or photos.** It is off by
default and is a switch in Goals ("Share a food summary with the Coach"). The Coach can read it and can never
change your food log (the code has no path for that, and tests pin it).

## 3. Where the data lives

Everything is under the api container's data folder, `DATA_DIR` (default `/data`; in Kubernetes a single
persistent volume). Nutrition's part is **`/data/nutrition/`** (mode 0700, files 0600).

| File | What is in it |
|---|---|
| `data/nutrition/<profile id>.json` | **One file per profile with everything that profile has:** goals; saved foods, recents, supplements and the usual stack; every day's diary entries (name, brand, serving, amount, calories, macros, micronutrients, estimate records, source, confidence); the day's AI usage counter; Coach-share choice; Apple Health numbers per day (energy, steps, exercise minutes, workouts, weights) and the metadata of the Health token (id, created, last used; **not** the secret). |
| `data/nutrition/config.json` | Admin settings: Nutrition on/off, the AI daily cap, the Health debug switch, and the **encrypted** USDA key and FatSecret Client ID + Secret. |
| `data/nutrition/health-tokens.json` | The Apple Health token index: token id → profile, and a **SHA-256 hash** of the secret half. The token itself cannot be recovered from it. |
| `data/nutrition/config.json.bak` | The settings as they were before the last admin save. If `config.json` is ever damaged the app reads this instead and the admin can restore it. A `config.json.damaged` appears after a restore. |
| `data/nutrition/fatsecret-usage.json` | Today's FatSecret call counts (server total and per profile), so a restart does not reset the budget. |
| `data/nutrition/usda-usage.json` | The USDA request counts for this hour and today (server total and per profile), for the same reason. A counter file that cannot be read is kept as `*.damaged` and counting starts again. |
| `*.tmp` | A leftover temporary file from a write that was interrupted; safe to delete when the api is stopped. |

Related files outside `nutrition/` that matter to a restore: **`data/secret`** (the key that encrypts the USDA and
FatSecret keys and the Coach credentials, and signs sessions), `data/db.json` (users and passkeys), `data/coach/`
(Coach settings), `data/state-<id>.json` (gym data) and `data/audit.log`.

**What is stored:** food names, brands, amounts, calories, macros, micronutrients, goals, Apple Health numbers
you sent, and the stand-in records (USDA food id and name). **What is never stored:** photos (not even
temporarily on disk), barcodes you scanned (only the number is looked up, not kept), the search words, FatSecret
or USDA result lists (kept in memory for minutes), and the Health token's secret, FatSecret token and any key in clear text.

**Nightly backup (set up on the server):** a job runs every night at **03:30** and copies the data into `/home/aether/backups/opengym-test`. The job itself and the restore steps it came with were written by the operator (Cascade); this repository does not contain them, so keep that text with the backups. In outline, a restore is: scale the `opengym-test` deployment to 0, put the backed-up `data` files back with the same owner and permissions, scale to 1, then check the diary and Goals → Admin. A damaged `config.json` alone can be restored from `config.json.bak` in Goals → Admin.

**Back up by hand:** copy the whole `data` folder (all of it, **including `secret`**) while the api is idle, or better,
take a snapshot of the volume. Illustrative command (untested here; adjust the names):
`kubectl -n fitness-test exec deploy/opengym-test -c api -- tar czf - -C /data . > opengym-data-$(date +%F).tgz`.
Keep the backup private: it holds your health diary and the key that decrypts the stored API keys.
**Restore:** stop the api (the deployment is a single replica), put the folder back with the same owner and
permissions (files 0600, folders 0700), start it. **If `secret` is not restored, the encrypted USDA and FatSecret
keys and the Coach connection cannot be read: enter them again.** Nutrition data itself is plain JSON and does not
depend on `secret`. A profile file that cannot be parsed is **left untouched** and the app says it is damaged;
restore that one file from backup. Apart from the nightly copy above there is no other automatic backup.

## 4. Keys, settings, and what they cost

| Setting | Where it is entered | What it is | Cost / limit |
|---|---|---|---|
| **Nutrition on/off** | Goals → Admin (admin) | switches the whole module | none |
| **AI analyses per day** | Goals → Admin (admin) | per profile, per UTC day; 0 = off; default 30, max 500 | each analysis uses the Claude account's allowance (see below) |
| **Claude connection** | Admin → Coach (admin) | `claude setup-token` token of one Claude account; AI logging and the stand-in fill-in use it | uses that subscription's usage; no per-call money, but the account's own limits apply |
| **USDA key** | Goals → *USDA food search* (admin) | free key from api.data.gov (FoodData Central), sent in the `X-Api-Key` header (that form is **unverified** against USDA's pages; the app falls back to `api_key` in the URL if USDA refuses it) | free. USDA allows about 1,000 requests an hour per key (**unverified**); the app stops at **800 an hour and 6,000 a day for the server, 200 an hour per person** (env `NUTRITION_USDA_HOURLY_CAP`, `NUTRITION_USDA_DAILY_CAP`, `NUTRITION_USDA_USER_HOURLY_CAP`). One search is 3 requests |
| **FatSecret Client ID + Secret** | Goals → *FatSecret food search* (admin) | the "REST API OAuth 2.0" pair of the free **Basic** edition | free; 5,000 calls a day. The app stops at 4,000 a day for the server and 400 per person (env `NUTRITION_FATSECRET_DAILY_CAP`, `NUTRITION_FATSECRET_USER_CAP`; never above 5,000) |
| **Apple Health token** | Nutrition → Apple Health (each person, for their own profile) | one token per profile; making a new one replaces the old; shown once | free; 60 uploads an hour per token |
| **Health debug** | Goals → Health Auto Export debug (admin) | keeps the *shape* of the last payload in memory for 1 hour, off by default | none |
| `NUTRITION_WRITES_PER_MINUTE` | api environment (optional) | changes (add, edit, delete) one profile may make per minute, default 120 | none |
| `NUTRITION_OFF_COUNTRY` / `NUTRITION_OFF_LANG` | api environment (optional) | which Open Food Facts products are preferred (defaults `united-states`, `english`) | none |

Secrets are write-only: after saving, the app shows only "set" and the last four characters of an identifier.

## 5. Things that expire or need maintenance

| Item | What happens | What to do |
|---|---|---|
| **FatSecret IP registration** | FatSecret only answers requests from IP addresses registered in its dashboard (IP Restrictions). It must be **the server's public IP**. A home connection's public IP can change. When it does, every FatSecret search fails with "FatSecret refused this server's IP address" (error code 21). | Check the address (`curl ifconfig.me` from the server, or from the pod) and update it in the FatSecret dashboard. Then Goals → FatSecret → *Test keys*. |
| **GitHub `read:packages` token** | The server pulls images from private packages on ghcr.io with a classic personal access token stored in the Kubernetes secret `ghcr-pull`. **It expires on January 12, 2027.** After that, a deploy (and any pod restart that needs to pull) fails with an image pull error. | Before the date: create a new classic token with only `read:packages`, give it to Cascade to replace the `ghcr-pull` secret in `fitness-test`, and note the new expiry here. |
| **Health Auto Export subscription** | If the paid subscription lapses, automatic syncing stops silently; the diary just stops getting new Apple Health numbers (the last update time is shown on the stats page). | Renew it, or use Manual Export, or switch to the free Shortcut. |
| **FatSecret / USDA keys** | Keys can be revoked or the free tier changed. | Goals → *Test keys* / *Test key* shows token, granted scopes and a tiny search. |
| **Claude setup-token** | A `setup-token` is a long-lived credential but can be revoked or expire (**duration unverified**). The AI says "needs reconnecting". | Admin → Coach → reconnect. |
| **Image tags** | Each build has a new tag; nothing is `latest`. | Keep the previous digest handy for rollback (section 6). |

## 6. Build and deploy

**Nothing is built on the server.** The flow:
1. A push to `claude/opengym-nutrition-tracker-7x1675` that touches `api/`, `frontend/`, `web/`, `catalogue/` or
   `scripts/` starts **GitHub Actions → "Build fork images"** (`.github/workflows/build-fork-images.yml`).
2. The run has three boxes: `api`, `web` and `summary`. Each image is built once, **started and checked as the very
   image that will be pushed**, and only then pushed to **private packages on ghcr.io**:
   `ghcr.io/aethernet404/opengym-api-coach-fork:nutrition-<7-char commit>` and
   `ghcr.io/aethernet404/opengym-web-fork:nutrition-<7-char commit>` (linux/amd64, no `latest` tag).
   The api check confirms the nutrition module and the Claude SDK are in the image, that it boots on an empty volume,
   that `/api/health` answers and that the nutrition routes answer 401 (not 404). The web check confirms this
   commit's frontend is in the bundle and nginx serves it.
3. **How to read the run:** Actions tab → **Build fork images** → the newest run → **Summary** (top-left of the
   run page). At the bottom, "Images pushed for `<commit>`" lists both image names and their **`sha256:` digests**.
   All three boxes must be green. A red `api` or `web` box means nothing was pushed: open the box, then the failing
   step, to read the log. (Tests run in a separate workflow, `test.yml`, on pull requests.)
4. **Cascade** (the operator on the server) then only **pulls**: it creates or keeps the pull secret `ghcr-pull`
   in the `fitness-test` namespace and runs `kubectl set image` on the two containers (`api` and `web`) of the
   **`opengym-test`** deployment with the **digest-pinned** names (`…@sha256:…`) from the run summary, waits for the
   rollout, verifies, and checks that the other pods did not change. No `docker build`, no image import, replicas
   stay 1 and the strategy stays `Recreate`.
5. After the first load of a new version close and reopen the app once so the phone picks up the new frontend.

Paste-ready deploy request (replace the commit):
```
Please deploy the openGym images built by GitHub Actions for commit <short sha> on branch
claude/opengym-nutrition-tracker-7x1675. Do NOT build anything on the server. Take the api and web digests from
the run's Summary (ghcr.io/…@sha256:… form), use the existing ghcr-pull secret, set both containers of
deploy/opengym-test in namespace fitness-test, wait for the rollout, and show me the running digests.
```

**Rollback:**
```
kubectl -n fitness-test rollout undo deploy/opengym-test
kubectl -n fitness-test rollout status deploy/opengym-test
kubectl -n fitness-test get deploy/opengym-test -o jsonpath='{.spec.replicas}{"\n"}'   # must print 1
```
`rollout undo` returns to the previous revision. To go to a specific older build instead, set both containers to
that run's digests: `kubectl -n fitness-test set image deploy/opengym-test api=<api image@sha256:…> web=<web image@sha256:…>`.
Data in `/data/nutrition/` is left in place and an older image ignores fields it does not know (estimates, for
example), so a rollback does not lose data. See `api/nutrition/DEPLOY.md` and `docs/NUTRITION_FORK_IMAGES.md` for the
longer version (the first-time GitHub setup and the private/public package decision).

The api must stay at **one replica**: state is JSON files written by an in-process queue; two pods on one volume
would corrupt them.

## 7. Known limitations and decisions

- **FatSecret's terms limit what we keep.** Only their ids may be stored indefinitely; other data may be cached up
  to 24 hours. So search results live in memory for 10 minutes, FatSecret recents expire after 24 hours and cannot
  be starred. **Judgement call:** the numbers inside a *diary entry* stay, because they are the person's own record
  of what they ate; a stricter reading of the terms could say otherwise. If that matters, entries could keep only
  what the person typed.
- **FatSecret Basic** has no barcode lookup and the search list carries only one line of calories and macros.
  Their free "Premier Free" tier (start-ups, non-profits, students; needs verification and attribution) could
  unlock more later. "Powered by fatsecret" is shown wherever their results appear.
- **Brand foods on FatSecret:** a 0 for vitamin A, C, D, calcium or iron is treated as *not stated* (unknown), not
  as zero, because FatSecret does not distinguish them. Generic foods' zeros are trusted.
- **Estimates are always marked** (≈, and the *Include estimated values* switch). They are stored apart from
  label values and never overwrite them. They come from a *stand-in* USDA food: close, not identical.
- **Unknown is never zero**, anywhere: not stored, not summed, not shown.
- **Unit conversions that are assumptions** (listed in `docs/NUTRITION_MICRONUTRIENTS.md`): vitamin A in IU is read as
  retinol (×0.3 mcg RAE); the same IU on a food could be beta-carotene, which would be a much smaller amount.
  Vitamin E in IU is read as natural d-alpha-tocopherol (×0.67 mg); synthetic dl-alpha would be ×0.45. Vitamin D IU ÷ 40 is
  standard. Open Food Facts vitamins A, D and E are assumed to arrive already converted. Percent-of-Daily-Value
  figures are never converted. The nutrient ids for USDA were not re-checked against its documentation **(unverified)**.
- **Upper limits** shown are general adult reference values (as of 2026-10), not personal or medical advice.
- **Open Food Facts** data is volunteer-entered and often incomplete; its search can take 3 to 8 seconds.
- **Single replica**, one JSON file per profile rewritten whole on each change.
- **Limits per profile** (so one client cannot grow its file without end): 3,660 days, 50,000 entries, 15 MB, and 120 changes a minute. A change that would pass a limit is refused with a plain message and nothing is written.
- **Server date is UTC:** the AI allowance, FatSecret budget and "today" for the Health token reset at midnight UTC.
- **The Apple Health route** accepts days from 60 days ago to tomorrow only.
- **Security review:** see `docs/NUTRITION_SECURITY_REVIEW.md`: what was found, what was fixed (with the commits) and the short list of
  findings that are known and accepted.

## 8. Troubleshooting: what we actually hit

| Symptom | Cause | Fix |
|---|---|---|
| FatSecret search says it is **"rate limited"** and never works, though usage is far below the cap | The first version used FatSecret's *foods.search v4*, which is a **Premier Exclusive** method. A Basic key gets error **code 14, "OAuth 2.0: Missing scope"** inside an HTTP 200 answer, and the app wrongly labelled code 14 as a rate limit. | Fixed: the app now uses *foods.search v1* and *food.get v5* (scope `basic`), and maps errors strictly by FatSecret's documented code (14 = missing scope, 13 = invalid token, 21 = IP not registered, 11 and 12 = rate limit). Goals → FatSecret → **Test keys** shows the token, the scopes granted and the exact code and meaning if a search fails. |
| FatSecret says **"refused this server's IP address"** (code 21) | The server's public IP is not in FatSecret's IP Restrictions, or it changed. | Section 5. |
| A button or heading looks **centered / broken** only inside nutrition screens (the "`.center` class clash") | A global CSS class `.center` in the app's stylesheet collided with a class of the same name used in nutrition markup. | Nutrition's own classes are all prefixed `nut-`; never reuse a global class name. A test pins the layout rules (`frontend/src/nutrition/layout.test.js`). |
| The first run of **Build fork images failed in the web smoke test** with little to go on | The check expected `GET /nutrition/health` to answer 200, but nginx does **not** serve `index.html` for unknown paths: it redirects them to `/` (the app routes in the browser). A correct server failed the check, and the output did not say what was expected. | Fixed (commit `3262b44b`): the check now expects the redirect, says what each check is for, and on failure prints the container's logs. When a check fails, open the failing step in the run (box → step) and read the printed logs; when you add a check, make it print what it expected and what it got. |
| AI says **"not available on this server"** | The Coach is off, connected to a provider other than Claude, the token belongs to another profile, or the server could not drop privileges to the `coach` user. | Admin → Coach. The message names which. |
| **"Fill in missing"** says it needs the USDA key | No USDA key is set. | Goals → USDA food search. |
| A search shows **"nothing found"** for a foods you know exist | Every typed word must match; or one source is down (a banner names it). | Try one simple word ("egg", not "whole egg"); retry the failed source. |
| **Apple Health numbers stopped** | Token revoked or replaced, Health Auto Export subscription lapsed, the automation's date range is not *Today*, or the iPhone was locked (an energy of 0 and 0 is refused). | Nutrition → Apple Health shows the last update; remake the token if unsure. |
| A deploy fails with **ImagePullBackOff** | The `ghcr-pull` token expired (January 12, 2027), the package name or digest is wrong, or the package is not readable by that token. | Section 5; check the digest against the run summary. |
| The app shows the **old version** after a deploy | The phone's service worker cached the old frontend. | Close and reopen the app once, or hard-refresh. |
| **"The settings file is damaged; your keys were not changed"** (admin) | `data/nutrition/config.json` no longer parses. The app refuses to save over it and reads `config.json.bak` meanwhile. | Goals → Admin → *Restore the backup*, or put a good copy of the file back. |
| **"You have used your share of USDA lookups"** / **"This server has used its USDA lookups for this hour"** | The USDA request budget (section 4). | Wait for the top of the hour (or midnight UTC); raise the env caps only if USDA allows it. |
| **"too many changes; wait a moment"** | More than 120 changes in a minute from one profile (usually a script or a stuck retry loop). | Wait a minute. |
| **"your nutrition data file is damaged"** | A profile JSON no longer parses (disk problem, manual edit). The server leaves it untouched on purpose. | Restore that file from a backup (section 3). |

## 9. Where the code is

| Area | Files |
|---|---|
| Server entry points and every route | `api/nutrition/routes.js` (plugged into `api/server.js` by one line) |
| Storage, locking, per-day and per-meal totals | `api/nutrition/store.js`, `validate.js`, `config.js` |
| Food sources and ranking | `lookup.js` (Open Food Facts, USDA), `fatsecret.js`, `rank.js` |
| Micronutrients | `micros.js` (the 29 nutrients, units, limits), `micros-sources.js` (how each source is read), `standin.js` (USDA stand-ins) |
| AI | `analyze.js`, `vision.js`, `prompt.js`, `meal.js`, `pipeline.js`, `jobdir.js` |
| Apple Health | `health.js`, `hae.js`, `hae-debug.js` |
| Coach summary | `coach-summary.js` |
| Screens | `frontend/src/nutrition/` (`Diary.jsx`, `sheets.jsx`, `AiLog.jsx`, `FillMicros.jsx`, `MicrosCard.jsx`, `Goals.jsx`, `Foods.jsx`, `Supplements.jsx`, `AppleHealth.jsx`, …) |
| Tests | `api/test/nutrition-*.test.js`; the app's tests sit beside the code in `frontend/src/nutrition/` |
| Guides | `docs/NUTRITION_*.md` and `api/nutrition/README.md` (the route table); `NUTRITION_PROPOSALS.md` (ideas not yet applied: image retention, test-date fix, moving to `main`); `NUTRITION_FORK_IMAGES.md` also lists which GitHub workflows to keep or disable |

Run the tests: `cd api && npm test` and `cd frontend && npm test`. Ten api tests that depend on the calendar date fail on
a pristine upstream checkout too ("date rot"); they pass with the clock set to 2026-10-12.
