# Apple Health, from the Health Auto Export app

[Health Auto Export – JSON+CSV](https://apps.apple.com/app/health-auto-export-json-csv/id1115567069)
(by Lybron Sobers; written against version 10.0.4) can read Apple Health on your iPhone and POST it to a
web address on a schedule. openGym has an address for exactly that, so there is nothing to build: no
Shortcut, no native app, nothing leaves your own server.

On the diary you then see **Eaten**, **Burned** (active + resting energy) and **Net**, plus the day's
**workouts**, **exercise minutes**, and your latest **weight** with a 30-day line.

> **Honest note on cost.** Automatic background syncing in Health Auto Export (the *Sync Cadence*
> automation) is a **premium feature** of that app: a paid subscription inside it. You told us you saw a
> **$6.99 yearly** option; we could not verify the current price or what the free tier includes, so check
> the app's own paywall. Without the subscription you can still tap **Manual Export** whenever you want
> fresh numbers. If that is not worth it, the [Shortcut](NUTRITION_APPLE_HEALTH.md) is the free route.

## 1. Make a token

openGym → **Nutrition → Goals → Apple Health → Make a token**. It is shown once; copy the **header value**
(`Bearer ogh_…`). It is the same token the Shortcut route uses, and it can do one thing: send these
numbers. It cannot read anything, and no other route of openGym accepts it.

## 2. The address

```
POST https://YOUR-SERVER/api/nutrition/health/hae
Authorization: Bearer ogh_<your token>
Content-Type: application/json
```

The Apple Health screen shows the exact address for your server (with a sub-path if you use one).

## 3. Set up the automation

In Health Auto Export:

1. **Automations → + → REST API.**
2. **URL:** the address above.
3. **Headers:** add `Authorization` with the value `Bearer ogh_…` (the header value you copied).
4. **Data Type:** Health Metrics. **Export Format:** JSON. **Export Version:** v2.
5. **Metrics** — turn these on: **Active Energy, Resting Energy, Steps, Exercise Minutes, Weight**.
   Turn on **Include Workouts** (or add a second automation with Data Type *Workouts*, same URL and header).
   Leave everything else off; anything else is ignored anyway.
6. **Date Range:** Today. **Time Grouping:** Days, with **Summarize Data** on.
7. **Sync Cadence:** every hour is plenty (premium — see the note above).
8. Tap **Manual Export** once. The diary shows the numbers a moment later.

### What openGym does with it

| From the app | What happens |
|---|---|
| Active Energy, Resting Energy | Stored per day. **Burned = active + resting.** kJ is converted to kcal. |
| Steps | Stored per day. |
| Workouts | Per day: name, start time, duration, active energy (kJ → kcal), distance if present. **Display only.** |
| Exercise Minutes | The day's total, shown next to the workouts. |
| Weight | One reading per date, stored in kg and shown in your own unit (kg or lb), with the last 30 days as a small line. |
| Anything else (stand hours/minutes, flights climbed, move minutes, physical effort, activity summary, symptoms, dietary nutrition…) | **Ignored and never stored.** Nutrition from Health is deliberately not imported: you log food here, and it would count twice. |

**Workout calories are never added to Burned or Net.** They are already part of Active Energy, so adding
them would count the same calories twice. They are shown for reading only.

* The day a reading belongs to is the date **written in the payload**, at the offset the app attached:
  your phone's own local day.
* Sending the same day again **replaces** that day's numbers, workouts and minutes; it never adds. A
  payload sent twice cannot count twice.
* If the app sends several points in a day (hourly, say) they are summed. With *Summarize Data* on there is
  one total per day.
* A partial export (it starts partway through the day, e.g. "since last sync") never *lowers* numbers
  already stored; the answer says `kept`. Set Date Range to Today to avoid it.
* Energy of 0 and 0 is refused (Health returned nothing). Absurd numbers, text instead of numbers and bad
  dates are refused field by field: a problem in one part never stops the others being stored.
* Bounds: active ≤ 10,000 kcal, resting ≤ 6,000, steps ≤ 200,000, a workout ≤ 24 h / 10,000 kcal /
  1,000 km, exercise ≤ 1,440 min, weight 20–500 kg, at most 20 workouts per day, at most 366 weight
  readings kept, days older than 60 days or in the future refused.

## 4. A sample payload

This is the shape the app sends, and what you can post with `curl` to test the server:

```json
{
  "data": {
    "metrics": [
      { "name": "active_energy", "units": "kcal", "data": [ { "date": "2026-10-13 00:00:00 +0100", "qty": 612.4, "source": "" } ] },
      { "name": "basal_energy_burned", "units": "kcal", "data": [ { "date": "2026-10-13 00:00:00 +0100", "qty": 1710, "source": "" } ] },
      { "name": "step_count", "units": "count", "data": [ { "date": "2026-10-13 00:00:00 +0100", "qty": 9120, "source": "" } ] },
      { "name": "apple_exercise_time", "units": "min", "data": [ { "date": "2026-10-13 00:00:00 +0100", "qty": 52 } ] },
      { "name": "weight_body_mass", "units": "kg", "data": [ { "date": "2026-10-13 07:10:00 +0100", "qty": 79.8 } ] },
      { "name": "apple_stand_hour", "units": "hr", "data": [ { "date": "2026-10-13 00:00:00 +0100", "qty": 9 } ] }
    ],
    "workouts": [
      { "id": "A1B2", "name": "Traditional Strength Training", "start": "2026-10-13 18:30:00 +0100", "end": "2026-10-13 19:15:00 +0100", "duration": 2700, "activeEnergyBurned": { "qty": 320, "units": "kcal" } },
      { "id": "C3D4", "name": "Running", "start": "2026-10-13 07:05:00 +0100", "end": "2026-10-13 07:35:00 +0100", "duration": 1805, "activeEnergyBurned": { "qty": 1046, "units": "kJ" }, "distance": { "qty": 5.2, "units": "km" } }
    ]
  }
}
```

```
curl -sS -X POST https://YOUR-SERVER/api/nutrition/health/hae \
  -H "Authorization: Bearer ogh_YOUR_TOKEN" -H "Content-Type: application/json" \
  --data @payload.json
```

(Change the dates to today: days older than 60 days are refused.)

A good answer: `{"ok":true,"days":[{"date":…,"burned_kcal":2322.4,"action":"stored"}],"activity":[…],"weights":[…],…}`.
A wrong shape is a `400` whose `error` names the problem and what was expected.

## 5. What was verified and what was not

Health Auto Export's own documentation could not be reached while this was written. The format is taken
from two open-source receivers for the app's REST API and a bug report against v10.0.4. **Relied on:**

* the body `{ "data": { "metrics": [ { "name", "units", "data": [ { "date", "qty", "source" } ] } ], "workouts": [ … ] } }`;
* the metric names `active_energy`, `basal_energy_burned`, `step_count`, and (**not** confirmed from a real
  payload) `apple_exercise_time`, `weight_body_mass`; display-name spellings (`resting_energy`, `steps`,
  `exercise_time`, `body_mass`, …) are also accepted;
* the `units` string of each metric (a point may override it): `kcal` or `kJ`; `count`; `min`; `kg` or `lb`;
* for workouts: `name`, `start`, `duration` (seconds), `activeEnergyBurned` `{qty, units}` (`activeEnergy` is
  accepted too), `distance` `{qty, units}`;
* dates like `2026-10-13 14:05:00 +0100` (ISO and 12-hour forms also read).

**Not verified:** whether the app sends zero-valued intervals; whether raw samples from several sources
(iPhone + Watch) are already de-duplicated (a warning is returned when several sources add up); the exact
unit strings; the workout field names beyond those above; the app's menu wording. A wrong guess here shows
up as a clear message, not as wrong numbers: unknown units skip that extra with a warning, and an
unrecognised shape is a `400`.

### The admin debug option

An admin can settle all of that from the real thing: **Nutrition → Goals → Health Auto Export debug**
(admin only, **off by default**). When on, the *shape* of the last payload — key names and one example item
per metric, with long text cut, and never any token — plus what openGym made of it, is kept **in memory
only** for one hour, then forgotten. Switch it off and it is wiped at once. Tap **Manual Export**, then
**Refresh**.

## Security notes

* The token is shown once; only its SHA-256 is stored; neither it nor the numbers are logged.
* It is accepted by the two ingest routes only (`/api/nutrition/health` and `/api/nutrition/health/hae`).
* Wrong tokens lock the caller's address for minutes; a right token is limited to 60 requests an hour.
* Data lives in your own `data/nutrition/<you>.json`, written safely (temp file, then rename).
