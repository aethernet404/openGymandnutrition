# Reading labels from photos, and supplement barcodes

What it does: a Nutrition Facts or Supplement Facts label, photographed (1 to 4 photos: the camera, or several from the
library at once), is read by the AI into an editable review. Nothing is saved until a button on the review is pressed.
Code: `api/nutrition/label.js` (engine), `dsld.js` + `lookup.js` (NIH database), `routes.js`; app: `frontend/src/nutrition/LabelFlow.jsx`,
`labelPhotos.js`, `labelForm.js`, `SupplementAdd.jsx`.

## Where it is
* **Add food → Scan a label** (next to Photo and Describe). Optional barcode photo; saves into My foods with the barcode.
* **Food form and Edit entry → Read from label photos** fills the form (you still press Save).
* **Fill in micronutrients → Use label photos instead**: the label values go onto that entry as real label data
  (`microsSource: 'label'`, in `entry.micros`, the same place as database values), never as an estimate. Existing values are
  kept unless "Replace" is ticked for that nutrient.
* **Vitamins & supplements → New**: Scan barcode, Photo of the label, Search (NIH database), Manual.

## The photos
Each photo is shrunk on the device (long edge 1280 px, JPEG, EXIF orientation applied, location and camera data dropped by the
re-draw) and held in memory only. Together they must fit 3.3 MiB (nginx allows 5 MB; base64 adds a third): too big → every photo is
re-shrunk stepwise (1100, 960, 800 px), and if it still does not fit the app says so and the Read button stays off.
HEIC/HEIF: Safari opens them natively and they are converted like any photo; a browser that cannot decode them gets a plain message
(iPhone: Settings → Camera → Formats → Most Compatible, or share as JPEG). No decoder is bundled (no new dependency).

## The AI is a reader, not a source
One Claude call per reading (Coach Claude Agent SDK, images inline, no tools, same lockdown; no API key), one use of the nutrition
AI allowance, refunded if the model never ran. It returns structured text only (names, amounts, units, %DV, serving text, columns).
The server validates the shape, caps lengths and counts, strips markup and control characters, ignores unknown fields, maps names to
our 29 nutrients with a synonym table, converts units (IU for A/D/E, DFE, RAE, NE, g/mg/mcg, per 100 g to per serving when the serving
weight is known), refuses out-of-bounds values and flags rows that do not add up (calories vs macros, totals vs parts). Unreadable rows
stay unknown (never 0) and are highlighted. A label that says "ignore your instructions" changes nothing (test in `nutrition-label.test.js`).
**Other ingredients** are kept as a plain list, shown, and never counted in totals or upper-limit notes.

## Duplicates
Before saving, saved foods/supplements are checked by barcode and by name + brand (any case): Use the saved one, Update the saved one
with this label, or Save as a new one.

## Supplement barcode order
`GET /api/nutrition/barcode?code=…&kind=supplement` stops at the first hit: (1) your saved supplements (the barcode is stored with them),
(2) NIH DSLD, (3) Open Food Facts then USDA Branded, (4) nothing → "Photograph the label instead" (the barcode is kept). A source that
could not answer is listed in `tried`; "not found" is only said when every source that could answer said so.

## NIH DSLD: what was verified, and the limits we apply
Base `https://api.ods.od.nih.gov/dsld/v9`. The build environment could not reach the host, so the first client was written from the
API guide. It was then checked **live on 2026-10-21** (calls made from the home server) and corrected. What that showed:
* **No API key is needed.** No key error; every call answered 200. **No rate-limit headers** were visible (only an api-umbrella proxy
  header), so the real limit is unknown. We therefore apply our own caps (below).
* **Search hits (`GET /search-filter?q=`) carry no barcode.** The label detail (`GET /label/<id>`) has `upcSku`, `servingSizes`,
  `ingredientRows`, `fullName`, `brandName` and `offMarket`.
* **Barcodes are stored spaced**, e.g. label 1225 "Calcium With Vitamin D3" is `0 74312 76274 1`, label 179744 "Ultra Fish Oil 1400 mg" is
  `0 31604 02697 4` (a 12-digit UPC-A grouped 1-5-5-1).
* **Only the quoted, spaced query finds a label by barcode:** `q="0 31604 02697 4"` returns exactly label 179744. The bare digits
  (`031604026974`), quoted or not, return 0 hits; spaced but unquoted returns unrelated labels.

How the lookup works because of that (`dsld.upcQueries`, `lookup.dsldByUpc`):
1. Build the quoted candidates from the scanned digits, best first, at most **3 search calls**: 12 digits → spaced 1-5-5-1, then the plain
   quoted digits; 13 digits starting with 0 → the spaced form of its 12-digit UPC-A, then the plain quoted digits; other lengths → the plain
   quoted digits. Stop at the first candidate that returns hits.
2. Because hits carry no barcode, open the label of the top hits (at most **5**, on-market and newest first) and keep only those whose
   `upcSku`, with spaces and dashes removed, equals the scanned digits (a leading zero difference between UPC-A and EAN-13 is allowed).
   The newest label not marked off market wins; several versions of one barcode are handled.
3. Hits but no matching barcode → "NIH has similar products but not this barcode", then Open Food Facts / USDA, then the photo prompt.

Limits we apply: a scan costs at most 3 searches + 5 label reads (cached for a day when found, 10 minutes when not); server budget
`NUTRITION_DSLD_HOURLY_CAP` (300), `NUTRITION_DSLD_DAILY_CAP` (3000), `NUTRITION_DSLD_USER_HOURLY_CAP` (60) in `DATA_DIR/dsld-usage.json`;
`NUTRITION_DSLD_BASE` points at a mirror; timeouts with one retry; plain-word errors. Public domain; the app shows the NIH attribution
wherever DSLD data appears. A bulk index (the NIH download of ~215,000 labels) was **not** built. Re-check from a machine that can reach
the host with `node api/scripts/verify-dsld.mjs [UPC]`. Still unverified: the real rate limit.

## Routes
`POST /api/nutrition/label` (photos, hint), `POST /api/nutrition/micros/label` (`{date,id,micros,overwrite?}`), `GET /api/nutrition/barcode?kind=supplement`,
`GET /api/nutrition/supplements/search?q=`, `GET /api/nutrition/supplements/label?id=`. Saved foods gain `upc`, `otherIngredients` and
`origin: 'label'`. Old data (foods without those fields, AI foods, the stack) loads unchanged.
