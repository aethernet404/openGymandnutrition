# Nutrition: security and reliability review

*Read-only review, 2026-10-21, of `api/nutrition/` and its routes at commit `e44e2f14` plus the parts of
`api/server.js` and `api/coach/` that they rely on. **Nothing was changed.** Every fix below is a proposal.*

How sure: **high** = I read the code and, where marked, reproduced it; **medium** = I read the code and reasoned about
it but did not run it; **low** = depends on something I could not check (a third party's terms, real load).

## Summary

| # | Severity | Finding | Sure |
|---|---|---|---|
| 1 | **High** | Prototype pollution through a food id (`__proto__`): one signed-in user can change behaviour for every profile until the api restarts | high (reproduced) |
| 2 | **Medium** | No server-wide budget for USDA calls; one profile can use the shared key's hourly allowance | medium |
| 3 | **Medium** | No write-rate limit and no cap on the number of days a profile can hold; the whole file is rewritten on every change, in the single api process | medium |
| 4 | **Medium** | A damaged `config.json` is read as "empty", and the next admin save then erases the encrypted keys and settings | high |
| 5 | **Medium** | AGPL: the app's "Source code" link points at upstream, not at this fork's modified source | medium |
| 6 | Low | Open Food Facts calls can exceed what OFF asks of API users; all profiles share one server address | low |
| 7 | Low | The USDA key travels in the URL query string | medium |
| 8 | Low | The AI runtime's error text (first 200 characters) is written to the server log | medium |
| 9 | Low | Health Auto Export debug capture holds example health values in memory for an hour, readable by an admin | high |
| 10 | Low | One Claude account serving several profiles may not fit Anthropic's terms for that kind of token | low |
| 11 | Low | A new frontend dependency (`zxing-wasm`) against the project's "dependency-light" rule, and its licence is unchecked | medium |
| 12 | Low | Leftovers after a profile is deleted (token index entry, FatSecret counters); no automatic backup | high |
| – | Info | Prompt injection through food or brand names: the damage is bounded (see 13) | high |

## What was checked and is sound

- **Authentication.** Every user route goes through `guarded()` (a valid session, Nutrition switched on). The only
  routes that take no session are the two Apple Health ingest routes, which require a Bearer token, and they are
  also the only routes that accept it; a test sends the token to a dozen other routes to keep that true.
  Admin routes call `requireAdmin`. Every read and write uses the profile id from the **session**, never an id
  from the request, so I found no path by which one profile can read or write another's diary, foods, goals or Health data.
- **CSRF.** `api/server.js` checks the Origin for every state-changing browser request (cookies are SameSite=Lax too);
  Bearer-token requests are exempt because a browser never adds that header by itself.
- **Secrets at rest.** The USDA key and the FatSecret Client ID and Secret are stored in `config.json` encrypted with AES-256-GCM
  (key derived from `DATA_DIR/secret`); files are mode 0600, folders 0700. The Health token's secret is never stored, only
  its SHA-256, compared in constant time.
- **Secrets in answers and logs.** The admin GET/PUT return `usdaKeySet`, `fatsecretIdHint` (last four of the ID) and
  nothing secret. FatSecret messages are sanitised before display (addresses and token-like strings removed,
  160 characters); FatSecret's token is only used to read the `scope` claim and is never shown or logged; the Test
  button never returns it; tests assert that keys and tokens appear in no log line. The Health debug capture redacts
  token-shaped values and credential-looking keys and never receives request headers.
- **Input validation.** Dates must be real days, numbers must be numbers within bounds, strings are length-capped and
  stripped of control characters, enums are closed, unknown keys are dropped; per-day and per-request counts
  are capped (200 entries a day, 30 per request, 2,000 foods); the request body limit is 5 MB; photos are checked by
  their bytes (JPEG, PNG, WebP, GIF only, 3 MB). Barcodes are 8 to 14 digits; FatSecret ids are digits only.
- **Files.** Writes are temp-file, fsync, rename, directory fsync, with a per-profile queue; a profile file that does
  not parse is reported and **left untouched** instead of being replaced by an empty one.
- **AI paths.** Text only, no tools, the Coach's lockdown, an unprivileged user; one allowance per call, refunded only
  when the model never ran; nothing is written until the person accepts (see 13).
- **Photos.** Held in memory for the length of the call; the scratch directory receives nothing and is removed.

## Findings

### 1. Prototype pollution through food ids: **High**, sure (reproduced)

**Where.** `api/nutrition/routes.js`: `POST /api/nutrition/entries` (`d.foods[e.foodId]`, around the use-count update),
`PUT /api/nutrition/foods?id=` (`const f = d.foods[id]; … Object.assign(f, patch)`), and the same lookup pattern in
`resolveFood`, the stack check, and `DELETE /foods`. `d.foods` is a plain object parsed from JSON, so
`d.foods['__proto__']` is `Object.prototype` and `d.foods['constructor']` is `Object`.

**What I did.** In a throw-away data folder, as an ordinary signed-in profile:
- `POST /api/nutrition/entries` with `foodId: "__proto__"` answered 201 and left `({}).useCount === 1` and
  `({}).lastUsed` set, **on every object in the process**.
- `PUT /api/nutrition/foods?id=__proto__` with `{favorite: true}` answered 200 and left `({}).favorite === true`.
- A `foodId` of `"constructor"` produces a 500 instead.

**Impact.** Any signed-in person can set `favorite` (to true or false, their choice), `useCount` and `lastUsed` on **all**
objects until the process restarts. For example, every food that has no `favorite` field then reads as a favourite for
**every profile**, and any other code that reads those property names on an object that lacks them is affected too.
The validators limit which properties can be planted to those three, so I found no route to code execution or to
another profile's data; that is why this is High and not Critical. It is still a one-request, cross-profile integrity
and reliability problem.

**Fix (proposed).** (a) Validate every id that comes from a request against `/^[A-Za-z0-9_-]{1,40}$/` and reject
`__proto__`, `constructor` and `prototype` explicitly; (b) look foods up with `Object.hasOwn(d.foods, id) ? d.foods[id] : undefined`
(or create `d.foods` and `d.days` with `Object.create(null)` when reading); (c) add a regression test per route;
(d) as defence in depth, run the api with `node --disable-proto=delete`. Restarting the api clears an existing pollution.

### 2. No server-wide budget for USDA: **Medium**, medium sure

USDA FoodData Central is called with one shared key. Requests are limited to 40 lookups a minute **per profile**, but not
per server. One normal search now asks USDA **three** times (reference, branded, mixed dishes), so one profile can
make about 120 USDA requests a minute. `POST /api/nutrition/micros/match` does up to 12 USDA searches (and
more for brands) **before** it reserves an AI analysis, so repeated calls cost the caller no allowance. USDA documents a
per-key hourly limit (I believe 1,000 requests an hour, **unverified**); once it is hit, USDA search fails for everyone
until the hour rolls over (the app shows "rate-limiting", correctly). FatSecret already has a server-wide and per-profile
daily budget; USDA has none.

**Fix.** Add the same kind of persisted counter as `fatsecret-usage.json` for USDA (for example 900 an hour for the
server, 200 for a profile), count the stand-in search and detail fetches, and make `micros/match` count a call
against the profile's lookup limit once per entry searched. Send the key in the `X-Api-Key` header (see 7).

### 3. Unbounded growth and no write rate limit: **Medium**, medium sure

A profile may hold at most 200 entries **per day**, but there is **no limit on the number of days** (dates from 2000
to 2100 are accepted), and mutating routes have no rate limit (only searches, the AI and the Health token do).
Every change reads, parses, re-serialises and rewrites the **whole profile file synchronously**. A signed-in
client that loops `POST /entries` (30 entries a request) across many dates can grow its file to tens of
megabytes and make each request, and therefore every other request, slow: the api is a single Node process, so the event loop is
shared by all profiles. I did not load-test this.

**Fix.** Cap total entries per profile (for example 50,000) and days per profile (for example 5,500), cap the file size
before writing, add a per-profile write limiter (for example 120 mutations a minute) using the existing `createWindow`,
and consider moving a profile's days to one file per month if profiles grow.

### 4. A damaged `config.json` turns into "empty": **Medium**, sure (code read)

`config.js` `readStored()` returns `{}` when the file cannot be parsed. `load()` then reports defaults (Nutrition on,
30 AI analyses, no keys) and `save()` builds its next version from that, so the next admin save **erases the stored
encrypted USDA and FatSecret keys** and any switch. The profile files do not have this problem (they refuse to load).
It needs a corrupt file first (unclean shutdown on a filesystem without fsync, a manual edit, a disk problem), so it is rare.

**Fix.** Mirror the profile store: if the file exists but does not parse, throw a "config damaged" error, answer
the admin routes with 500 and a message, and never overwrite the file. Keep one `config.json.bak` of the last good version.

### 5. AGPL: the "Source code" link: **Medium**, medium sure

openGym is AGPL-3.0-or-later. Section 13 requires that people who use a **modified** version over a network can get
that version's source. Settings shows a "Source code" link to `github.com/DuarteSantos8/openGym` (upstream),
which does not contain this fork's changes. If anyone other than you uses the server, change that link (and
the `NOTICE.md` pointers) to `github.com/aethernet404/opengymandnutrition`. The fork's source being public already
satisfies the other half. I am not a lawyer; this is a flag, not advice.

