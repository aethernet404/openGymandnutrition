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
   says whether the keys work and whether this edition includes barcode lookup.

The secret is stored encrypted (the same way as the USDA key and the Coach's credentials), is never returned to
any screen after saving (only the last four characters of the Client ID are shown), and is never written to a log.
**Remove keys** turns the source off.

## What was verified in FatSecret's documentation, and what was not

FatSecret's documentation site (platform.fatsecret.com) could not be opened from where this was built, so what is
below comes from search-engine excerpts of their pages, their blog, and third-party client libraries. Anything
marked *unverified* is a best reading and is written defensively; the admin Test button and the first real search
settle most of it.

| | Status |
|---|---|
| **Authentication**: OAuth 2.0 client credentials; `POST https://oauth.fatsecret.com/connect/token`, Client ID and Secret as HTTP Basic credentials, body `grant_type=client_credentials&scope=basic`; the answer has `access_token` and `expires_in` (a day in their example); calls carry `Authorization: Bearer …`. Scopes include `basic`, `premier`, `barcode`, `localization`, `nlp`, `image-recognition`, `feedback`. | seen in their OAuth 2.0 guide |
| **Search**: `GET https://platform.fatsecret.com/rest/foods/search/v4` with `search_expression`, `max_results` (at most 50), `page_number` (zero-based), `format=json`. v4 returns each food with its servings, including standardised 100 g ones (`serving_id` 0) for brand foods. | path, parameters and the servings change seen in their docs and blog |
| **Food detail**: `GET …/rest/food/v5?food_id=…` | seen; only used for a barcode answer that is just an id |
| **Servings and fields**: `food_id`, `food_name`, `food_type` (Brand/Generic), `brand_name`, `servings.serving[]` with `serving_id`, `serving_description`, `metric_serving_amount`, `metric_serving_unit`, `calories`, `carbohydrate`, `protein`, `fat`; one-item lists arrive as a single object | field names from a community client; **unverified** against the official v4 page. Read defensively. |
| **Barcode**: `food.find_id_for_barcode` (v1 returns an id, v2 the whole food), GTIN-13, shorter codes zero-padded | the method exists; third-party docs say it is a **Premier** feature. **Unverified whether Basic includes it.** The REST path used (`…/food/barcode/find-by-id/v2`, scope `barcode`) is a guess from the pattern of the other paths. openGym tries it only for codes Open Food Facts does not know and, if FatSecret refuses the plan, remembers that for an hour and says so. |
| **Basic limits**: 5,000 calls a day, US dataset only, English only, community support | seen on their editions page |
| **IP registration**: calls from an unregistered IP are refused (error code 21, "Invalid IP address detected …") | from a FatSecret staff reply on their developer forum, not from the official docs |
| **Attribution**: required for Basic; their policy asks for a badge or snippet in the app, on the app's website and in store listings; login-only apps need it somewhere reachable without logging in | policy page excerpt. **The exact snippet or badge was not seen**; openGym shows the text "Powered by fatsecret" as a link to https://www.fatsecret.com wherever their results appear. Check <https://platform.fatsecret.com/attribution> and tell us if a badge image is required. |
| **Caching / storing**: user data may not be cached for more than 24 hours, except values explicitly "storable indefinitely"; per their Storable Data guide that is the ids (`food_id`, `serving_id`, …), not names, brands or nutrition numbers | seen in their Storable Data guide excerpt |
| **Error codes** other than 21 (rate limit, bad token, plan) | **unverified**; mapped by code and by message wording, unknown ones become "sent something unreadable" |

## What openGym does about the terms

* **Caching.** Search results are kept in memory for 10 minutes only and never written to disk. The OAuth token is
  kept in memory until a minute before it expires. A food logged from FatSecret appears in **Recent** for 24 hours
  and is then removed (it cannot be starred). The numbers in a **diary entry** are the person's own record of what
  they ate and stay: that is the one place where FatSecret's wording ("only ids may be stored") could be read more
  strictly than we have. If you want the strict reading, say so and FatSecret entries will keep only the food's
  name and the logged numbers you type, or be re-fetched on view.
* **Privacy.** FatSecret receives the search words or the barcode digits and the app's token, nothing else: no
  profile, no diary, no IP of a phone. What is saved from a FatSecret food is the same snapshot as for the other
  sources: name, brand, serving label, grams and the macros.
* **Budget.** The server stops at **4,000 calls a day** (never configurable above 5,000) and each person at
  **400 a day**, counted in `data/nutrition/fatsecret-usage.json` (so a restart does not reset it) per UTC day.
  Environment variables `NUTRITION_FATSECRET_DAILY_CAP` and `NUTRITION_FATSECRET_USER_CAP` change them. A search
  that comes from the 10-minute cache costs no call. A message names the limit that was reached.
* **Errors.** Wrong keys, a refused IP address, rate limits, timeouts and an outage are each named in a line under
  the search; a timeout or outage has a Retry, the others do not (asking again cannot help). One automatic retry is
  made for timeouts and outages. The server log gets one short line a minute per reason (kind and FatSecret's error
  code), never a key, token, address or search text.

## Outbound hosts the server must reach

* `oauth.fatsecret.com:443` (the token)
* `platform.fatsecret.com:443` (the API)

Both are in addition to `world.openfoodfacts.org` and `api.nal.usda.gov`. Environment variables
`NUTRITION_FATSECRET_TOKEN_URL` and `NUTRITION_FATSECRET_BASE` can point them elsewhere (tests, a proxy).
