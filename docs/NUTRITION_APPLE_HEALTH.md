# Apple Health calories, from an iOS Shortcut

A web page cannot read Apple Health. A **Shortcut** on your iPhone can: it reads today's **Active
Energy** and **Resting Energy** (and, if you like, **Steps**) and sends them to your openGym server
over HTTPS. Nothing else is involved — no native app, no paid service, nothing leaves your own
server.

On the diary you then see **Eaten**, **Burned** (active + resting) and **Net** (eaten − burned) for
the day, with the time they last arrived.

> Don't want to build a Shortcut? The iPhone app Health Auto Export can send the same numbers (plus
> workouts and weight) with no building: see [NUTRITION_HEALTH_AUTO_EXPORT.md](NUTRITION_HEALTH_AUTO_EXPORT.md).

## 1. Make a token

openGym → **Nutrition → Goals → Apple Health → Make a token**.

* It is shown **once**. Copy the **header value** (`Bearer ogh_…`) into a note for the next step.
* The server stores only a hash of it. Lose it and you simply make a new one (the old one stops
  working at once). **Revoke** removes it.
* The token works for **one thing**: sending these numbers to the address below. It cannot read
  anything, and no other part of openGym accepts it.

## 2. The address and the data

```
POST https://YOUR-SERVER/api/nutrition/health
Authorization: Bearer ogh_<your token>
Content-Type: application/json
```

If openGym is served from a sub-path (`https://example.com/gym/`), the address is
`https://example.com/gym/api/nutrition/health`. The Apple Health screen shows the exact address for
your install.

```json
{
  "date": "2026-10-13",
  "active_kcal": 512,
  "resting_kcal": 1650,
  "steps": 8432
}
```

| Field | Type | Rules |
| --- | --- | --- |
| `date` | text, `yyyy-MM-dd` | the **iPhone's** local day; from 60 days ago to tomorrow |
| `active_kcal` | **number** | 0 – 10 000. Not text: in the Shortcut set the field type to *Number* |
| `resting_kcal` | **number** | 0 – 6 000 |
| `steps` | whole number, optional | 0 – 200 000 |

Sending the same `date` again **replaces** that day's numbers (the Shortcut always sends the day
so far, so running it often is harmless). Both energy values at `0` is refused — that is what a
locked iPhone reads, and storing it would wipe a good reading.

The answer: `{"ok":true,"date":"…","active_kcal":512,"resting_kcal":1650,"steps":8432,"burned_kcal":2162,"replaced":false,"updatedAt":…}`.
Errors are `400` (what is wrong, with the `field`), `401` (token wrong, revoked or replaced),
`429` (too many tries — wrong tokens lock the sender's address for a while, a good token is limited
to 60 posts an hour), `503` (an admin switched Nutrition off).

### Test it before building the Shortcut

```bash
curl -sS -X POST https://YOUR-SERVER/api/nutrition/health \
  -H "Authorization: Bearer ogh_YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"date":"'"$(date +%F)"'","active_kcal":512,"resting_kcal":1650,"steps":8432}'
```

Then open the diary: today shows Burned 2,162, with "Updated" a moment ago.

## 3. Build the Shortcut

Shortcuts app → **+** → name it **Send Health to openGym**. Then add these actions in order:

1. **Find Health Samples** — *Type* is **Active Energy**, *Start Date* is **today**. (Tap *Show More* to
   set the filter.)
2. **Calculate Statistics** — *Sum* of the Health Samples. This is the day's active total.
3. Repeat 1–2 for **Resting Energy**. Optional: once more for **Steps**.
4. **Current Date**, then **Format Date** with *Date Format* **Custom** and the format `yyyy-MM-dd`.
5. **If** *Active total* **is** `0` and *Resting total* **is** `0` → **Show Notification** "No Health
   data (is the iPhone locked?)" → **Stop This Shortcut**. (Otherwise it would post zeros.)
6. **Get Contents of URL**:
   * URL: `https://YOUR-SERVER/api/nutrition/health`
   * Method: **POST**
   * Headers: **Authorization** = `Bearer ogh_…` (paste the header value from step 1)
   * Request Body: **JSON**, with fields
     * `date` — *Text* — the formatted date
     * `active_kcal` — **Number** — the active total
     * `resting_kcal` — **Number** — the resting total
     * `steps` — **Number** — optional
7. **Show Notification** (or **Show Result**) with the *Contents of URL* so you can see `"ok": true` or
   the error.

**Units:** the numbers must be **kilocalories**. If your Health app shows Active Energy in kJ
(Health → Browse → Active Energy → Unit), switch it to **kcal**, or the numbers will be about four
times too large.

### Permissions

The first run asks, once each, to allow the Shortcut to read **Active Energy**, **Resting Energy**
(and **Steps**) from Health, and to send data to your server's domain. Choose **Allow**. If you
tapped *Don't Allow*, fix it under Settings → Health → Data Access & Devices → Shortcuts.

## 4. Run it

* **A button on the Home Screen (the reliable way):** open the Shortcut → ⓘ → **Add to Home Screen**.
  Tap it whenever you want the diary to catch up.
* **Automatically, a few times a day (best effort):** Shortcuts → **Automation** → **+** → **Time of
  Day** (say 12:00, 18:00 and 23:30) → **Run Immediately** → choose the Shortcut → turn off *Notify
  When Run*.

### How reliable are the automations?

Honestly: not perfectly. iOS keeps Health data locked while the iPhone is locked, so an automation
that fires then may read nothing — which is why step 5 stops instead of posting zeros. Automations
can also be skipped in Low Power Mode or if the phone is off, and an Apple Watch writes to Health a
little after the fact. Because every run sends the whole day so far, a missed run costs nothing —
the next one (or a tap on the Home Screen button) catches up. Treat the automations as a
convenience and the button as the guarantee.

## Behind Cloudflare, invite-only and so on

Nothing special is needed. The request is an ordinary HTTPS POST to the same address as the app, so
it works through a Cloudflare tunnel (without Cloudflare Access in front of the path), with
`INVITE_ONLY` on and guest mode off — those only govern sign-up. The token does not depend on a
cookie or a browser.

## The "eat back" option

Off by default. **Nutrition → Goals → Apple Health → Eat back** adds a chosen percentage of the day's
**active** calories (never resting) to that day's calorie goal. When it is on, the diary shows the
adjusted goal and exactly what was added ("Goal 2,400 + 320 (50% of active calories)"). It is a
bookkeeping option for people who want their goal to move with their activity, nothing more.

## Security notes

* The token authenticates exactly one route and can only write these four numbers for a day.
* Only a SHA-256 hash is stored, in `data/nutrition/health-tokens.json`; the token itself is never
  logged, returned again, or stored.
* Wrong tokens lock the sender's address (ten free tries, then minutes, doubling up to an hour).
* Revoking the token, making a new one, disabling the profile or deleting it all end the old token at
  once.