### 6. Open Food Facts usage: **Low**, low sure

Open Food Facts asks API users to keep to modest rates (their guidance is on the order of 10 searches a minute and 100
product lookups a minute per client, **unverified**) and to send an identifying User-Agent, which the app does
(`openGym-nutrition (self-hosted)`). The app allows 40 lookups a minute per profile, all from one server address, and an
unlucky burst could get that address throttled or blocked, which would turn off search and barcodes. Add a small
server-wide limiter and rely on the existing 5-minute result cache. Attribution: results are labelled "Open Food Facts";
their data is under the Open Database Licence, which asks for attribution and share-alike **if you publish a derived
database**. The app keeps only the numbers a person logged, so I do not see a share-alike duty, but this is unverified.

### 7. USDA key in the URL: **Low**, medium sure

`lookup.js` calls `…/foods/search?api_key=<key>&…`. A query-string secret shows up in any proxy, egress log or error
message that records URLs. The code never logs URLs (errors are reduced to a kind and, for shape problems,
key names), so nothing leaks today, but one added log line or a debugging proxy would. USDA accepts the key in a header
(`X-Api-Key`, **unverified**); use that.

### 8. AI error text in the log: **Low**, medium sure

`routes.js` `aiFail` writes up to 200 characters of the runtime's error output (`stderr`) to the server log. That text
comes from the Claude runtime and could include account or request details. Log the failure class only, or run it
through the same sanitiser FatSecret messages use.

