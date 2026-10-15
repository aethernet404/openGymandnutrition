/* Which lookup hits are relevant to what was typed, and in what order they are shown.
 *
 * Three ideas, all of them deliberately plain so they can be read, tested and argued with:
 *
 *   RELEVANCE  Every word typed must be found in the food's name or brand (a word matches if it is
 *              equal to, a prefix of, or the same singular as a word of the name: "cookie" finds
 *              "Cookies", "oat" finds "Oatmeal"). A hit that lacks a word is dropped. That is what
 *              removes foie gras from "whole egg": it mentions egg somewhere in its data but is not
 *              named like one. A food that matches is scored: exact name, starting with the query,
 *              and short names (a plain "Egg, whole, raw" beats "Egg noodles with cheese sauce and
 *              spinach") rank higher.
 *   GROUPS     USDA's reference datasets (Foundation, SR Legacy) are the plain foods — "Egg, whole,
 *              raw, fresh" — and come first when they match; everything else that matches follows
 *              by score, with a small push for USDA branded items, and for Open Food Facts products
 *              sold in the US and described in English.
 *   SERVINGS   A serving size is believed only when it is a believable weight (1 g – 1 kg) that
 *              agrees with the calories; otherwise the food is offered per 100 g only.
 */

const STOP = new Set(['the', 'a', 'an', 'of', 'and', 'with', 'in', 'or', 'for', 'to'])

