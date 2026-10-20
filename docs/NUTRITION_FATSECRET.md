# FatSecret as a third food source

The nutrition search asks Open Food Facts, USDA FoodData Central and, once an admin has added keys,
the **FatSecret Platform API** (free *Basic* edition) in parallel. FatSecret is the one that has restaurant,
chain and convenience-store foods, for example "7-Eleven taquitos".

## Get the free keys (admin, once)

1. Sign up at <https://platform.fatsecret.com/> and choose the free **Basic** edition (US data, English,
   attribution required, 5,000 calls a day).
2. In the dashboard copy the **Client ID** and **Client Secret** of the REST API (OAuth 2.0) pair.
3. **Register this server's public IP address** in the dashboard (IP Restrictions). FatSecret only answers
   requests from addresses you list; the address is the one your home connection shows to the internet
   (`curl ifconfig.me` from the server). If your ISP changes it, update it there. Until it is registered every
   call fails with "FatSecret refused this server's IP address".
4. openGym → Nutrition → Goals → **FatSecret food search**: paste both, **Save**, then **Test keys**. The test
   shows the token, the scopes it grants and a tiny search. Barcode lookup is not part of Basic.

The secret is stored encrypted (the same way as the USDA key and the Coach's credentials), is never returned to
any screen after saving (only the last four characters of the Client ID are shown), and is never written to a log.
**Remove keys** turns the source off.

## What the free Basic key can do (and what it cannot)

The admin card and this page follow FatSecret's own pages (platform.fatsecret.com/docs: the method pages and
the error-codes guide). The first version of this feature called `foods.search v4`, which carries FatSecret's
**Premier Exclusive** badge (scope `premier`). A Basic key gets **error code 14, "OAuth 2.0: Missing scope"**
for it, inside an HTTP 200 answer; the app then called that a rate limit, which was wrong. Both are fixed.

| | What openGym uses |
|---|---|
| **Token** | `POST https://oauth.fatsecret.com/connect/token`, Client ID and Secret as HTTP Basic, body `grant_type=client_credentials&scope=basic`. The token is a JWT; the admin Test button reads its `scope` claim (only that) to show what was granted. The token itself is never shown or logged. |
| **Search** | `GET https://platform.fatsecret.com/rest/foods/search/v1?search_expression=…&max_results=…&page_number=…&format=json`, scope `basic`. No Premier parameter is ever sent (`generic_description`, `region`, `language`, `include_food_images`, `include_food_attributes`, `flag_default_serving`, `include_sub_categories`). One result arrives as an object, several as an array, none with no `food` key; all three are handled. |
| **What a search row holds** | name, brand, Brand/Generic and one summary line: `Per 1 serving - Calories: 300kcal \| Fat: 13.00g \| Carbs: 32.00g \| Protein: 15.00g` (or `Per 100g - …`). That is all the list shows: one line of calories and macros. |
| **Details** | When a result is tapped, `GET …/rest/food/v5?food_id=…&format=json` (scope `basic`) returns every serving with its nutrients, including the standardised 100 g one (`serving_id` 0). If it fails, the summary serving still works and the app says why the others are missing. |
| **Barcode** | **Not available on Basic** (`food.find_id_for_barcode` is Premier Exclusive, scope `premier barcode`). openGym no longer asks FatSecret for barcodes. Open Food Facts stays the barcode source. |
| **Limits** | 5,000 calls a day, US data, English. |
| **Attribution** | required; openGym shows "Powered by fatsecret" as a link to https://www.fatsecret.com wherever results appear. |
| **Storable data** | only ids may be stored; other data may be cached up to 24 hours (see below). |

### Error codes, by their documented code only

| Code | Meaning (FatSecret) | What openGym says / does |
|---|---|---|
| **14** | OAuth 2.0: Missing scope | "Your FatSecret key does not include this feature; the free Basic edition has no access to it." Never retried. |
| **13** | Invalid token | a new token is fetched and the call repeated **once**; refused again → named, not retried |
| **21** | Invalid IP address | "register the server's public IP address"; the echoed address is never shown or logged. Never retried. |
| **11, 12** | rate limits (per FatSecret’s error-codes guide) | the only codes called a rate limit (plus HTTP 429); never retried |
| other | anything else | "FatSecret answered with an error (code N): <sanitised message>", never retried, never called a rate limit |

The message FatSecret sends is cleaned before it is shown: control characters removed, addresses replaced by
`[address]`, token-like strings by `[hidden]`, at most 160 characters. The admin card shows the last problem with
its code, and the (admin-only) debug capture records the same.

### The Test button

**Test keys** requests a token, reads the granted scopes from it, then runs one tiny search (`apple`,
`max_results=1`). It shows: token OK (or why not), the scopes granted, and search OK (or the exact FatSecret code,
its message and what it means). **Test presses are not counted against the daily budget.**

### Later option: Premier Free

FatSecret has a free **Premier Free** tier for start-ups, non-profits and students (it needs verification and
attribution). It could unlock the Premier features (richer search, barcode) later. openGym does not need it and
nothing here depends on it.

## What openGym does about the terms

* **Caching.** Search results and tapped-food details are kept in memory for 10 minutes only and never written to disk. The OAuth token is
  kept in memory until a minute before it expires. A food logged from FatSecret appears in **Recent** for 24 hours
  and is then removed (it cannot be starred). The numbers in a **diary entry** are the person's own record of what
  they ate and stay: that is the one place where FatSecret's wording ("only ids may be stored") could be read more
  strictly than we have. If you want the strict reading, say so and FatSecret entries will keep only the food's
  name and the logged numbers you type, or be re-fetched on view.
* **Privacy.** FatSecret receives the search words or the tapped food's id and the app's token, nothing else: no
  profile, no diary, no IP of a phone. What is saved from a FatSecret food is the same snapshot as for the other
  sources: name, brand, serving label, grams and the macros.
* **Budget.** The server stops at **4,000 calls a day** (never configurable above 5,000) and each person at
  **400 a day**, counted in `data/nutrition/fatsecret-usage.json` (so a restart does not reset it) per UTC day.
  Environment variables `NUTRITION_FATSECRET_DAILY_CAP` and `NUTRITION_FATSECRET_USER_CAP` change them. A search or
  a tapped food (food.get) costs one call each; one from the 10-minute cache costs none. A message names the limit that was reached.
* **Errors.** Wrong keys, a missing scope, a refused IP address, rate limits, timeouts and an outage are each named in a
  line under the search; a timeout or outage has a Retry, the others do not (asking again cannot help). One
  automatic retry is made for timeouts and outages only. The server log gets one short line a minute per reason (kind and FatSecret's error
  code), never a key, token, address or search text.

## Outbound hosts the server must reach

* `oauth.fatsecret.com:443` (the token)
* `platform.fatsecret.com:443` (the API)

Both are in addition to `world.openfoodfacts.org` and `api.nal.usda.gov`. Environment variables
`NUTRITION_FATSECRET_TOKEN_URL` and `NUTRITION_FATSECRET_BASE` can point them elsewhere (tests, a proxy).