### 9. Health debug capture: **Low**, sure

When an admin switches the option on, the shape of the last Health Auto Export payload, **with one example value per
metric** (for example a weight or calorie figure), is kept in memory for one hour and shown to admins. It is opt-in, off
by default, memory-only and redacted for credentials, but it is a window into one user's health numbers for an admin.
Keep it off unless diagnosing; consider blanking numeric examples.

### 10. One Claude account, several profiles: **Low**, low sure

AI logging uses the Coach's `claude setup-token` token. The Coach already refuses to use one token for a different
profile ("one-account rule"), which limits this, but if several people share one owner's subscription through
the server, check Anthropic's current terms for that credential type. Not verified.

### 11. New dependency and its licence: **Low**, medium sure

`frontend/package.json` gained **`zxing-wasm`** (barcode reading from a photo). It conflicts with the project's
"dependency-light" rule and I did not verify its licence terms (it wraps the zxing-cpp library, which I believe is
Apache-2.0; confirm). The api has no new dependencies.

### 12. Leftovers and backups: **Low**, sure

Deleting a profile removes its nutrition file but not its entry in `health-tokens.json` (the token is dead anyway:
the gate checks the profile is active and drops the entry on first use) or its counters in `fatsecret-usage.json`
(cleared at midnight UTC). There is no automatic backup of `data/`, and a profile file that becomes damaged is
protected but not repaired: that profile's nutrition screens return an error until an operator restores the file.
Consider a nightly copy of `data/nutrition/` on the server and a one-line note in the docs (done in `NUTRITION_OVERVIEW.md`).

