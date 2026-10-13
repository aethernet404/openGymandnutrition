// Searching two sources at once without letting either wait for, or hide, the other.
//
// The app asks the server for Open Food Facts and USDA separately and in parallel (the server
// answers each with hits that carry a comparable `rank`), shows whatever has arrived, and keeps a
// status per source: still loading, answered, failed (with the reason, and a way to try just that
// one again) or switched off. The screen is decided from that status by `view()` — one pure
// function — so that "a blank list with no reason" is not a state it can reach.

export const SOURCES = ['usda', 'off']
export const NAME = { off: 'Open Food Facts', usda: 'USDA' }
const MAX_SHOWN = 40

export const fresh = () => Object.fromEntries(SOURCES.map(id => [id, { state: 'loading', hits: [] }]))

/** All sources' hits merged best-first: ranks are comparable, and the same food from one source twice is shown once. */
export function merge(per) {
  const seen = new Set()
  const out = []
  for (const hit of SOURCES.flatMap(id => per[id]?.hits || []).sort((a, b) => b.rank - a.rank)) {
    const key = hit.source + '|' + hit.ext + '|' + hit.bases?.[0]?.label
    if (seen.has(key)) continue
    seen.add(key)
    out.push(hit)
  }
  return out.slice(0, MAX_SHOWN)
}

/** One source's answer → its status. */
export function settle(id, answer) {
  const s = answer?.sources?.[id]
  if (!s) return { state: 'error', hits: [], error: `${NAME[id]} sent an answer the app could not read.`, kind: 'bad' }
  if (s.skipped) return { state: 'skipped', hits: [], why: s.skipped }
  if (!s.ok) return { state: 'error', hits: [], error: s.error || `${NAME[id]} did not answer.`, kind: s.kind || 'down' }
  return { state: 'ok', hits: answer.results || [], count: s.count ?? (answer.results || []).length }
}

/** A request that failed before the server could answer for a source (offline, timed out, throttled). */
export function failed(id, e) {
  const kind = e?.code === 'timeout' ? 'timeout' : e?.status === 429 ? 'rate' : 'down'
  const error = kind === 'rate' ? 'Too many lookups — wait a moment and try again.'
    : kind === 'timeout' ? `${NAME[id]}: the server did not answer in time.`
      : `${NAME[id]}: ${e?.message || 'could not be reached'}`
  return { state: 'error', hits: [], error, kind }
}

/**
 * Run the searches for `ids` (default: all) and report each source on its own as it lands:
 * onSource(id, status) with `loading` first, then the answer. Reporting per source (rather than one
 * whole-state object) is what lets a retry of one source run beside another still in flight without
 * either overwriting the other.
 * @param {(q:string, id:string)=>Promise<object>} fetchSource
 * @param {()=>boolean} [stale]   return true to drop late answers (a newer search began)
 */
export async function run(q, { fetchSource, onSource, ids = SOURCES, stale = () => false }) {
  for (const id of ids) onSource(id, { state: 'loading', hits: [] })
  await Promise.all(ids.map(id => fetchSource(q, id).then(a => settle(id, a), e => failed(id, e)).then(s => { if (!stale()) onSource(id, s) })))
}

/**
 * What the screen shows.
 * @returns {{ results:object[], loading:string[], errors:{id:string,error:string,kind:string}[], skipped:string[], nothingFound:boolean, cannotTell:boolean }}
 *   nothingFound — every source that was asked answered, and there is truly nothing
 *   cannotTell   — nothing to show AND a source failed: not "no results", a search that did not complete
 */
export function view(per) {
  const ids = SOURCES.filter(id => per[id])
  const loading = ids.filter(id => per[id].state === 'loading')
  const errors = ids.filter(id => per[id].state === 'error').map(id => ({ id, error: per[id].error, kind: per[id].kind }))
  const skipped = ids.filter(id => per[id].state === 'skipped')
  const results = merge(per)
  const settled = loading.length === 0
  return {
    results, loading, errors, skipped,
    nothingFound: settled && results.length === 0 && errors.length === 0,
    cannotTell: settled && results.length === 0 && errors.length > 0
  }
}
