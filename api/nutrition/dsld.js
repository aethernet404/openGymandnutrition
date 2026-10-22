/* The NIH Dietary Supplement Label Database (DSLD): reading what its Label API sends, and picking the right label for a barcode.
 *
 * Pure parsing; the requests themselves are made by lookup.js (timeouts, one retry, the budget, the cache).
 *
 * WHAT IS AND IS NOT VERIFIED. The shapes below come from the API guide's description and third-party notes (search hits carry
 * brandName, fullName, upcSku, offMarket...; a label carries servingSizes and ingredientRows with quantity, unit and daily-value
 * rows). The build environment could not reach api.ods.od.nih.gov, so NONE of it has been checked against the live service:
 * the parsers accept both of the shapes the guide suggests (Elasticsearch-style `hits.hits[]._source`, or plain lists) and
 * `scripts/verify-dsld.mjs` runs the checks that settle the open questions (is a key needed, does `search-filter?q="<UPC>"`
 * find a label by its barcode, what do the fields really look like). DSLD data is public domain; the app still names NIH wherever it shows it.
 */
import { text, mapColumn } from './label.js';

export const ATTRIBUTION = 'Source: NIH Office of Dietary Supplements, Dietary Supplement Label Database (DSLD)';
export const base = () => (process.env.NUTRITION_DSLD_BASE || 'https://api.ods.od.nih.gov/dsld/v9').replace(/\/$/, '');
export const labelUrl = id => `https://dsld.od.nih.gov/label/${encodeURIComponent(String(id))}`;

const digits = s => String(s ?? '').replace(/\D/g, '');
/** UPC-A (12), EAN-13 (13, often "0" + UPC-A) and GTIN-14 spellings of one product compare equal. */
export function sameBarcode(a, b) {
  const x = digits(a).replace(/^0+/, ''), y = digits(b).replace(/^0+/, '');
  return x.length >= 7 && x === y;
}

const flagOn = v => v === 1 || v === true || v === '1' || v === 'true' || v === 'Y' || v === 'y';

/** The search answer → [{ id, name, brand, upc, offMarket, date }] (any of them may be missing). */
export function parseSearch(data) {
  const raw = Array.isArray(data) ? data : Array.isArray(data?.hits?.hits) ? data.hits.hits : Array.isArray(data?.hits) ? data.hits : Array.isArray(data?.results) ? data.results : null;
  if (!raw) return null;
  const out = [];
  for (const h of raw.slice(0, 50)) {
    const src = h && typeof h === 'object' ? (h._source && typeof h._source === 'object' ? h._source : h) : null;
    if (!src) continue;
    const id = h._id ?? src.id ?? src.dsld_id ?? src.dsldId;
    if (id == null || !/^\d{1,12}$/.test(String(id))) continue;
    out.push({ id: String(id), name: text(src.fullName || src.productName || src.name, 120), brand: text(src.brandName || src.brand, 60), upc: digits(src.upcSku || src.upc || ''), offMarket: flagOn(src.offMarket), date: String(src.entryDate || src.dateEntered || src.date || '').slice(0, 10) });
  }
  return out;
}

const first = (...v) => v.find(x => x !== undefined && x !== null && x !== '');

/** One label answer → a normalised product, or null when it has no name. */
export function parseLabel(data) {
  const l = data && typeof data === 'object' ? (data._source && typeof data._source === 'object' ? { id: data._id, ...data._source } : data) : null;
  if (!l) return null;
  const name = text(l.fullName || l.productName, 120);
  if (!name) return null;
  const ss = Array.isArray(l.servingSizes) ? l.servingSizes[0] : null;
  const qty = ss ? first(ss.minQuantity, ss.maxQuantity) : null;
  const servingText = ss ? text([qty, String(ss.unit || '').replace(/\(s\)/gi, '')].filter(x => x !== null && x !== undefined && x !== '').join(' '), 60) : '';
  const rows = [];
  const walk = (list, depth = 0) => {
    for (const r of Array.isArray(list) ? list : []) {
      if (!r || typeof r !== 'object' || depth > 3) continue;
      const q = Array.isArray(r.quantity) ? r.quantity[0] : r.quantity && typeof r.quantity === 'object' ? r.quantity : null;
      const amount = q && typeof q.quantity === 'number' ? q.quantity : q && q.quantity != null && !Number.isNaN(Number(q.quantity)) ? Number(q.quantity) : null;
      const dvRow = q && Array.isArray(q.dailyValueTargetGroup) ? q.dailyValueTargetGroup[0] : null;
      const form = Array.isArray(r.forms) && r.forms[0] ? r.forms[0].name : '';
      if (r.name) rows.push({ name: text(r.name, 80), amount: amount != null && amount >= 0 ? amount : null, qualifier: q && /^</.test(String(q.operator || '')) ? '<' : null, unit: text(q?.unit, 16), dv: dvRow && typeof dvRow.percent === 'number' ? dvRow.percent : null, form: text(form, 60), legible: true });
      walk(r.nestedRows, depth + 1);
    }
  };
  walk(l.ingredientRows);
  const oi = l.otherIngredients;
  return {
    id: String(first(l.id, l._id, '') ?? ''), name, brand: text(l.brandName, 60), upc: digits(l.upcSku || ''), offMarket: flagOn(l.offMarket),
    date: String(l.entryDate || l.dateEntered || '').slice(0, 10), servingText, servingsPerContainer: typeof l.servingsPerContainer === 'number' ? l.servingsPerContainer : null,
    rows: rows.slice(0, 80), otherIngredientsText: text(oi && typeof oi === 'object' ? oi.text : oi, 600)
  };
}

/** Of several labels for one barcode: the newest one that is still on the market, else the newest. */
export function pickBest(labels) {
  const list = labels.filter(Boolean);
  if (!list.length) return null;
  const rank = l => [l.offMarket ? 0 : 1, l.date || '', Number(l.id) || 0];
  return [...list].sort((a, b) => { const x = rank(a), y = rank(b); return y[0] - x[0] || (y[1] > x[1] ? 1 : y[1] < x[1] ? -1 : 0) || y[2] - x[2]; })[0];
}

/** A parsed label → a lookup hit like every other source's (one base, the serving printed), with its other ingredients. */
export function hitOfLabel(l) {
  const col = mapColumn({ heading: '', basis: 'per_serving', rows: l.rows });
  const per = { calories: col.per.calories ?? 0, protein_g: col.per.protein_g ?? 0, carbs_g: col.per.carbs_g ?? 0, fat_g: col.per.fat_g ?? 0 };
  return {
    source: 'dsld', kind: 'supplement', ext: l.id, name: l.name, brand: l.brand, upc: l.upc || null, offMarket: l.offMarket, attribution: ATTRIBUTION, url: labelUrl(l.id),
    bases: [{ label: l.servingText || '1 serving', grams: null, per, ...(Object.keys(col.micros).length ? { micros: col.micros } : {}) }],
    otherIngredients: col.others, otherIngredientsText: l.otherIngredientsText, servingsPerContainer: l.servingsPerContainer
  };
}
