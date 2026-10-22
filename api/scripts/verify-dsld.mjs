#!/usr/bin/env node
/* Checks what could not be checked when the DSLD client was written. Run it where api.ods.od.nih.gov is reachable:
 *     node scripts/verify-dsld.mjs [UPC digits]
 * It prints facts, never secrets. It answers: (1) does the API work without a key, (2) what does a search answer look like,
 * (3) does search-filter?q="<UPC>" find the label with that UPC, (4) what does a label look like (fields the parser reads),
 * (5) do several versions of one UPC come back, and which is off the market, (6) any rate-limit headers. */
import { base, upcQueries, parseSearch, parseLabel, sameBarcode } from '../nutrition/dsld.js';

const B = base();
const get = async (p) => {
  const r = await fetch(B + p, { headers: { Accept: 'application/json', 'User-Agent': 'openGym-nutrition (verify)' }, signal: AbortSignal.timeout(20000) });
  const limit = Object.fromEntries([...r.headers].filter(([k]) => /rate|limit|remaining|retry/i.test(k)));
  let json = null; try { json = await r.json(); } catch { /* not JSON */ }
  return { status: r.status, json, limit };
};
const keys = o => (o && typeof o === 'object' ? Object.keys(o).slice(0, 25) : typeof o);
const upc = process.argv[2];

console.log('base', B);
const s = await get('/search-filter?q=' + encodeURIComponent('vitamin d3'));
console.log('1. search without a key:', s.status, s.status === 200 ? 'WORKS WITHOUT A KEY' : 'REFUSED (a key may be needed)', JSON.stringify(s.limit));
console.log('2. search answer top-level keys:', keys(s.json), '| hits shape:', Array.isArray(s.json?.hits) ? 'hits[]' : Array.isArray(s.json?.hits?.hits) ? 'hits.hits[]' : 'unknown');
const hits = parseSearch(s.json) || [];
console.log('   parsed hits:', hits.length, 'first:', JSON.stringify(hits[0] || null));
if (hits[0]) {
  const l = await get('/label/' + hits[0].id);
  console.log('4. label keys:', keys(l.json?._source || l.json));
  const p = parseLabel(l.json);
  console.log('   parsed:', p ? { name: p.name, upc: p.upc, serving: p.servingText, rows: p.rows.length, offMarket: p.offMarket, date: p.date } : null);
  const code = upc || p?.upc;
  if (code) {
    for (const q of [...upcQueries(code), code]) {
      const r = await get('/search-filter?q=' + encodeURIComponent(q));
      const found = (parseSearch(r.json) || []);
      const matching = [];
      for (const h of found.slice(0, 8)) { const L = parseLabel((await get('/label/' + h.id)).json); if (L && sameBarcode(L.upc, code)) matching.push({ id: L.id, offMarket: L.offMarket, date: L.date }); }
      console.log(`3. search-filter?q=${q}:`, r.status, 'hits', found.length, '| labels whose UPC equals it:', JSON.stringify(matching));
    }
  } else console.log('3. no UPC on that label; pass one: node scripts/verify-dsld.mjs <UPC digits>');
}
console.log('done. Paste this output back so the client can be adjusted if anything differs from what dsld.js expects.');
