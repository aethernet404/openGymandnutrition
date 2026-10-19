# Micronutrients (vitamins and minerals) and supplements

Everything below lives in your own `data/nutrition/<you>.json`. No new service, no new dependency.

## The rule: no data is not zero

A food, a portion and a diary entry carry an optional `micros` object with **only the nutrients that are known** for
it. A missing key means *unknown* and is never stored, summed or drawn as 0. A label that says 0 mg is a real 0 and is
kept. **Quick add and AI photo / Describe estimates have no micronutrient data and nothing ever guesses any**; they stay
unknown unless you fill them in (Edit entry → More nutrients).

* A food's micronutrients are copied onto the entry **when you log it**, scaled by the amount, so past days do not move
  if a database changes later.
* The diary card says how much of the day its numbers are based on ("Based on 6 of 9 entries that have micronutrient
  data") and lists what is unknown.
* Every value is validated: numbers only (no text, NaN or negatives), each nutrient has a ceiling for one entry that
  catches unit mix-ups (for example 1,000,000 mg of calcium), unknown nutrient names are refused.

## The 29 nutrients and their units

Units are fixed per nutrient (g, mg or mcg; the key's suffix says which). The ones you asked for are all there; I added
phosphorus, selenium, copper, manganese, iodine, pantothenic acid (B5), biotin and choline because they are on the
FDA label list and several sources carry them.

| Nutrient | Unit | FDA Daily Value (adults) |
|---|---|---|
| Vitamin A (RAE) | mcg | 900 |
| Vitamin C | mg | 90 |
| Vitamin D | mcg | 20 |
| Vitamin E | mg | 15 |
| Vitamin K | mcg | 120 |
| Thiamin (B1) | mg | 1.2 |
| Riboflavin (B2) | mg | 1.3 |
| Niacin (B3) | mg | 16 |
| Pantothenic acid (B5) | mg | 5 |
| Vitamin B6 | mg | 1.7 |
| Biotin (B7) | mcg | 30 |
| Folate (DFE) | mcg | 400 |
| Vitamin B12 | mcg | 2.4 |
| Choline | mg | 550 |
| Calcium | mg | 1300 |
| Iron | mg | 18 |
| Magnesium | mg | 420 |
| Zinc | mg | 11 |
| Potassium | mg | 4700 |
| Phosphorus | mg | 1250 |
| Selenium | mcg | 55 |
| Copper | mg | 0.9 |
| Manganese | mg | 2.3 |
| Iodine | mcg | 150 |
| Fiber | g | 28 |
| Sugars (total) | g | none |
| Sodium | mg | 2300 |
| Saturated fat | g | 20 |
| Cholesterol | mg | 300 |

**Daily Values** are the FDA's adult Daily Values (21 CFR 101.9(c); the 2016 Nutrition Facts final rule, in force since
2020/2021), the figures printed on US food labels. They are a general reference, **not your personal need and not
medical advice**; the app says so under the card. I could not open the FDA page from where this was built; the figures
are from the rule as I know it and from search excerpts that name them (vitamin K 120 mcg, choline 550 mg, biotin 30 mcg,
potassium 4,700 mg, sodium 2,300 mg). Total sugars have no Daily Value.

## Unit conversions relied on

| From | To | Rule | Assumption that cannot be verified |
|---|---|---|---|
| grams (Open Food Facts `*_100g`) | mg / mcg | × 1,000 / × 1,000,000 | OFF normalises every nutrient to grams per 100 g |
| vitamin D IU | mcg | ÷ 40 | none (standard) |
| vitamin A IU | mcg RAE | × 0.3 (retinol) | an IU on a food could be beta-carotene (0.15 / 0.05), retinol is assumed |
| vitamin E IU | mg alpha-tocopherol | × 0.67 (natural d-alpha) | synthetic dl-alpha would be × 0.45; natural assumed |
| salt (g) | sodium (mg) | × 400 (sodium is 39.3 % of salt) | used only when a product lists no sodium |
| USDA unit `G` / `MG` / `UG` | our unit | by the unit USDA states on the row | none |
| FatSecret % Daily Value | — | **not converted** | its vitamin A, C, calcium and iron are percentages on an older basis; converting would be a guess |

Vitamin A is kept as mcg RAE, vitamin E as mg alpha-tocopherol, niacin as mg (NE), folate as mcg DFE.

## What each source really provides

| Source | Provides | Where it is thin |
|---|---|---|
| **USDA FoodData Central** | by nutrient id (1079 fibre, 2000/1063 sugars, 1093 sodium, 1258 sat. fat, 1253 cholesterol, 1092 potassium, 1087 calcium, 1089 iron, 1090 magnesium, 1095 zinc, 1091 phosphorus, 1103 selenium, 1098 copper, 1101 manganese, 1100 iodine, 1106/1104 vitamin A RAE/IU, 1162 C, 1114/1110 D mcg/IU, 1109 E, 1185 K, 1165 B1, 1166 B2, 1167 B3, 1170 B5, 1175 B6, 1176 biotin, 1190/1177 folate DFE/total, 1178 B12, 1180 choline); per 100 g, converted from the unit USDA states | Foundation and SR Legacy foods carry nearly all of them. **Branded** foods carry only what is on their label (typically sodium, sugars, fibre, saturated fat, cholesterol, potassium, calcium, iron, vitamin D, sometimes A and C). The nutrient ids are from FoodData Central's standard numbering; I could not open the documentation to re-check them. |
| **Open Food Facts** | `nutriments` per 100 g for fibre, sugars, sodium (or salt), saturated fat, cholesterol, the minerals above and most vitamins | Entirely product-dependent: many products list only the label's mandatory nutrients, so vitamins and minerals are often absent. Values are volunteer-entered; vitamin A/D/E unit handling is assumed (see above). |
| **FatSecret** (Basic) | per serving: fibre, sugar, saturated fat, sodium, cholesterol, potassium | **No vitamins or minerals** in a usable unit (vitamin A, C, calcium and iron are percentages and are skipped). |
| **Foods you create / label values you type** | anything | — |
| **Quick add, AI estimates** | nothing | by design |

## Upper limits (neutral note on the diary)

For the nutrients with a well-known adult Tolerable Upper Intake Level, the diary shows a small neutral note when the
day's total is above it: "… is above the usual upper limit for adults (…). Worth checking with a doctor or pharmacist."
It is computed from everything eaten and taken that day, whichever mode the card shows. Values are the adult (19+)
figures in the NIH Office of Dietary Supplements fact sheets (from the National Academies' DRI reports). I could not open
the ODS pages from where this was built; the vitamin D (100 mcg), zinc (40 mg) and iron (45 mg) figures were confirmed in
search excerpts, the rest are from the fact sheets as I know them (2022-2025 versions): please check them at
<https://ods.od.nih.gov/> before relying on them.

| Nutrient | Upper limit (adults) | Applies to |
|---|---|---|
| Vitamin A (RAE) | 3,000 mcg | preformed vitamin A (retinol) |
| Vitamin C | 2,000 mg | total intake, food and supplements |
| Vitamin D | 100 mcg | total intake, food and supplements |
| Vitamin E | 1,000 mg | vitamin E from supplements |
| Niacin (B3) | 35 mg | niacin from supplements and fortified foods |
| Vitamin B6 | 100 mg | total intake, food and supplements |
| Folate (DFE) | 1,000 mcg | folic acid from supplements and fortified foods |
| Choline | 3,500 mg | total intake, food and supplements |
| Calcium | 2,500 mg (2,000 mg from age 51) | total intake, food and supplements |
| Iron | 45 mg | total intake, food and supplements |
| Magnesium | 350 mg | magnesium from supplements |
| Zinc | 40 mg | total intake, food and supplements |
| Phosphorus | 4,000 mg | total intake, food and supplements |
| Selenium | 400 mcg | total intake, food and supplements |
| Copper | 10 mg | total intake, food and supplements |
| Manganese | 11 mg | total intake, food and supplements |
| Iodine | 1,100 mcg | total intake, food and supplements |

* **Supplement-scope limits** (magnesium, niacin, folate as folic acid, vitamin E, preformed vitamin A) are compared with
  the *supplement* total only, because that is what the limit is about. The app cannot tell retinol from beta-carotene in a
  vitamin A figure, so the vitamin A note compares the supplement total and is only a prompt to check the label.
* Calcium uses 2,500 mg (19-50); from age 51 the limit is 2,000 mg, and the note says so.
* **Left out** (no adult limit established or not tracked): vitamin K, thiamin, riboflavin, B12, pantothenic acid, biotin,
  potassium, fibre. Sodium's 2,300 mg is a *chronic disease risk reduction* figure, not an upper limit, so it is shown as
  a percent of the Daily Value only. Also left out: chromium, molybdenum, vitamin D-specific age ranges, and
  children or pregnancy values (this is the general adult figure).

## Supplements

(see "Vitamins & supplements" in the diary; the details are added with that feature)

## NIH Dietary Supplement Label Database (DSLD): research only, not built

* **Is there a free public API?** Yes: the DSLD Label API, base `https://api.ods.od.nih.gov/dsld/v9` (version 9.4 in
  its reference). Methods seen: `GET /v9/search-filter` (search terms plus filters: `q`, `status` on/off market,
  `product_type`, `ingredient_category`, `brand`, `supplement_form`, `target_group`, sorting and paging),
  `GET /v9/browse-products` (paged names by keyword/letter), and `GET /v9/label/{id}` (the full label).
* **What it returns:** search hits carry brand name, full name, product type, ingredient names, claims, net contents and
  on/off-market status; the **label detail** has the ingredient rows with quantities and units, serving sizes, UPC/SKU,
  claims and more. A community client reports UPC lookup works by matching `upcSku` (with spacing variants), so a scan
  can be matched to a label, but there is no documented barcode-only endpoint.
* **Limits and terms:** it is behind api.data.gov, whose default is 1,000 requests an hour per key (a key can be
  requested for more); one project says no key was needed. Data is public domain (CC0) and NIH asks for attribution.
  I could not open the API pages from where this was built; all of this is from search excerpts and third-party
  clients and must be re-checked against the live Swagger page before building.
* **How it would be added later:** a fourth lookup source ("DSLD") for the supplement search: `search-filter?q=<name>`
  → pick a hit → `label/{id}` → map each ingredient row (name, amount, unit) onto our 29 nutrients with the same
  unit conversions (IU for A, D, E; "mg" as written), keep only nutrients we track, ignore proprietary blends, per
  *serving size* from the label, and snapshot the numbers into the saved supplement. A barcode scan would try `upcSku`.
  Ingredient naming varies a lot ("Cholecalciferol", "Vitamin D3", "Ascorbic acid"), so it needs a name-to-nutrient
  table. It needs the same safeguards as the other sources (timeout, one retry, per-source status, rate protection, a
  hits-must-contain-every-word filter). Cost: one source module, one name table, tests with recorded fixtures.