const fold = s => String(s ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
export const tokens = s => fold(s).replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(t => t && !STOP.has(t))

/** A word's singular key, the same for both forms: cookies/cookie → cooky, berries/berry → berry, eggs/egg → egg. */
export function stem(t) {
  if (t.length > 4 && t.endsWith('ies')) return t.slice(0, -3) + 'y'
  if (t.length > 3 && t.endsWith('ie')) return t.slice(0, -2) + 'y'
  if (t.length > 4 && /(ches|shes|sses|xes)$/.test(t)) return t.slice(0, -2)
  if (t.length > 3 && t.endsWith('s') && !t.endsWith('ss')) return t.slice(0, -1)
  return t
}

/** Does a typed word find this word of a name? */
export function wordMatches(q, n) {
  if (q === n) return true
  const sq = stem(q), sn = stem(n)
  if (sq === sn) return true
  // A typed prefix of at least three letters finds longer words: "oat" → "oatmeal".
  return q.length >= 3 && (n.startsWith(q) || sn.startsWith(sq))
}

// Words that describe the state of a plain food rather than make it a different dish: "Bananas, raw"
// is just banana, "Egg, whole, cooked, fried" is still an egg. They do not count against closeness.
const DESCRIPTORS = new Set(['raw', 'fresh', 'cooked', 'dried', 'dry', 'plain', 'regular', 'boiled', 'baked', 'fried', 'roasted', 'grilled',
  'steamed', 'unsalted', 'salted', 'large', 'medium', 'small', 'ripe', 'frozen', 'canned', 'prepared', 'commercially', 'cooking', 'drained',
  'solids', 'liquids', 'only', 'meat', 'without', 'salt', 'added', 'nfs', 'ns', 'as', 'to', 'form', 'type', 'enriched', 'fortified', 'unenriched'])

/**
 * @returns {{ full:boolean, matched:number, total:number, score:number }}
 * `score` is only meaningful when `full`.
 */
export function relevance(query, name, brand = '') {
  const q = tokens(query)
  const n = tokens(name)
  const b = tokens(brand)
  if (!q.length || !n.length) return { full: false, matched: 0, total: q.length, score: 0 }
  const found = word => n.some(x => wordMatches(word, x)) || b.some(x => wordMatches(word, x))
  const matched = q.filter(found).length
  const full = matched === q.length
  let score = 0
  if (full) {
    score = 100
    // The words of the name that were NOT asked for and are not mere state ("raw", "fresh").
    const extra = n.filter(x => !q.some(w => wordMatches(w, x)) && !DESCRIPTORS.has(x))
    if (extra.length === 0 && q.every(w => n.some(x => wordMatches(w, x)))) score += 60                    // the food IS what was typed
    else if (n.slice(0, q.length).every((x, i) => wordMatches(q[i], x))) score += 30                      // it starts with what was typed
    else if (n.some(x => wordMatches(q[0], x))) score += 8
    // Fewer unasked-for words → closer to what was meant. Up to +40.
    score += Math.round(40 * q.length / (q.length + extra.length))
    if (q.every(w => n.some(x => wordMatches(w, x)))) score += 5                                           // all of it in the NAME, not just the brand
  }
  return { full, matched, total: q.length, score }
}

/** The identity of a food for de-duplication: the same name, brand and calories per 100 g (or the first portion) is the same food. */
export const dupKey = hit => {
  const first = hit.bases?.find(b => b.grams === 100) || hit.bases?.[0]
  return `${fold(hit.name)}|${fold(hit.brand)}|${first?.per?.calories}`
}

const GENERIC_USDA = new Set(['foundation', 'sr'])

/**
 * Filter to relevant hits, score, order, and drop duplicates. Each kept hit gets a numeric `rank`
 * that is comparable across sources (so a client that receives the two sources separately can
 * merge them with a plain sort): reference USDA foods sit above 2000, everything else near 1000+.
 */
export function rankHits(hits, query) {
  const out = []
  const seen = new Set()
  for (const hit of hits) {
    const r = relevance(query, hit.name, hit.brand)
    if (!r.full) continue
    const key = dupKey(hit)
    if (seen.has(key)) continue
    seen.add(key)
    let rank
    if (hit.source === 'usda' && GENERIC_USDA.has(hit.kind)) rank = 2000 + r.score + (hit.kind === 'foundation' ? 4 : 0)
    else {
      rank = 1000 + r.score
      if (hit.source === 'usda') rank += 10                      // a USDA branded label is checked data
      if (hit.source === 'off' && hit.preferred) rank += 8       // US market, English text
      // A restaurant, chain or convenience-store item whose typed words include its brand ("7-Eleven taquitos"):
      // that is exactly what the person asked for, and the other sources are the ones that lack it.
      if (hit.source === 'fatsecret' && hit.brand && tokens(query).some(w => tokens(hit.brand).some(x => wordMatches(w, x)))) rank += 12
    }
    out.push({ ...hit, rank })
  }
  return out.sort((a, b) => b.rank - a.rank)
}

/* ------------------------------ serving sizes ------------------------------ */

const OZ = 28.3495
/**
 * Read a serving written as text: "30 g", "1 cookie (28 g)", "2 tbsp (30g)", "240 ml", "1 oz".
 * Returns grams (millilitres count as grams, close enough for a portion) or null.
 */
export function servingGrams(text) {
  const s = fold(text).replace(',', '.')
  if (!s) return null
  const re = /(\d+(?:\.\d+)?)\s*(kg|g|gr|grams?|ml|cl|l|litres?|liters?|oz|fl\.?\s?oz)\b/g
  const found = []
  for (let m = re.exec(s); m; m = re.exec(s)) {
    const v = parseFloat(m[1]); const u = m[2]
    let g = null
    if (u === 'g' || u === 'gr' || u.startsWith('gram')) g = v
    else if (u === 'kg') g = v * 1000
    else if (u === 'ml') g = v
    else if (u === 'cl') g = v * 10
    else if (u === 'l' || u.startsWith('lit')) g = v * 1000
    else if (u === 'oz') g = v * OZ
    else g = v * 29.57                                    // fl oz
    found.push({ g, unit: u, parenthesised: s.lastIndexOf('(', m.index) > s.lastIndexOf(')', m.index) })
  }
  if (!found.length) return null
  // "1 cookie (28 g)": the bracketed weight is the serving. Otherwise the first weight.
  const pick = found.find(f => f.parenthesised && ['g', 'gr', 'ml'].includes(f.unit)) || found.find(f => ['g', 'gr', 'ml'].some(u => f.unit === u || f.unit.startsWith('gram'))) || found[0]
  return Math.round(pick.g * 10) / 10
}

export const SERVING_MIN_G = 1
export const SERVING_MAX_G = 1000

/** A serving weight is believable: a mouthful to a kilogram. */
export const sensibleGrams = g => Number.isFinite(g) && g >= SERVING_MIN_G && g <= SERVING_MAX_G

/**
 * Choose the serving weight to trust. `quantity` is the machine field some sources give,
 * `text` the human one ("1 cookie (28 g)"). When both exist and disagree by more than a third, the
 * written text wins — the number field is the one that is often a copy of the pack size.
 */
export function chooseServingGrams(quantity, text) {
  const q = Number.isFinite(quantity) ? quantity : null
  const t = servingGrams(text)
  if (q != null && t != null && Math.abs(q - t) / Math.max(q, t) > 0.34) return sensibleGrams(t) ? t : null
  const g = q ?? t
  return sensibleGrams(g) ? Math.round(g * 10) / 10 : null
}

/**
 * A label for a serving: what the pack says, if it says something with a unit, else "N g".
 * "30" alone is not a label; "1 cookie (28 g)" is.
 */
export function servingLabel(text, grams) {
  const t = String(text ?? '').replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim()
  if (t && /[a-z]/i.test(t) && /\d/.test(t) && t.length <= 60) return t
  if (/^\d+(\.\d+)?$/.test(t) && grams) return `${grams} g`
  return grams ? `${grams} g` : '1 serving'
}
