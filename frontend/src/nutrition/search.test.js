import { describe, expect, it, vi } from 'vitest'
import { fresh, merge, settle, failed, run, view, NAME } from './search.js'

const h = (source, ext, rank, name = ext) => ({ source, ext, name, rank, bases: [{ label: '100 g' }] })
const ok = (id, hits) => ({ q: 'x', results: hits, sources: { [id]: { ok: true, count: hits.length } } })

describe('merge', () => {
  it('orders by the server’s rank across sources and shows one food once', () => {
    const per = { usda: { hits: [h('usda', '1', 2150), h('usda', '2', 1100)] }, off: { hits: [h('off', '3', 1170), h('usda', '1', 2150)] } }
    expect(merge(per).map(x => x.ext)).toEqual(['1', '3', '2'])
  })
  it('copes with a source that has not answered', () => {
    expect(merge({ usda: { state: 'loading', hits: [] }, off: { hits: [h('off', '3', 1) ] } }).map(x => x.ext)).toEqual(['3'])
    expect(merge({})).toEqual([])
  })
  it('caps the list', () => {
    const hits = Array.from({ length: 100 }, (_, i) => h('off', String(i), 1000 - i))
    expect(merge({ off: { hits } })).toHaveLength(40)
  })
})

describe('settle / failed', () => {
  it('reads the server’s per-source status', () => {
    expect(settle('off', ok('off', [h('off', '1', 1)]))).toMatchObject({ state: 'ok', count: 1 })
    expect(settle('usda', { sources: { usda: { ok: false, skipped: 'no-key' } } })).toMatchObject({ state: 'skipped', why: 'no-key' })
    expect(settle('off', { sources: { off: { ok: false, kind: 'timeout', error: 'Open Food Facts did not answer in time' } } })).toMatchObject({ state: 'error', kind: 'timeout', error: 'Open Food Facts did not answer in time' })
    expect(settle('off', {})).toMatchObject({ state: 'error', kind: 'bad' })
    expect(settle('off', null).state).toBe('error')
  })
  it('turns a request that never reached the server into a reason', () => {
    expect(failed('off', Object.assign(new Error('x'), { code: 'timeout' }))).toMatchObject({ kind: 'timeout', error: expect.stringContaining('did not answer in time') })
    expect(failed('usda', Object.assign(new Error('HTTP 429'), { status: 429 }))).toMatchObject({ kind: 'rate', error: expect.stringContaining('Too many lookups') })
    expect(failed('off', new Error('Failed to fetch'))).toMatchObject({ kind: 'down', error: 'Open Food Facts: Failed to fetch' })
    expect(failed('off', undefined).error).toContain('could not be reached')
  })
})

describe('run', () => {
  const collect = () => { let per = fresh(); const log = []; return { onSource: (id, s) => { per = { ...per, [id]: s }; log.push([id, s.state]) }, get per() { return per }, log } }

  it('starts both sources at once and reports each as it lands, fastest first', async () => {
    let release
    const gate = new Promise(r => { release = r })
    const fetchSource = vi.fn((q, id) => (id === 'off' ? gate.then(() => ok('off', [h('off', 'o', 1100)])) : Promise.resolve(ok('usda', [h('usda', 'u', 2100)]))))
    const c = collect()
    const p = run('egg', { fetchSource, onSource: c.onSource })
    await new Promise(r => setTimeout(r, 0))
    expect(fetchSource).toHaveBeenCalledTimes(2)
    expect(c.per.usda.state).toBe('ok'); expect(c.per.off.state).toBe('loading')
    expect(view(c.per).results.map(x => x.ext)).toEqual(['u'])              // USDA already on screen
    expect(view(c.per).loading).toEqual(['off'])
    release()
    await p
    expect(view(c.per).results.map(x => x.ext)).toEqual(['u', 'o'])
  })

  it('one source failing never hides the other', async () => {
    const fetchSource = async (q, id) => { if (id === 'off') throw Object.assign(new Error('x'), { code: 'timeout' }); return ok('usda', [h('usda', 'u', 2100)]) }
    const c = collect()
    await run('egg', { fetchSource, onSource: c.onSource })
    const v = view(c.per)
    expect(v.results.map(x => x.ext)).toEqual(['u'])
    expect(v.errors).toHaveLength(1)
    expect(v.errors[0]).toMatchObject({ id: 'off', kind: 'timeout' })
    expect(v.nothingFound).toBe(false)
  })

  it('retrying one source runs beside the other without disturbing it', async () => {
    const c = collect()
    c.onSource('usda', { state: 'ok', hits: [h('usda', 'u', 2100)], count: 1 })
    c.onSource('off', { state: 'error', hits: [], error: 'boom', kind: 'down' })
    const fetchSource = vi.fn(async () => ok('off', [h('off', 'o', 1100)]))
    await run('egg', { fetchSource, onSource: c.onSource, ids: ['off'] })
    expect(fetchSource).toHaveBeenCalledTimes(1)
    expect(fetchSource.mock.calls[0][1]).toBe('off')
    expect(view(c.per).results.map(x => x.ext)).toEqual(['u', 'o'])
  })

  it('drops answers that arrive after a newer search began', async () => {
    let stale = false
    const c = collect()
    await run('egg', { fetchSource: async () => { stale = true; return ok('off', [h('off', 'o', 1)]) }, onSource: c.onSource, ids: ['off'], stale: () => stale })
    expect(c.log).toEqual([['off', 'loading']])                          // the late answer never lands
  })
})

describe('view — the screen is always explained', () => {
  const state = (usda, off) => ({ usda, off })
  const loading = { state: 'loading', hits: [] }
  const empty = { state: 'ok', hits: [], count: 0 }
  const err = { state: 'error', hits: [], error: 'Open Food Facts did not answer in time', kind: 'timeout' }

  it('still loading is loading, never "nothing found"', () => {
    const v = view(state(loading, loading))
    expect(v).toMatchObject({ nothingFound: false, cannotTell: false, loading: ['usda', 'off'] })
    expect(view(state({ state: 'skipped', hits: [] }, loading)).nothingFound).toBe(false)
  })
  it('every source answered with nothing is truly nothing found', () => {
    expect(view(state(empty, empty))).toMatchObject({ nothingFound: true, cannotTell: false })
    expect(view(state({ state: 'skipped', hits: [] }, empty))).toMatchObject({ nothingFound: true, skipped: ['usda'] })
  })
  it('an empty list because a source FAILED is not reported as nothing found', () => {
    const v = view(state({ state: 'skipped', hits: [] }, err))
    expect(v).toMatchObject({ nothingFound: false, cannotTell: true })
    expect(v.errors).toEqual([{ id: 'off', error: 'Open Food Facts did not answer in time', kind: 'timeout' }])
  })
  it('one failed, one answered with nothing: still cannot tell', () => {
    expect(view(state(empty, err))).toMatchObject({ nothingFound: false, cannotTell: true })
  })
  it('results with a failed source: show the results and name the failure', () => {
    const v = view(state({ state: 'ok', hits: [h('usda', 'u', 2100)] }, err))
    expect(v.results).toHaveLength(1)
    expect(v.errors).toHaveLength(1)
    expect(v.cannotTell).toBe(false)
  })
  it('names both sources', () => { expect(NAME).toEqual({ off: 'Open Food Facts', usda: 'USDA' }) })
})