### 13. AI paths and prompt injection: **Info**, sure

- **What can reach the model:** food names, brand names, amounts, calories and macros of the person's own entries
  (stand-in matching), or the person's photo and note / description (meal estimate). Names can originate in third-party
  databases (a product named "ignore previous instructions…") so a hostile *name* can reach the prompt.
- **What can come back:** the stand-in answer is reduced by `validateMatches` to `id`, an `fdc_id` that must be one of
  **that entry's candidate ids**, a confidence from a closed list, and a reason of at most 160 characters. Everything
  else, numbers included, is dropped; the nutrient numbers are always fetched from USDA by the server and scaled by it. The
  meal-estimate answer passes `validateMeal` (bounded numbers, closed confidence, item and length caps). The model has
  no tools and no filesystem access.
- **Worst case:** a manipulated name steers the model to a different candidate (a wrong stand-in), or makes it write a
  misleading *reason* line. The person sees the stand-in, its data type and the numbers before accepting, and the
  reason is rendered as text (React escapes it). Nothing is written without an Accept. Residual risk: low.
- **Suggested hardening (optional):** show the reason with a "written by the AI" label, and drop reasons that contain a URL.

### 14. When something is down

| Dependency | What happens | Gap |
|---|---|---|
| Open Food Facts | Search shows a named banner with Retry; other sources still answer; barcode says "error, try again"; one retry on timeout. Slow (3 to 8 s) is normal. | none |
| USDA | Banner and Retry; with no key the source is off and says so; the stand-in fill-in answers "USDA could not be searched" and spends no AI allowance. A rate limit is shown as one. | see 2 |
| FatSecret | Named failures by FatSecret's code (missing scope, bad keys, IP not registered, rate limit, down, timeout), no automatic retry except one for timeouts; the other sources are unaffected; the daily budget stops calls before FatSecret does. | none |
| Claude runtime | AI actions answer with a plain message and **refund** the allowance when the model never ran (no runtime, rejected credential, provider error); a timeout or unreadable answer stays counted; one analysis per profile at a time, two at a time on the server. | a hung runtime holds a slot until its 90 s budget ends |
| The disk / a damaged profile file | The profile's routes answer 500 with "damaged; left untouched" and the file is not overwritten. | see 4 and 12 |
| Internet from the server | Everything that is a lookup fails with a named banner; the diary, My foods and goals keep working because they are local. | none |

## Where an abusive client could do harm (a signed-in one)

1. **Pollute the process (finding 1)**, until restart.
2. **Use up the shared USDA key (2)** or get the server's address throttled by Open Food Facts (6); FatSecret is protected by its budget.
3. **Bloat its own file and slow the single process for everyone (3).**
4. **Burn the AI allowance:** limited to the per-profile daily cap (default 30) and one analysis at a time, so the harm is bounded by one profile's cap times the number of profiles.
5. A wrong Health token only locks out its own address (ten free tries, then minutes, doubling up to an hour).
An **unauthenticated** client can reach only: the login routes (upstream's own), the two Health ingest routes (which answer 401, and count a failure against the address), and the public health check.

## The three fixes to make first

1. **Finding 1** (prototype pollution): small, mechanical, and the only finding that can affect other profiles.
2. **Finding 3 + 2** (write limiter, size and day caps, a USDA budget): protects the single process and the shared key from one user.
3. **Finding 4 + 5** (do not treat a damaged `config.json` as empty; point the Source-code link at the fork): cheap and removes one data-loss path and one licence gap.
