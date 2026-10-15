// Pure helpers for food lookups (search results and barcode hits). A hit looks like
// { source, ext, name, brand, bases:[{ label, grams, per:{calories,protein_g,carbs_g,fat_g} }] }
// — see api/nutrition/lookup.js. Each base is one way of measuring a portion; an entry is priced
// as qty × base.

export const SOURCE_LABEL = { off: 'Open Food Facts', usda: 'USDA', fatsecret: 'FatSecret', custom: 'Mine', ai: 'AI' }
export const SOURCE_SHORT = { off: 'OFF', usda: 'USDA', fatsecret: 'FatSecret' }

// FatSecret's Basic edition requires this credit, with a link, wherever its results are shown.
export const FATSECRET_CREDIT = 'Powered by fatsecret'
export const FATSECRET_URL = 'https://www.fatsecret.com'

/** A scanned or typed barcode → digits, or null. 8–14 digits, spaces and dashes ignored. */
export function barcodeOf(s) {
  const d = String(s ?? '').replace(/[\s-]/g, '')
  return /^\d{8,14}$/.test(d) ? d : null
}

/** What gets sent with an entry so the server can keep the food as a recent. */
export function snapshotOf(hit, base) {
  return { name: hit.name, brand: hit.brand || '', source: hit.source, ext: hit.ext, serving: base.label, grams: base.grams ?? null, per: base.per }
}

/** The portion the user is most likely to want: the label serving if there is one, else 100 g. */
export const defaultBase = hit => hit.bases[0]

/** servings ↔ grams for a base that has a weight. null when it has none. */
export const gramsOf = (base, qty) => (base.grams ? Math.round(base.grams * qty * 10) / 10 : null)
export function qtyForGrams(base, grams) {
  if (!base.grams || !Number.isFinite(grams) || grams <= 0) return null
  return Math.round(grams / base.grams * 1000) / 1000
}

// Asking again cannot fix these: a wrong key, a refused IP address, a used-up budget, a plan without the feature.
export const NO_RETRY = new Set(['auth', 'ip', 'limit', 'plan'])

/**
 * The status line(s) under a search: which source did not answer or is switched off, in words.
 * `admin` adds where to fix a missing key. Returns [{ tone:'warn'|'info', text, retry? }].
 */
export function sourceNotes(sources, { admin = false } = {}) {
  const out = []
  if (!sources) return out
  if (sources.usda?.skipped === 'no-key') {
    out.push({ tone: 'info', text: admin ? 'USDA search is off: add a free key under Goals → Admin. Showing Open Food Facts only.' : 'USDA search is off (an admin has not added a key). Showing Open Food Facts only.' })
  }
  if (sources.fatsecret?.skipped === 'no-key') {
    out.push({ tone: 'info', text: admin ? 'FatSecret search is off: add free keys under Goals → Admin.' : 'FatSecret search is off (an admin has not added keys).' })
  }
  for (const [id, s] of Object.entries(sources)) {
    if (s && s.ok === false && !s.skipped) out.push({ tone: 'warn', text: s.error || `${SOURCE_LABEL[id] || id} did not answer`, retry: !NO_RETRY.has(s.kind), kind: s.kind })
  }
  return out
}

/** One line for a hit in a result list: brand · first portion · kcal. */
export function hitLine(hit) {
  const b = defaultBase(hit)
  return [hit.brand, b.label].filter(Boolean).join(' · ')
}
