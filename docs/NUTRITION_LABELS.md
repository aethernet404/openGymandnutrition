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

## NIH DSLD: what is and is not verified
Base `https://api.ods.od.nih.gov/dsld/v9`. The client is written from the public guide and **was not run against the live API**: the
environment this was built in blocks that host (HTTP 403 from the network policy), so whether a key is required, the real limits and
whether `search-filter?q=<UPC>` returns the label with that UPC are **unverified**. The code accepts the documented response shapes,
prefers the newest label not marked off market, and is tested with fixtures (several versions of one UPC, one off market).
Check it from a machine that can reach the host: `node api/scripts/verify-dsld.mjs [UPC]` prints what it found. If UPC search does not
work the barcode path falls through to Open Food Facts / USDA and then the photo; a bulk index (NIH download, ~215,000 labels) was
**not** built. Public domain; the app shows the NIH attribution wherever DSLD data appears. Server budget: `NUTRITION_DSLD_HOURLY_CAP`
(300), `NUTRITION_DSLD_DAILY_CAP` (3000), `NUTRITION_DSLD_USER_HOURLY_CAP` (60), counted in `DATA_DIR/dsld-usage.json`;
`NUTRITION_DSLD_BASE` points it at a mirror. Timeouts and one retry, with errors in plain words.

## Routes
`POST /api/nutrition/label` (photos, hint), `POST /api/nutrition/micros/label` (`{date,id,micros,overwrite?}`), `GET /api/nutrition/barcode?kind=supplement`,
`GET /api/nutrition/supplements/search?q=`, `GET /api/nutrition/supplements/label?id=`. Saved foods gain `upc`, `otherIngredients` and
`origin: 'label'`. Old data (foods without those fields, AI foods, the stack) loads unchanged.
