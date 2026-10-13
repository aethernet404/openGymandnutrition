// @vitest-environment happy-dom
//
// The diary screens against a mocked nutrition API: what they ask for, what they show, and what
// they send. Written the way views/CheckIn.test.jsx is — IS_REACT_ACT_ENVIRONMENT, native value
// setters for inputs, and the app's stores/sheets mocked at the module edge.
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const m = vi.hoisted(() => ({
  user: { id: 'u1', name: 'Me', admin: false },
  unit: 'kg',
  sheets: [],
  downscale: vi.fn(),
  copy: vi.fn(async () => true),
  decode: vi.fn(),
  toast: vi.fn(),
  confirm: vi.fn(),
  api: {
    getDay: vi.fn(), getConfig: vi.fn(), addEntries: vi.fn(), updateEntry: vi.fn(), deleteEntry: vi.fn(),
    listFoods: vi.fn(), createFood: vi.fn(), updateFood: vi.fn(), deleteFood: vi.fn(), getGoals: vi.fn(), putGoals: vi.fn(),
    getAdmin: vi.fn(), putAdmin: vi.fn(), getRange: vi.fn(), searchFoods: vi.fn(), lookupBarcode: vi.fn(), testUsda: vi.fn(), analyze: vi.fn(), setCoachShare: vi.fn(), createHealthToken: vi.fn(), revokeHealthToken: vi.fn(), putHealthSettings: vi.fn(), getHealthToken: vi.fn(), getWeight: vi.fn(), getHealthDebug: vi.fn(), clearHealthDebug: vi.fn()
  }
}))

vi.mock('../store/useStore.js', () => {
  const snap = () => ({ user: m.user, S: { unit: m.unit } })
  const useStore = sel => (sel ? sel(snap()) : snap())
  useStore.getState = snap
  return { useStore }
})
vi.mock('../store/useUI.js', () => {
  const snap = () => ({
    toast: (...a) => m.toast(...a),
    openSheet: render => { m.sheets.push(render); return { id: 's', close: () => {} } }
  })
  const useUI = sel => (sel ? sel(snap()) : snap())
  useUI.getState = snap
  return { useUI }
})
vi.mock('../sheets.jsx', () => ({ confirmSheet: (...a) => m.confirm(...a) }))
vi.mock('./api.js', () => m.api)
vi.mock('../lib/clipboard.js', () => ({ copyText: (...a) => m.copy(...a) }))
vi.mock('./image.js', () => ({ downscaleToJpeg: (...a) => m.downscale(...a) }))
vi.mock('./barcode-decode.js', () => ({ decodeFile: (...a) => m.decode(...a) }))

const { default: Diary } = await import('./Diary.jsx')
const { default: NutritionHomeCard } = await import('./HomeCard.jsx')
const { default: Nutrition } = await import('./Nutrition.jsx')
const { default: Goals } = await import('./Goals.jsx')
const { default: Foods } = await import('./Foods.jsx')
const { default: Health } = await import('./Health.jsx')
const { openAddSheet, openEditEntry, openFoodSheet } = await import('./sheets.jsx')

let host, root
const flush = async () => { await act(async () => { await new Promise(r => setTimeout(r, 0)) }) }
const mount = async (ui, path = '/') => {
  await act(async () => {
    root.render(<MemoryRouter initialEntries={[path]}>{ui}<Where /></MemoryRouter>)
  })
  await flush()
}
let where = ''
function Where() { const l = useLocation(); where = l.pathname + l.search; return null }
const text = () => host.textContent
const click = async el => { await act(async () => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })) }); await flush() }
const byText = (sel, s) => { const all = [...host.querySelectorAll(sel)]; return all.find(e => e.textContent.trim() === s) || all.find(e => e.textContent.includes(s)) }
const setValue = async (el, v) => {
  const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  await act(async () => { Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })) })
}
/** Render the most recently opened sheet into the page. */
let shown = []
async function showSheet(close = vi.fn()) {
  const render = m.sheets.at(-1)
  for (const old of shown) { act(() => old.r.unmount()); old.el.remove() }   // one sheet on screen, as in the app
  shown = []
  const sheet = document.createElement('div'); host.appendChild(sheet)
  const r = createRoot(sheet)
  await act(async () => { r.render(render(close)) })
  await flush()
  const out = { el: sheet, close, r }
  shown.push(out)
  return out
}

const today = (() => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0') })()
const dayOf = (over = {}) => ({
  date: today,
  entries: [
    { id: 'e1', meal: 'breakfast', name: 'Oats', source: 'quick', calories: 300, protein_g: 10, carbs_g: 50, fat_g: 5, qty: 1 },
    { id: 'e2', meal: 'lunch', name: 'Chicken wrap', source: 'ai', calories: 650, protein_g: 40, carbs_g: 60, fat_g: 20, qty: 1 }
  ],
  totals: { calories: 950, protein_g: 50, carbs_g: 110, fat_g: 25 },
  byMeal: { breakfast: { calories: 300, protein_g: 10, carbs_g: 50, fat_g: 5 }, lunch: { calories: 650, protein_g: 40, carbs_g: 60, fat_g: 20 }, dinner: { calories: 0, protein_g: 0, carbs_g: 0, fat_g: 0 }, snack: { calories: 0, protein_g: 0, carbs_g: 0, fat_g: 0 } },
  goals: { calories: 2400, protein_g: 160, carbs_g: null, fat_g: 70 },
  health: null, eatBack: { enabled: false, percent: 50 },
  ...over
})

beforeEach(() => {
  host = document.createElement('div'); document.body.appendChild(host)
  root = createRoot(host)
  m.sheets.length = 0
  shown = []
  m.user = { id: 'u1', name: 'Me', admin: false }
  m.unit = 'kg'
  for (const f of Object.values(m.api)) f.mockReset()
  m.toast.mockReset(); m.confirm.mockReset(); m.downscale.mockReset(); m.decode.mockReset()
  globalThis.URL.revokeObjectURL = globalThis.URL.revokeObjectURL || (() => {})
  m.api.getDay.mockResolvedValue(dayOf())
  m.api.getWeight.mockResolvedValue({ latest: null, readings: [], count: 0 })
  m.api.getConfig.mockResolvedValue({ ai: { limit: 30, used: 3, remaining: 27, available: true, reason: null } })
})
afterEach(() => { act(() => root.unmount()); host.remove() })

describe('Diary', () => {
  it("loads today and shows calories against the goal, the macros and each meal's entries", async () => {
    await mount(<Diary />)
    expect(m.api.getDay).toHaveBeenCalledWith(today)
    const t = text()
    expect(t).toContain('950')
    expect(t).toMatch(/2,?400/)
    expect(t).toMatch(/1,?450/)           // left
    expect(t).toContain('Oats')
    expect(t).toContain('Chicken wrap')
    expect(t).toContain('Breakfast'); expect(t).toContain('Snacks')
    expect(host.querySelector('[aria-label="Estimated by AI"]')).toBeTruthy()
  })

  it('says "over" and turns the bar once the goal is passed', async () => {
    m.api.getDay.mockResolvedValue(dayOf({ totals: { calories: 2600, protein_g: 50, carbs_g: 110, fat_g: 25 } }))
    await mount(<Diary />)
    expect(text()).toContain('over')
    expect(host.querySelector('.nut-bar.over')).toBeTruthy()
  })

  it('invites you to set goals when there are none', async () => {
    m.api.getDay.mockResolvedValue(dayOf({ goals: null }))
    await mount(<Diary />)
    await click(byText('button', 'Set goals'))
    expect(where).toBe('/nutrition/goals')
  })

  it('previous / next day ask for that day, and Today comes back', async () => {
    await mount(<Diary />)
    await click(host.querySelector('[aria-label="Previous day"]'))
    const prev = m.api.getDay.mock.calls.at(-1)[0]
    expect(prev < today).toBe(true)
    expect(where).toContain('d=' + prev)
    expect(text()).toContain('Yesterday')
    await click(byText('button', 'Today'))
    expect(m.api.getDay.mock.calls.at(-1)[0]).toBe(today)
  })

  it('ignores a slow answer for a day you already left', async () => {
    let late
    m.api.getDay.mockImplementationOnce(() => new Promise(r => { late = r }))
    await mount(<Diary />)
    m.api.getDay.mockResolvedValue(dayOf({ date: '2000-01-01', entries: [], totals: { calories: 7, protein_g: 0, carbs_g: 0, fat_g: 0 }, byMeal: {} }))
    await click(host.querySelector('[aria-label="Previous day"]'))
    await act(async () => { late(dayOf()) }); await flush()
    expect(text()).not.toContain('Oats')
  })

  it('Add opens the sheet for that meal and that day; tapping an entry edits it', async () => {
    await mount(<Diary />)
    await click(host.querySelector('[aria-label="Add to dinner"]'))
    expect(m.sheets.length).toBe(1)
    const s = await showSheet()
    expect(s.el.textContent).toContain('Add food')
    expect(s.el.textContent).toContain('Dinner')
    await click(byText('.nut-entry', 'Oats'))
    expect(m.sheets.length).toBe(2)
  })

  it('shows a clear message when nutrition is switched off, and an error with retry otherwise', async () => {
    m.api.getDay.mockRejectedValue(Object.assign(new Error('off'), { status: 503, data: { code: 'off' } }))
    await mount(<Diary />)
    expect(text()).toContain('switched off')
    act(() => root.unmount()); root = createRoot(host)
    m.api.getDay.mockRejectedValueOnce(new Error('HTTP 500')).mockResolvedValue(dayOf())
    await mount(<Diary />)
    expect(text()).toContain('Could not load this day')
    await click(byText('button', 'Try again'))
    expect(text()).toContain('Oats')
  })
})

describe('sheets', () => {
  it('quick add sends calories and macros for the chosen day and meal, refreshes, and closes', async () => {
    const onSaved = vi.fn()
    m.api.addEntries.mockResolvedValue({})
    openAddSheet({ date: '2026-10-12', meal: 'lunch', onSaved })
    const s = await showSheet()
    await click(byText('button', 'Quick add'))
    const inputs = s.el.querySelectorAll('.nut-input input')
    await setValue(inputs[0], '420'); await setValue(inputs[1], '30')
    await setValue(s.el.querySelector('input[placeholder="Name (optional)"]'), 'Burrito')
    await click(byText('button', 'Add to lunch'))
    expect(m.api.addEntries).toHaveBeenCalledWith({ date: '2026-10-12', meal: 'lunch', name: 'Burrito', source: 'quick', calories: 420, protein_g: 30, carbs_g: 0, fat_g: 0 })
    expect(onSaved).toHaveBeenCalled(); expect(s.close).toHaveBeenCalled()
  })

  it('quick add refuses an empty calories box and sends nothing', async () => {
    openAddSheet({ date: '2026-10-12', meal: 'lunch', onSaved: vi.fn() })
    const s = await showSheet()
    await click(byText('button', 'Quick add'))
    await click(byText('button', 'Add to lunch'))
    expect(m.api.addEntries).not.toHaveBeenCalled()
    expect(m.toast).toHaveBeenCalledWith('Enter the calories')
    expect(s.close).not.toHaveBeenCalled()
  })

  it('a server error keeps the sheet open and says why', async () => {
    m.api.addEntries.mockRejectedValue(new Error('a day can hold at most 200 entries'))
    openAddSheet({ date: '2026-10-12', meal: 'lunch', onSaved: vi.fn() })
    const s = await showSheet()
    await click(byText('button', 'Quick add'))
    await setValue(s.el.querySelectorAll('.nut-input input')[0], '100')
    await click(byText('button', 'Add to lunch'))
    expect(m.toast).toHaveBeenCalledWith('a day can hold at most 200 entries')
    expect(s.close).not.toHaveBeenCalled()
  })

  it('from my foods: pick, set servings, add by foodId', async () => {
    const food = { id: 'f1', name: 'Protein shake', brand: '', source: 'custom', serving: { label: '1 scoop', grams: 30 }, per: { calories: 120, protein_g: 24, carbs_g: 3, fat_g: 1.5 } }
    m.api.listFoods.mockResolvedValue({ foods: [food] })
    m.api.addEntries.mockResolvedValue({})
    openAddSheet({ date: '2026-10-12', meal: 'snack', onSaved: vi.fn() })
    const s = await showSheet()
    await click(byText('button', 'My foods'))
    await flush()
    expect(m.api.listFoods).toHaveBeenCalledWith('recent', '')
    await click(byText('.nut-pick', 'Protein shake'))
    expect(s.el.textContent).toContain('120')
    await click(byText('button', 'Add to snacks'))
    expect(m.api.addEntries).toHaveBeenCalledWith({ date: '2026-10-12', meal: 'snack', source: 'food', foodId: 'f1', qty: 1 })
  })

  it('edit saves changes, can move the day, and delete asks first', async () => {
    const entry = { id: 'e1', meal: 'breakfast', name: 'Oats', source: 'quick', calories: 300, protein_g: 10, carbs_g: 50, fat_g: 5, qty: 1 }
    const onSaved = vi.fn()
    m.api.updateEntry.mockResolvedValue({}); m.api.deleteEntry.mockResolvedValue({})
    openEditEntry({ entry, date: '2026-10-12', onSaved })
    const s = await showSheet()
    await setValue(s.el.querySelectorAll('.nut-input input')[0], '350')
    await click(byText('button', 'Save'))
    expect(m.api.updateEntry).toHaveBeenCalledWith('2026-10-12', 'e1', { meal: 'breakfast', name: 'Oats', calories: 350, protein_g: 10, carbs_g: 50, fat_g: 5 })

    openEditEntry({ entry, date: '2026-10-12', onSaved })
    const s2 = await showSheet()
    await setValue(s2.el.querySelector('input[type="date"]'), '2026-10-13')
    await click(byText('button', 'Save'))
    expect(m.api.updateEntry.mock.calls.at(-1)[2].newDate).toBe('2026-10-13')

    await click(byText('button', 'Delete'))
    expect(m.confirm).toHaveBeenCalled()
    expect(m.api.deleteEntry).not.toHaveBeenCalled()
    await m.confirm.mock.calls[0][0].onConfirm()
    expect(m.api.deleteEntry).toHaveBeenCalledWith('2026-10-12', 'e1')
  })

  it('a new custom food posts per-serving macros; a lookup food is read-only', async () => {
    m.api.createFood.mockResolvedValue({})
    openFoodSheet({ onSaved: vi.fn() })
    const s = await showSheet()
    await setValue(s.el.querySelector('input[placeholder="Name"]'), 'Oats')
    const nums = s.el.querySelectorAll('.nut-input input[inputmode]')
    await setValue(nums[1], '150')   // [0] is grams
    await click(byText('button', 'Save'))
    expect(m.api.createFood).toHaveBeenCalledWith({ name: 'Oats', brand: '', serving: '1 serving', grams: null, ext: null, per: { calories: 150, protein_g: 0, carbs_g: 0, fat_g: 0 } })

    openFoodSheet({ food: { id: 'x', name: 'Yogurt', brand: 'B', source: 'off', serving: { label: '1 pot', grams: 150 }, per: { calories: 90, protein_g: 5, carbs_g: 12, fat_g: 2 } }, onSaved: vi.fn() })
    const ro = await showSheet()
    expect(ro.el.textContent).toContain('cannot be edited')
    expect(byText('button', 'Save') === undefined || ![...ro.el.querySelectorAll('button')].some(b => b.textContent === 'Save')).toBe(true)
  })
})

const NUTELLA = { source: 'off', kind: 'off', rank: 1180, ext: '3017620422003', name: 'Nutella', brand: 'Ferrero', bases: [
  { label: '15 g', grams: 15, per: { calories: 81, protein_g: 0.9, carbs_g: 8.6, fat_g: 4.6 } },
  { label: '100 g', grams: 100, per: { calories: 539, protein_g: 6.3, carbs_g: 57.5, fat_g: 30.9 } }
] }
const wait = ms => act(async () => { await new Promise(r => setTimeout(r, ms)) })
// The app asks for each source separately; this answers each the way the server would.
//   spec: an array of hits | 'skipped' (no USDA key) | { fail, kind } | an Error (the request itself failed)
const mockSearch = ({ off = [], usda = 'skipped' } = {}) => m.api.searchFoods.mockImplementation(async (q, source) => {
  const spec = source === 'off' ? off : usda
  if (spec instanceof Error) throw spec
  if (spec === 'skipped') return { q, results: [], sources: { [source]: { ok: false, skipped: 'no-key' } } }
  if (spec && spec.fail) return { q, results: [], sources: { [source]: { ok: false, kind: spec.kind || 'down', error: spec.fail } } }
  return { q, results: spec, sources: { [source]: { ok: true, count: spec.length } } }
})

describe('search, portions and barcodes', () => {
  async function openSearch() {
    openAddSheet({ date: '2026-10-12', meal: 'snack', onSaved: vi.fn() })
    return showSheet()
  }
  const typeSearch = async (s, v) => { await setValue(s.el.querySelector('input[placeholder="Search foods"]'), v); await wait(520) }

  it('opens on Search, searches after a pause, and says USDA is off when no key is set', async () => {
    mockSearch({ off: [NUTELLA] })
    const s = await openSearch()
    expect(s.el.textContent).toContain('Search Open Food Facts and USDA')
    await typeSearch(s, 'nutella')
    expect(m.api.searchFoods).toHaveBeenCalledTimes(2)                       // one request per source, started together
    expect(m.api.searchFoods).toHaveBeenCalledWith('nutella', 'off')
    expect(m.api.searchFoods).toHaveBeenCalledWith('nutella', 'usda')
    expect(s.el.textContent).toContain('Nutella')
    expect(s.el.textContent).toContain('Ferrero · 15 g')
    expect(s.el.textContent).toContain('an admin has not added a key')
  })

  it('does not search for a single letter, and a fast typist makes one request', async () => {
    mockSearch({ off: [NUTELLA] })
    const s = await openSearch()
    await setValue(s.el.querySelector('input[placeholder="Search foods"]'), 'n')
    await wait(520)
    expect(m.api.searchFoods).not.toHaveBeenCalled()
    await setValue(s.el.querySelector('input[placeholder="Search foods"]'), 'nu')
    await setValue(s.el.querySelector('input[placeholder="Search foods"]'), 'nut')
    await setValue(s.el.querySelector('input[placeholder="Search foods"]'), 'nutella')
    await wait(520)
    expect(m.api.searchFoods).toHaveBeenCalledTimes(2)                       // 'nutella' once, for both sources
    expect(new Set(m.api.searchFoods.mock.calls.map(c => c[0]))).toEqual(new Set(['nutella']))
  })

  it('shows where to fix a missing USDA key to an admin', async () => {
    m.user = { id: 'a', admin: true }
    mockSearch({ off: [NUTELLA] })
    const s = await openSearch()
    await typeSearch(s, 'nutella')
    expect(s.el.textContent).toContain('Goals → Admin')
  })

  it('a source that is down is named, the other results still show, and Retry asks only that source', async () => {
    mockSearch({ off: { fail: 'Open Food Facts did not answer in time', kind: 'timeout' }, usda: [{ ...NUTELLA, source: 'usda', kind: 'sr', ext: '1', name: 'Hazelnut spread', rank: 2100 }] })
    const s = await openSearch()
    await typeSearch(s, 'hazelnut spread')
    expect(s.el.textContent).toContain('Open Food Facts did not answer in time')
    expect(s.el.textContent).toContain('Hazelnut spread')
    expect(m.api.searchFoods).toHaveBeenCalledTimes(2)
    mockSearch({ off: [{ ...NUTELLA, name: 'Hazelnut spread', ext: '2' }], usda: [{ ...NUTELLA, source: 'usda', kind: 'sr', ext: '1', name: 'Hazelnut spread', rank: 2100 }] })
    await click(byText('button', 'Retry'))
    expect(m.api.searchFoods).toHaveBeenCalledTimes(3)
    expect(m.api.searchFoods.mock.calls.at(-1)).toEqual(['hazelnut spread', 'off'])     // only the one that failed
    expect(s.el.textContent).not.toContain('did not answer in time')
    expect(s.el.querySelectorAll('.nut-pick')).toHaveLength(2)
  })

  it('results appear as each source answers: USDA is on screen while Open Food Facts is still working', async () => {
    let finishOff
    m.api.searchFoods.mockImplementation((q, source) => (source === 'off'
      ? new Promise(r => { finishOff = () => r({ q, results: [NUTELLA], sources: { off: { ok: true, count: 1 } } }) })
      : Promise.resolve({ q, results: [{ ...NUTELLA, source: 'usda', kind: 'sr', ext: '1', name: 'Hazelnut spread', rank: 2100 }], sources: { usda: { ok: true, count: 1 } } })))
    const s = await openSearch()
    await typeSearch(s, 'hazelnut')
    expect(s.el.textContent).toContain('Hazelnut spread')
    expect(s.el.querySelector('[role="status"]').textContent).toContain('Searching Open Food Facts…')
    await act(async () => { finishOff() }); await flush()
    expect(s.el.querySelector('[role="status"]')).toBeNull()
    expect([...s.el.querySelectorAll('.nut-pick-t')].map(e => e.textContent)).toEqual(['Hazelnut spread', 'Nutella'])   // merged by rank: reference food first
  })

  it('a source that stays slow is called slow, not left as an unexplained spinner', async () => {
    vi.useFakeTimers()
    try {
      m.api.searchFoods.mockImplementation(() => new Promise(() => {}))
      openAddSheet({ date: '2026-10-12', meal: 'snack', onSaved: vi.fn() })
      const render = m.sheets.at(-1)
      const el = document.createElement('div'); host.appendChild(el)
      const r = createRoot(el)
      await act(async () => { r.render(render(vi.fn())) })
      await act(async () => { await vi.advanceTimersByTimeAsync(10) })
      await setValue(el.querySelector('input[placeholder="Search foods"]'), 'egg')
      await act(async () => { await vi.advanceTimersByTimeAsync(500) })
      expect(el.querySelector('[role="status"]').textContent).toContain('Searching USDA and Open Food Facts…')
      await act(async () => { await vi.advanceTimersByTimeAsync(6500) })
      expect(el.querySelector('[role="status"]').textContent).toContain('USDA and Open Food Facts are slow right now')
      act(() => r.unmount())
    } finally { vi.useRealTimers() }
  })

  it('a rejected key is reported without a Retry (asking again cannot help); a timeout has one', async () => {
    mockSearch({ off: [NUTELLA], usda: { fail: 'USDA FoodData Central rejected the API key', kind: 'auth' } })
    const s = await openSearch()
    await typeSearch(s, 'nutella')
    expect(s.el.textContent).toContain('rejected the API key')
    expect(byText('button', 'Retry')).toBeUndefined()
    expect(s.el.textContent).toContain('Nutella')
  })

  it('a request that never reached the server (offline) is explained, not a blank list', async () => {
    mockSearch({ off: new Error('Failed to fetch'), usda: new Error('Failed to fetch') })
    const s = await openSearch()
    await typeSearch(s, 'nutella')
    expect(s.el.textContent).toContain('Open Food Facts: Failed to fetch')
    expect(s.el.textContent).toContain('The search could not finish')
    expect(s.el.textContent).not.toContain('Nothing found')
    expect(byText('button', 'Quick add')).toBeTruthy()
  })

  it('a 429 is worded kindly and still leaves a way to log', async () => {
    m.api.searchFoods.mockRejectedValue(Object.assign(new Error('HTTP 429'), { status: 429 }))
    const s = await openSearch()
    await typeSearch(s, 'nutella')
    expect(s.el.textContent).toContain('Too many lookups')
    expect(s.el.textContent).not.toContain('Nothing found')
  })

  it('truly nothing found: say so, suggest a simpler word, and offer Describe (AI) and Quick add', async () => {
    mockSearch({ off: [], usda: [] })
    const s = await openSearch()
    await typeSearch(s, 'zzqx pie')
    expect(s.el.textContent).toContain('Nothing found for “zzqx pie”.')
    expect(s.el.textContent).toContain('one simple word')
    expect(byText('button', 'Describe it (AI)').disabled).toBe(false)
    expect(s.el.querySelectorAll('.nut-ways button')).toHaveLength(2)
  })

  it('"Describe it (AI)" opens Describe with the search words already typed in', async () => {
    mockSearch({ off: [], usda: [] })
    const s = await openSearch()
    await typeSearch(s, 'grandma’s lentil soup')
    await click(s.el.querySelector('.nut-ways button'))
    expect(s.el.textContent).toContain('Describe your meal')
    expect(s.el.querySelector('textarea').value).toBe('grandma’s lentil soup')
  })

  it('"Quick add" from the empty result opens quick add with the name filled in', async () => {
    mockSearch({ off: [], usda: [] })
    const s = await openSearch()
    await typeSearch(s, 'lentil soup')
    await click(s.el.querySelectorAll('.nut-ways button')[1])
    expect(s.el.querySelector('input[placeholder="Name (optional)"]').value).toBe('lentil soup')
  })

  it('when the AI is not available, Describe is off here too, with the reason', async () => {
    m.api.getConfig.mockResolvedValue({ ai: { limit: 30, used: 0, remaining: 30, available: false, reason: 'unavailable' } })
    mockSearch({ off: [], usda: [] })
    const s = await openSearch()
    await wait(20)
    await typeSearch(s, 'lentil soup')
    expect(s.el.querySelector('.nut-ways button').disabled).toBe(true)
    expect(s.el.querySelector('.nut-ways').textContent).toContain('Coach switched on')
    expect(s.el.querySelectorAll('.nut-ways button')[1].disabled).toBe(false)
  })

  it('pick a hit, choose the 100 g portion, set grams, and the entry carries the snapshot and qty', async () => {
    mockSearch({ off: [NUTELLA] })
    m.api.addEntries.mockResolvedValue({})
    const onSaved = vi.fn()
    openAddSheet({ date: '2026-10-12', meal: 'snack', onSaved })
    const s = await showSheet()
    await typeSearch(s, 'nutella')
    await click(byText('.nut-pick', 'Nutella'))
    expect(s.el.textContent).toContain('Open Food Facts')
    expect(s.el.textContent).toContain('81')                       // one 15 g serving
    // 2 servings of 15 g = 30 g; typing 150 g in the 15 g base is 10 servings
    const grams = s.el.querySelector('.nut-datefield input')
    expect(grams.value).toBe('15')
    await setValue(grams, '150')
    expect(s.el.textContent).toContain('810')                      // 10 × 81
    await click(byText('button', 'Add to snacks'))
    expect(m.api.addEntries).toHaveBeenCalledWith({
      date: '2026-10-12', meal: 'snack', source: 'food', qty: 10,
      food: { name: 'Nutella', brand: 'Ferrero', source: 'off', ext: '3017620422003', serving: '15 g', grams: 15, per: NUTELLA.bases[0].per }
    })
    expect(onSaved).toHaveBeenCalled()
  })

  it('a food whose only portion has no weight shows servings but no grams box', async () => {
    const pot = { source: 'usda', kind: 'branded', rank: 1100, ext: '9', name: 'Yogurt', brand: '', bases: [{ label: '1 pot', grams: null, per: { calories: 90, protein_g: 5, carbs_g: 12, fat_g: 2 } }] }
    mockSearch({ usda: [pot] })
    const s = await openSearch()
    await typeSearch(s, 'yogurt')
    await click(byText('.nut-pick', 'Yogurt'))
    expect(s.el.querySelector('.nut-datefield')).toBeNull()
    expect(s.el.textContent).toContain('One serving: 1 pot')
  })

  it('the scan button always offers a photo of the barcode and the typing box — even with no live scanner at all (an iPhone: a camera API, no BarcodeDetector)', async () => {
    const nav = navigator.mediaDevices
    Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia: vi.fn() }, configurable: true })
    delete globalThis.BarcodeDetector
    const s = await openSearch()
    await wait(20)
    Object.defineProperty(navigator, 'mediaDevices', { value: nav, configurable: true })
    await click(s.el.querySelector('[aria-label="Scan a barcode"]'))
    expect(byText('button', 'Take a photo of the barcode')).toBeTruthy()
    expect(byText('button', 'Choose a photo')).toBeTruthy()
    expect(byText('button', 'Live scan')).toBeUndefined()
    expect(s.el.textContent).toContain('iPhone Safari does not')              // why live is off, in words
    const camera = s.el.querySelectorAll('input[type="file"]')[0]
    expect(camera.getAttribute('capture')).toBe('environment')                // the rear camera, like the meal photo
    expect(camera.accept).toBe('image/*')
    expect(s.el.querySelectorAll('input[type="file"]')[1].hasAttribute('capture')).toBe(false)
    expect(s.el.querySelector('input[placeholder="Barcode number"]')).toBeTruthy()
  })

  it('a bad typed number is refused before any request', async () => {
    const s = await openSearch()
    await click(s.el.querySelector('[aria-label="Scan a barcode"]'))
    await setValue(s.el.querySelector('input[placeholder="Barcode number"]'), '12ab')
    await click(byText('button', 'Look up'))
    expect(m.toast).toHaveBeenCalledWith('A barcode is 8 to 14 digits.')
    expect(m.api.lookupBarcode).not.toHaveBeenCalled()
  })

  const photoOf = async (s, which = 0) => {
    const input = s.el.querySelectorAll('input[type="file"]')[which]
    Object.defineProperty(input, 'files', { value: [new File(['x'], 'bc.jpg', { type: 'image/jpeg' })], configurable: true })
    await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })) }); await flush(); await flush()
  }

  it('a photo of a barcode is decoded in the page and looked up straight away', async () => {
    m.decode.mockResolvedValue({ ok: true, code: '3017620422003', format: 'EAN13', edge: 1600 })
    m.api.lookupBarcode.mockResolvedValue({ code: '3017620422003', found: true, product: NUTELLA })
    const s = await openSearch()
    await click(s.el.querySelector('[aria-label="Scan a barcode"]'))
    await photoOf(s)
    expect(m.decode).toHaveBeenCalledTimes(1)
    expect(m.decode.mock.calls[0][0].name).toBe('bc.jpg')
    expect(m.api.lookupBarcode).toHaveBeenCalledWith('3017620422003')
    expect(s.el.textContent).toContain('Nutella')
    expect(byText('button', 'Take a photo of the barcode')).toBeUndefined()   // the panel closed once it had a code
  })

  it('a gallery photo takes the same path', async () => {
    m.decode.mockResolvedValue({ ok: true, code: '96385074', format: 'EAN8', edge: 1600 })
    m.api.lookupBarcode.mockResolvedValue({ code: '96385074', found: false, reason: 'unknown' })
    const s = await openSearch()
    await click(s.el.querySelector('[aria-label="Scan a barcode"]'))
    await photoOf(s, 1)
    expect(m.api.lookupBarcode).toHaveBeenCalledWith('96385074')
    expect(s.el.textContent).toContain('Barcode 96385074 is not in Open Food Facts')
  })

  it('no barcode in the photo: say so, offer Retake, keep the typing box, look nothing up', async () => {
    m.decode.mockResolvedValue({ ok: false, reason: 'none', message: '' })
    const s = await openSearch()
    await click(s.el.querySelector('[aria-label="Scan a barcode"]'))
    await photoOf(s)
    expect(s.el.textContent).toContain('No barcode found in that photo')
    expect(byText('button', 'Retake the photo')).toBeTruthy()
    expect(s.el.querySelector('input[placeholder="Barcode number"]')).toBeTruthy()
    expect(m.api.lookupBarcode).not.toHaveBeenCalled()
    // and typing from here still works
    m.api.lookupBarcode.mockResolvedValue({ code: '3017620422003', found: true, product: NUTELLA })
    await setValue(s.el.querySelector('input[placeholder="Barcode number"]'), '3017620422003')
    await click(byText('button', 'Look up'))
    expect(s.el.textContent).toContain('Nutella')
  })

  it('a decoder that cannot load shows its real message, and typing still works', async () => {
    m.decode.mockResolvedValue({ ok: false, reason: 'engine', message: 'The barcode reader could not be loaded: Failed to fetch dynamically imported module' })
    const s = await openSearch()
    await click(s.el.querySelector('[aria-label="Scan a barcode"]'))
    await photoOf(s)
    expect(s.el.textContent).toContain('Failed to fetch dynamically imported module')
    expect(s.el.querySelector('input[placeholder="Barcode number"]')).toBeTruthy()
  })

  it('shows "Reading the barcode…" while the decoder works', async () => {
    let finish
    m.decode.mockImplementation(() => new Promise(r => { finish = r }))
    const s = await openSearch()
    await click(s.el.querySelector('[aria-label="Scan a barcode"]'))
    await photoOf(s)
    expect(s.el.textContent).toContain('Reading the barcode')
    expect(byText('button', 'Take a photo of the barcode').disabled).toBe(true)
    await act(async () => { finish({ ok: false, reason: 'none', message: '' }) }); await flush()
    expect(s.el.textContent).not.toContain('Reading the barcode')
  })

  it('where the browser has a barcode reader the live scan is offered as an EXTRA, next to the photo', async () => {
    const nav = navigator.mediaDevices
    Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia: vi.fn() }, configurable: true })
    globalThis.BarcodeDetector = Object.assign(function () {}, { getSupportedFormats: async () => ['ean_13', 'qr_code'] })
    try {
      const s = await openSearch()
      await wait(20)
      await click(s.el.querySelector('[aria-label="Scan a barcode"]'))
      expect(byText('button', 'Live scan')).toBeTruthy()
      expect(byText('button', 'Take a photo of the barcode')).toBeTruthy()
      expect(s.el.querySelector('input[placeholder="Barcode number"]')).toBeTruthy()
    } finally { delete globalThis.BarcodeDetector; Object.defineProperty(navigator, 'mediaDevices', { value: nav, configurable: true }) }
  })

  it('a typed code whose check digit is wrong gets a typo hint when it is not found', async () => {
    m.api.lookupBarcode.mockResolvedValue({ code: '3017620422004', found: false, reason: 'unknown' })
    const s = await openSearch()
    await click(s.el.querySelector('[aria-label="Scan a barcode"]'))
    await setValue(s.el.querySelector('input[placeholder="Barcode number"]'), '3017620422004')
    await click(byText('button', 'Look up'))
    expect(s.el.textContent).toContain('check digit does not add up')
  })

  it('a typed barcode finds the product, which can be added', async () => {
    m.api.lookupBarcode.mockResolvedValue({ code: '3017620422003', found: true, product: NUTELLA })
    m.api.addEntries.mockResolvedValue({})
    const s = await openSearch()
    await click(s.el.querySelector('[aria-label="Scan a barcode"]'))
    await setValue(s.el.querySelector('input[placeholder="Barcode number"]'), '3017 6204 22003')
    await click(byText('button', 'Look up'))
    expect(m.api.lookupBarcode).toHaveBeenCalledWith('3017620422003')
    await click(byText('.nut-pick', 'Nutella'))
    await click(byText('button', 'Add to snacks'))
    expect(m.api.addEntries.mock.calls[0][0].food.ext).toBe('3017620422003')
    expect(m.api.addEntries.mock.calls[0][0].qty).toBe(1)
  })

  it('an unknown barcode says so and offers to save it as your own food, pre-filled', async () => {
    m.api.lookupBarcode.mockResolvedValue({ code: '00000000', found: false, reason: 'unknown' })
    const s = await openSearch()
    await click(s.el.querySelector('[aria-label="Scan a barcode"]'))
    await setValue(s.el.querySelector('input[placeholder="Barcode number"]'), '00000000')
    await click(byText('button', 'Look up'))
    expect(s.el.textContent).toContain('Barcode 00000000 is not in Open Food Facts')
    const before = m.sheets.length
    await click(byText('button', 'Add it as my food'))
    expect(m.sheets.length).toBe(before + 1)
    m.api.createFood.mockResolvedValue({})
    const f = await showSheet()
    await setValue(f.el.querySelector('input[placeholder="Name"]'), 'Local bread')
    await setValue(f.el.querySelectorAll('.nut-input input[inputmode]')[1], '240')
    await click(byText('button', 'Save'))
    expect(m.api.createFood.mock.calls[0][0]).toMatchObject({ name: 'Local bread', ext: '00000000', per: { calories: 240 } })
  })

  it('a barcode lookup that fails because Open Food Facts is down offers a retry', async () => {
    m.api.lookupBarcode.mockResolvedValueOnce({ code: '12345678', found: false, reason: 'error', kind: 'down', error: 'Open Food Facts is not answering right now' })
      .mockResolvedValue({ code: '12345678', found: true, product: NUTELLA })
    const s = await openSearch()
    await click(s.el.querySelector('[aria-label="Scan a barcode"]'))
    await setValue(s.el.querySelector('input[placeholder="Barcode number"]'), '12345678')
    await click(byText('button', 'Look up'))
    expect(s.el.textContent).toContain('Open Food Facts is not answering right now')
    await click(byText('button', 'Try again'))
    expect(s.el.textContent).toContain('Nutella')
  })
})

const DRAFT = { name: 'Eggs on toast', confidence: 'medium', notFood: false, notes: 'oil is a guess', warnings: [],
  items: [
    { name: 'Fried egg', portion: '2 large', grams: 100, calories: 180, protein_g: 12.5, carbs_g: 1, fat_g: 14 },
    { name: 'Toast', portion: '1 slice', grams: null, calories: 80, protein_g: 3, carbs_g: 14, fat_g: 1 }
  ] }
const AI = { limit: 30, used: 4, remaining: 26 }
const apiError = (message, status, data, code) => Object.assign(new Error(message), { status, data, ...(code ? { code } : {}) })

describe('AI logging', () => {
  async function open(onSaved = vi.fn()) {
    openAddSheet({ date: '2026-10-12', meal: 'lunch', onSaved })
    const s = await showSheet()
    return { s, onSaved }
  }
  const describeIt = async (s, text = 'two eggs and toast') => {
    await click(byText('button', 'Describe'))
    await setValue(s.el.querySelector('textarea'), text)
  }

  it('Photo and Describe sit above the tabs with today’s allowance', async () => {
    const { s } = await open()
    expect(byText('button', 'Photo')).toBeTruthy()
    expect(byText('button', 'Describe')).toBeTruthy()
    expect(s.el.textContent).toContain('27 of 30 AI analyses left today')
  })

  it('the buttons are off, with the reason, when the AI cannot run or today’s limit is used', async () => {
    m.api.getConfig.mockResolvedValue({ ai: { limit: 30, used: 0, remaining: 30, available: false, reason: 'unavailable' } })
    const { s } = await open()
    expect(byText('button', 'Photo').disabled).toBe(true)
    expect(s.el.textContent).toContain('Coach switched on and connected to Claude')
    act(() => root.unmount()); root = createRoot(host)
    m.api.getConfig.mockResolvedValue({ ai: { limit: 30, used: 30, remaining: 0, available: true, reason: null } })
    const second = await open()
    expect(byText('button', 'Describe').disabled).toBe(true)
    expect(second.s.el.textContent).toContain('used all of today’s AI analyses')
    expect(byText('button', 'Search'), 'manual logging is still there').toBeTruthy()
  })

  it('Describe → estimate → editable review; NOTHING is saved until Save, then the edits are what is saved', async () => {
    m.api.analyze.mockResolvedValue({ draft: DRAFT, ai: AI, ms: 5000, calls: 1 })
    m.api.addEntries.mockResolvedValue({})
    const { s, onSaved } = await open()
    await describeIt(s)
    await click(byText('button', 'Estimate calories & macros'))
    expect(m.api.analyze).toHaveBeenCalledWith({ kind: 'text', text: 'two eggs and toast' })
    expect(s.el.textContent).toContain('Check the estimate')
    expect(s.el.textContent).toContain('Medium confidence')
    expect(s.el.textContent).toContain('oil is a guess')
    expect(s.el.textContent).toContain('260')
    expect(m.api.addEntries).not.toHaveBeenCalled()

    // fix the egg's calories: first item's first number box
    const items = s.el.querySelectorAll('.nut-item')
    await setValue(items[0].querySelectorAll('.nut-fields')[1].querySelector('input'), '200')
    expect(s.el.textContent).toContain('280')
    expect(m.api.addEntries).not.toHaveBeenCalled()
    await click(byText('button', 'Save to diary'))
    expect(m.api.addEntries).toHaveBeenCalledTimes(1)
    const body = m.api.addEntries.mock.calls[0][0]
    expect(body).toMatchObject({ date: '2026-10-12', meal: 'lunch' })
    expect(body.entries.map(e => [e.name, e.calories, e.source, e.confidence])).toEqual([['Fried egg', 200, 'ai', 'medium'], ['Toast', 80, 'ai', 'medium']])
    expect(onSaved).toHaveBeenCalled(); expect(s.close).toHaveBeenCalled()
  })

  it('review: remove an item, refuse an unnamed one, show the validator’s warnings', async () => {
    m.api.analyze.mockResolvedValue({ draft: { ...DRAFT, warnings: ['Toast: macros imply about 400 kcal, estimate says 80'] }, ai: AI })
    const { s } = await open()
    await describeIt(s)
    await click(byText('button', 'Estimate calories & macros'))
    expect(s.el.textContent).toContain('macros imply about 400 kcal')
    await click(s.el.querySelectorAll('[aria-label="Remove this item"]')[1])
    expect(s.el.querySelectorAll('.nut-item')).toHaveLength(1)
    await setValue(s.el.querySelector('.nut-item input'), '  ')
    await click(byText('button', 'Save to diary'))
    expect(m.toast).toHaveBeenCalledWith('Item 1 needs a name.')
    expect(m.api.addEntries).not.toHaveBeenCalled()
  })

  it('Discard leaves nothing behind; with edits it asks first', async () => {
    m.api.analyze.mockResolvedValue({ draft: DRAFT, ai: AI })
    const { s } = await open()
    await describeIt(s)
    await click(byText('button', 'Estimate calories & macros'))
    await click(byText('button', 'Discard'))
    expect(m.api.addEntries).not.toHaveBeenCalled()
    expect(s.el.textContent).toContain('Add food')   // back on the add sheet

    await describeIt(s)
    await click(byText('button', 'Estimate calories & macros'))
    await setValue(s.el.querySelector('.nut-item input'), 'Changed')
    await click(byText('button', 'Discard'))
    expect(m.confirm).toHaveBeenCalled()
    expect(s.el.textContent).toContain('Check the estimate')   // still editing until confirmed
    await act(async () => { m.confirm.mock.calls[0][0].onConfirm() }); await flush()
    expect(s.el.textContent).toContain('Add food')
    expect(m.api.addEntries).not.toHaveBeenCalled()
  })

  it('Photo: choose a file, it is shrunk on the device, then sent with the note — and only then', async () => {
    m.downscale.mockResolvedValue({ base64: 'QUJD', bytes: 1234, width: 1280, height: 960, previewUrl: 'blob:p' })
    m.api.analyze.mockResolvedValue({ draft: DRAFT, ai: AI })
    const { s } = await open()
    await click(byText('button', 'Photo'))
    expect(byText('button', 'Estimate calories & macros').disabled).toBe(true)
    const file = new File(['x'], 'meal.heic', { type: 'image/heic' })
    const input = s.el.querySelectorAll('input[type="file"]')[1]
    Object.defineProperty(input, 'files', { value: [file], configurable: true })
    await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })) }); await flush()
    expect(m.downscale).toHaveBeenCalledWith(file)
    expect(m.api.analyze).not.toHaveBeenCalled()
    expect(s.el.querySelector('img').src).toContain('blob:p')
    await setValue(s.el.querySelector('input[placeholder^="Anything"]'), 'no oil')
    await click(byText('button', 'Estimate calories & macros'))
    expect(m.api.analyze).toHaveBeenCalledWith({ kind: 'photo', image: 'QUJD', note: 'no oil' })
    expect(s.el.textContent).toContain('Check the estimate')
  })

  it('a photo the browser cannot read says so and offers manual entry', async () => {
    m.downscale.mockRejectedValue(new Error('Could not read this photo. Try a JPEG or PNG.'))
    const { s } = await open()
    await click(byText('button', 'Photo'))
    const input = s.el.querySelectorAll('input[type="file"]')[0]
    Object.defineProperty(input, 'files', { value: [new File(['x'], 'a.heic')], configurable: true })
    await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })) }); await flush()
    expect(s.el.textContent).toContain('Could not read this photo')
    expect(byText('button', 'Log it by hand')).toBeTruthy()
  })

  it('the daily limit: the message, the new allowance, and no retry — only manual entry, with your words carried over', async () => {
    m.api.analyze.mockRejectedValue(apiError('You have used all of today’s AI analyses.', 429, { code: 'cap', ai: { limit: 30, used: 30, remaining: 0 } }))
    const { s } = await open()
    await describeIt(s, 'big bowl of oats')
    await click(byText('button', 'Estimate calories & macros'))
    expect(s.el.textContent).toContain('used all of today’s AI analyses')
    expect(s.el.textContent).toContain('0 of 30 AI analyses left today')
    expect(byText('button', 'Try again')).toBeUndefined()
    await click(byText('button', 'Log it by hand'))
    expect(s.el.querySelector('input[placeholder="Name (optional)"]').value).toBe('big bowl of oats')
    expect(byText('button', 'Photo').disabled).toBe(true)
  })

  it('a timeout offers Try again, Describe instead (for a photo) and manual entry', async () => {
    m.downscale.mockResolvedValue({ base64: 'QUJD', bytes: 1, width: 1, height: 1, previewUrl: 'blob:p' })
    m.api.analyze.mockRejectedValueOnce(apiError('The AI took too long. Try again, or log by hand.', 504, { code: 'timeout', ai: { limit: 30, used: 5, remaining: 25 } }))
      .mockResolvedValue({ draft: DRAFT, ai: AI })
    const { s } = await open()
    await click(byText('button', 'Photo'))
    const input = s.el.querySelectorAll('input[type="file"]')[1]
    Object.defineProperty(input, 'files', { value: [new File(['x'], 'a.jpg')], configurable: true })
    await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })) }); await flush()
    await setValue(s.el.querySelector('input[placeholder^="Anything"]'), 'two slices')
    await click(byText('button', 'Estimate calories & macros'))
    expect(s.el.textContent).toContain('took too long')
    expect(byText('button', 'Describe it instead')).toBeTruthy()
    await click(byText('button', 'Try again'))
    expect(m.api.analyze).toHaveBeenCalledTimes(2)
    expect(s.el.textContent).toContain('Check the estimate')
  })

  it('"Describe it instead" moves the photo note into the text box', async () => {
    m.downscale.mockResolvedValue({ base64: 'QUJD', bytes: 1, width: 1, height: 1, previewUrl: 'blob:p' })
    m.api.analyze.mockRejectedValue(apiError('The AI could not answer right now.', 502, { code: 'provider' }))
    const { s } = await open()
    await click(byText('button', 'Photo'))
    const input = s.el.querySelectorAll('input[type="file"]')[1]
    Object.defineProperty(input, 'files', { value: [new File(['x'], 'a.jpg')], configurable: true })
    await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })) }); await flush()
    await setValue(s.el.querySelector('input[placeholder^="Anything"]'), 'chicken wrap')
    await click(byText('button', 'Estimate calories & macros'))
    await click(byText('button', 'Describe it instead'))
    expect(s.el.querySelector('textarea').value).toBe('chicken wrap')
  })

  it('auth and unavailable errors offer no retry, only manual entry', async () => {
    for (const [code, text] of [['auth', 'The AI account on this server needs reconnecting (Admin → Coach).'], ['unavailable', 'AI logging is not available on this server.']]) {
      act(() => root.unmount()); root = createRoot(host); m.api.analyze.mockReset()
      m.api.analyze.mockRejectedValue(apiError(text, 502, { code, ai: AI }))
      const { s } = await open()
      await describeIt(s)
      await click(byText('button', 'Estimate calories & macros'))
      expect(s.el.textContent).toContain(text)
      expect(byText('button', 'Try again'), code).toBeUndefined()
      expect(byText('button', 'Log it by hand'), code).toBeTruthy()
    }
  })

  it('the client giving up before the server answers says the analysis may still count', async () => {
    m.api.analyze.mockRejectedValue(apiError('The server did not answer in time.', undefined, undefined, 'timeout'))
    const { s } = await open()
    await describeIt(s)
    await click(byText('button', 'Estimate calories & macros'))
    expect(s.el.textContent).toContain('may still finish on the server and count')
    expect(byText('button', 'Try again')).toBeTruthy()
  })

  it('"not food" is its own answer, with a way to try again or log by hand', async () => {
    m.api.analyze.mockResolvedValue({ draft: { name: '', confidence: 'low', notFood: true, notes: 'a cat on a sofa', items: [], warnings: [] }, ai: AI })
    const { s } = await open()
    await describeIt(s)
    await click(byText('button', 'Estimate calories & macros'))
    expect(s.el.textContent).toContain('does not look like food')
    expect(s.el.textContent).toContain('a cat on a sofa')
    expect(byText('button', 'Save to diary')).toBeUndefined()
    expect(byText('button', 'Try another')).toBeTruthy()
  })

  it('"Log it by hand instead" is on the very first screen of the AI flow', async () => {
    const { s } = await open()
    await click(byText('button', 'Describe'))
    await setValue(s.el.querySelector('textarea'), 'soup')
    await click(byText('button', 'Log it by hand instead'))
    expect(s.el.querySelector('input[placeholder="Name (optional)"]').value).toBe('soup')
    expect(m.api.analyze).not.toHaveBeenCalled()
  })
})


const HEALTH = { active_kcal: 640, resting_kcal: 1670, steps: 8000, burned_kcal: 2310, updatedAt: new Date(2020, 0, 5, 14, 5).getTime() }

describe('Apple Health in the diary', () => {
  it('without numbers: a short hint that leads to the setup, not zeros', async () => {
    await mount(<Diary />)
    expect(text()).toContain('No Apple Health numbers for this day')
    expect(text()).not.toContain('Burned')
    expect(text()).not.toMatch(/Net\s*0/)
    await click(byText('button', 'No Apple Health numbers for this day'))
    expect(where).toBe('/nutrition/health')
  })

  it('with numbers: eaten, burned and net, how burned is made up, and when it arrived', async () => {
    m.api.getDay.mockResolvedValue(dayOf({ health: HEALTH }))
    await mount(<Diary />)
    const t = text()
    expect(t).toContain('Eaten'); expect(t).toContain('Burned'); expect(t).toContain('Net')
    expect(t).toMatch(/2,?310/)                       // burned = 640 + 1,670
    expect(t).toContain('−1,360'.replace(',', (1000).toLocaleString().charAt(1) || ','))   // net = 950 − 2,310
    expect(t).toMatch(/Active 640 \+ resting 1,?670/)
    expect(t).toMatch(/8,?000 steps/)
    expect(t).toContain('Net is eaten − burned')
    expect(t).toMatch(/Updated .*(14:05|2:05)/)       // it was a different day, so the date comes with the time
    expect(t).not.toContain('No Apple Health numbers')
  })

  it('a day with more eaten than burned has a plus sign, not a verdict', async () => {
    m.api.getDay.mockResolvedValue(dayOf({ health: { ...HEALTH, active_kcal: 100, resting_kcal: 800 }, totals: { calories: 1500, protein_g: 50, carbs_g: 110, fat_g: 25 } }))
    await mount(<Diary />)
    expect(text()).toContain('+600')
  })

  it('never talks about dieting, deficits or weight loss', async () => {
    m.api.getDay.mockResolvedValue(dayOf({ health: HEALTH }))
    await mount(<Diary />)
    expect(text()).not.toMatch(/deficit|surplus|diet|lose weight|weight loss|fat loss|medical|doctor|healthy|unhealthy|should/i)
  })

  it('eat back: off leaves the goal alone', async () => {
    m.api.getDay.mockResolvedValue(dayOf({ health: HEALTH, eatBack: { enabled: false, percent: 50 } }))
    await mount(<Diary />)
    expect(text()).toMatch(/\/ 2,?400/)
    expect(text()).not.toContain('of active calories')
  })

  it('eat back: on adds the percentage of ACTIVE calories, labelled with exactly what was added, and "left" follows the new goal', async () => {
    m.api.getDay.mockResolvedValue(dayOf({ health: HEALTH, eatBack: { enabled: true, percent: 50 } }))
    await mount(<Diary />)
    expect(text()).toMatch(/\/ 2,?720/)                                   // 2,400 + 50% of 640
    expect(text()).toMatch(/Goal 2,?400 \+ 320 \(50% of active calories\)/)
    expect(text()).toMatch(/1,?770/)                                      // 2,720 − 950 left
  })

  it('eat back is on but this day has no numbers: the normal goal, and a line that says why', async () => {
    m.api.getDay.mockResolvedValue(dayOf({ health: null, eatBack: { enabled: true, percent: 50 } }))
    await mount(<Diary />)
    expect(text()).toMatch(/\/ 2,?400/)
    expect(text()).toContain('Eat back is on; waiting for Apple Health numbers')
  })

  it('no goal set: the energy block still shows', async () => {
    m.api.getDay.mockResolvedValue(dayOf({ goals: null, health: HEALTH }))
    await mount(<Diary />)
    expect(text()).toContain('Burned')
  })
})

describe('Apple Health screen', () => {
  const cfgWith = health => m.api.getConfig.mockResolvedValue({ ai: { limit: 30, used: 0, remaining: 30, available: true }, health })
  const TOKEN = 'ogh_0123456789abcdef_' + 'ab'.repeat(32)

  it('with no token: says so, makes one, shows it ONCE with copy buttons, and the page itself never shows it', async () => {
    cfgWith({ set: false, createdAt: null, lastUsedAt: null, hint: null, eatBack: { enabled: false, percent: 50 } })
    await mount(<Health />)
    expect(text()).toContain('No token yet')
    m.api.createHealthToken.mockResolvedValue({ token: TOKEN, createdAt: 1, rotated: false, hint: '…cdef' })
    cfgWith({ set: true, createdAt: Date.now(), lastUsedAt: null, hint: '…cdef', eatBack: { enabled: false, percent: 50 } })
    await click(byText('button', 'Make a token'))
    expect(m.api.createHealthToken).toHaveBeenCalledTimes(1)
    const s = await showSheet()
    expect(s.el.textContent).toContain('only time it is shown')
    expect(s.el.querySelector('textarea').value).toBe(TOKEN)
    await click(byText('button', 'Copy header value (Bearer …)'))
    expect(m.copy).toHaveBeenLastCalledWith('Bearer ' + TOKEN)
    await click(byText('button', 'Copy the token only'))
    expect(m.copy).toHaveBeenLastCalledWith(TOKEN)
    // After the sheet, the page knows a token exists, by its hint only.
    const page = host.querySelector('.narrow').textContent          // the page itself, not the sheet the harness appended
    expect(page).toContain('Token …cdef')
    expect(page).not.toContain(TOKEN.slice(-20))
  })

  it('with a token: when it was last used, rotate and revoke each ask first', async () => {
    cfgWith({ set: true, createdAt: new Date(2026, 9, 1, 9, 0).getTime(), lastUsedAt: new Date(2026, 9, 12, 14, 5).getTime(), hint: '…cdef', eatBack: { enabled: false, percent: 50 } })
    await mount(<Health />)
    expect(text()).toContain('Token …cdef')
    expect(text()).toMatch(/Last used .*14:05/)
    await click(byText('button', 'Revoke'))
    expect(m.confirm).toHaveBeenCalledTimes(1)
    expect(m.api.revokeHealthToken).not.toHaveBeenCalled()
    m.api.revokeHealthToken.mockResolvedValue({ revoked: true })
    cfgWith({ set: false, createdAt: null, lastUsedAt: null, hint: null, eatBack: { enabled: false, percent: 50 } })
    await act(async () => { await m.confirm.mock.calls[0][0].onConfirm() }); await flush()
    expect(m.api.revokeHealthToken).toHaveBeenCalled()
    expect(text()).toContain('No token yet')

    cfgWith({ set: true, createdAt: 1, lastUsedAt: null, hint: '…cdef', eatBack: { enabled: false, percent: 50 } })
    act(() => root.unmount()); root = createRoot(host); m.confirm.mockReset()
    await mount(<Health />)
    expect(text()).toContain('Never used yet')
    await click(byText('button', 'Make a new token'))
    expect(m.confirm).toHaveBeenCalledTimes(1)
    expect(m.confirm.mock.calls[0][0].message).toContain('stops working immediately')
    expect(m.api.createHealthToken).not.toHaveBeenCalled()
  })

  it('eat back is off by default, switches on with a percentage, and a failed save rolls back', async () => {
    cfgWith({ set: false, createdAt: null, lastUsedAt: null, hint: null, eatBack: { enabled: false, percent: 50 } })
    await mount(<Health />)
    expect(host.querySelector('[role="switch"]').getAttribute('aria-checked')).toBe('false')
    expect(text()).not.toContain('Share of active calories')
    m.api.putHealthSettings.mockResolvedValue({ eatBack: { enabled: true, percent: 50 } })
    await click(host.querySelector('[role="switch"]'))
    expect(m.api.putHealthSettings).toHaveBeenCalledWith({ enabled: true, percent: 50 })
    expect(text()).toContain('Share of active calories')
    expect(text()).toContain('50% of today’s active calories is added to the goal')
    m.api.putHealthSettings.mockRejectedValue(new Error('offline'))
    await click(host.querySelector('[role="switch"]'))
    expect(m.toast).toHaveBeenCalledWith('offline')
    expect(host.querySelector('[role="switch"]').getAttribute('aria-checked')).toBe('true')       // back to what it was
  })

  it('the setup section gives the address, the JSON, the steps, the guide link and the honest reliability note', async () => {
    cfgWith({ set: true, createdAt: 1, lastUsedAt: null, hint: '…cdef', eatBack: { enabled: false, percent: 50 } })
    await mount(<Health />)
    expect(text()).toContain(location.origin + '/api/nutrition/health')
    expect(text()).toContain('"active_kcal": 512')
    expect(host.querySelectorAll('.nut-steps li').length).toBeGreaterThanOrEqual(6)
    expect(text()).toContain('Get Contents of URL')
    const link = host.querySelector('a[href*="NUTRITION_APPLE_HEALTH.md"]')
    expect(link).toBeTruthy(); expect(link.target).toBe('_blank'); expect(link.rel).toContain('noopener')
    expect(text()).toMatch(/best effort/)
    expect(text()).toMatch(/locked/)
    await click([...host.querySelectorAll('button')].filter(b => b.textContent === 'Copy')[1])      // the Shortcut section's address (the first is Health Auto Export's)
    expect(m.copy).toHaveBeenCalledWith(location.origin + '/api/nutrition/health')
  })

  it('a server error is shown, not swallowed', async () => {
    m.api.getConfig.mockRejectedValue(new Error('HTTP 500'))
    await mount(<Health />)
    expect(text()).toContain('HTTP 500')
  })

  it('Goals links to it', async () => {
    m.api.getGoals.mockResolvedValue({ goals: null })
    await mount(<Goals />)
    await click(byText('button', 'Apple Health'))
    expect(where).toBe('/nutrition/health')
  })
})

describe('Home card, router, goals, foods', () => {
  it('home card shows today against the goal', async () => {
    await mount(<NutritionHomeCard />)
    expect(text()).toContain('Nutrition')
    expect(text()).toMatch(/950/)
    await click(host.querySelector('.card'))
    expect(where).toBe('/nutrition')
  })

  it('home card disappears when nutrition is off, and stays friendly when the server is down', async () => {
    m.api.getDay.mockRejectedValue(Object.assign(new Error('off'), { data: { code: 'off' } }))
    await mount(<NutritionHomeCard />)
    expect(host.querySelector('.card')).toBeNull()
    act(() => root.unmount()); root = createRoot(host)
    m.api.getDay.mockRejectedValue(new Error('network'))
    await mount(<NutritionHomeCard />)
    expect(text()).toContain('Food & macros')
  })

  it('a guest is sent home instead of to a diary that cannot exist', async () => {
    m.user = null
    await mount(<Routes><Route path="/nutrition/*" element={<Nutrition />} /><Route path="/home" element={<div>home</div>} /></Routes>, '/nutrition')
    expect(where).toBe('/home')
    expect(m.api.getDay).not.toHaveBeenCalled()
  })

  it('goals: loads, saves the four targets, and returns to the diary', async () => {
    m.api.getGoals.mockResolvedValue({ goals: { calories: 2000, protein_g: null, carbs_g: null, fat_g: null } })
    m.api.putGoals.mockResolvedValue({})
    await mount(<Routes><Route path="/nutrition/goals" element={<Goals />} /><Route path="/nutrition" element={<div>diary</div>} /></Routes>, '/nutrition/goals')
    const inputs = host.querySelectorAll('.nut-input input')
    expect(inputs[0].value).toBe('2000')
    await setValue(inputs[1], '150')
    expect(text()).toContain('600')   // macros add up to 600 kcal vs a 2000 goal
    await click(byText('button', 'Save goals'))
    expect(m.api.putGoals).toHaveBeenCalledWith({ calories: 2000, protein_g: 150, carbs_g: null, fat_g: null })
    expect(where).toBe('/nutrition')
  })

  it('goals: the admin section is for admins only', async () => {
    m.api.getGoals.mockResolvedValue({ goals: null })
    m.api.getAdmin.mockResolvedValue({ enabled: true, aiDailyCap: 30, aiCapMax: 500, aiCapDefault: 30 })
    await mount(<Goals />)
    expect(m.api.getAdmin).not.toHaveBeenCalled()
    act(() => root.unmount()); root = createRoot(host)
    m.user = { id: 'a', admin: true }
    await mount(<Goals />)
    expect(text()).toContain('AI analyses per day')
    m.api.putAdmin.mockResolvedValue({ enabled: true, aiDailyCap: 12, aiCapMax: 500, aiCapDefault: 30 })
    await setValue(host.querySelector('.nut-cap input'), '12')
    await click(byText('button', 'Save'))
    expect(m.api.putAdmin).toHaveBeenCalledWith({ aiDailyCap: 12 })
  })

  it('Coach sharing: shown only when there is a Coach, off by default, says what leaves, and toggles', async () => {
    m.api.getGoals.mockResolvedValue({ goals: null })
    m.api.getConfig.mockResolvedValue({ ai: { limit: 30, used: 0, remaining: 30, available: true }, coach: { available: false, share: false } })
    await mount(<Goals />)
    expect(text()).not.toContain('Share a food summary')
    act(() => root.unmount()); root = createRoot(host)
    m.api.getConfig.mockResolvedValue({ ai: { limit: 30, used: 0, remaining: 30, available: true }, coach: { available: true, share: false } })
    m.api.setCoachShare.mockResolvedValue({ share: true })
    await mount(<Goals />)
    expect(text()).toContain('Share a food summary with the Coach')
    expect(text()).toContain('No food names, brands, notes or photos')
    expect(text()).toContain('never change your food log')
    expect(host.querySelector('[role="switch"]').getAttribute('aria-checked')).toBe('false')
    await click(host.querySelector('[role="switch"]'))
    expect(m.api.setCoachShare).toHaveBeenCalledWith(true)
    expect(host.querySelector('[role="switch"]').getAttribute('aria-checked')).toBe('true')
  })

  it('admin USDA card: explains how to get a key, saves it, tests it, and can remove it', async () => {
    m.user = { id: 'a', admin: true }
    m.api.getGoals.mockResolvedValue({ goals: null })
    m.api.getAdmin.mockResolvedValue({ enabled: true, aiDailyCap: 30, aiCapMax: 500, aiCapDefault: 30, usdaKeySet: false, usdaKeyHint: null })
    await mount(<Goals />)
    expect(text()).toContain('No key set')
    expect(text()).toContain('Open Food Facts only')
    const link = host.querySelector('a[href="https://fdc.nal.usda.gov/api-key-signup"]')
    expect(link).toBeTruthy()
    expect(link.rel).toContain('noopener')
    const input = host.querySelector('input[type="password"]')
    const save = [...host.querySelectorAll('button')].filter(b => b.textContent === 'Save').at(-1)
    expect(save.disabled).toBe(true)
    m.api.putAdmin.mockResolvedValue({ enabled: true, aiDailyCap: 30, aiCapMax: 500, aiCapDefault: 30, usdaKeySet: true, usdaKeyHint: '…5678' })
    await setValue(input, '  abcd1234EFGH5678 ')
    await click([...host.querySelectorAll('button')].filter(b => b.textContent === 'Save').at(-1))
    expect(m.api.putAdmin).toHaveBeenCalledWith({ usdaKey: 'abcd1234EFGH5678' })
    expect(text()).toContain('Key set (…5678)')
    m.api.testUsda.mockResolvedValue({ ok: false, error: 'USDA FoodData Central rejected the API key', kind: 'auth', ms: 80 })
    await click(byText('button', 'Test key'))
    expect(text()).toContain('rejected the API key')
    m.api.putAdmin.mockResolvedValue({ enabled: true, aiDailyCap: 30, aiCapMax: 500, aiCapDefault: 30, usdaKeySet: false, usdaKeyHint: null })
    await click(byText('button', 'Remove key'))
    expect(m.api.putAdmin).toHaveBeenLastCalledWith({ usdaKey: '' })
    expect(text()).toContain('No key set')
  })

  it('foods: lists by scope, stars a food', async () => {
    const f = { id: 'f1', name: 'Shake', brand: '', source: 'custom', favorite: false, serving: { label: '1 scoop', grams: 30 }, per: { calories: 120, protein_g: 24, carbs_g: 3, fat_g: 1.5 } }
    m.api.listFoods.mockResolvedValue({ foods: [f] })
    m.api.updateFood.mockResolvedValue({})
    await mount(<Foods />)
    expect(text()).toContain('Shake')
    await click(host.querySelector('[aria-label="Add to favourites"]'))
    expect(m.api.updateFood).toHaveBeenCalledWith('f1', { favorite: true })
    await click(byText('button', 'Favourites'))
    expect(m.api.listFoods).toHaveBeenLastCalledWith('favorite', '')
  })
})

describe('Health Auto Export in the app', () => {
  const WORKOUTS = [
    { name: 'Running', time: '07:05', duration_min: 30, kcal: 250, km: 5.2 },
    { name: 'Traditional Strength Training', time: '18:30', duration_min: 45, kcal: 320, km: null }
  ]

  it('the diary lists the day’s workouts and exercise minutes, and does not add their calories to Burned or Net', async () => {
    m.api.getDay.mockResolvedValue(dayOf({ health: HEALTH, activity: { exercise_min: 52, workouts: WORKOUTS, updatedAt: 1 } }))
    await mount(<Diary />)
    const t = text()
    expect(t).toContain('Running, 30 min, 250 kcal, 5.2 km')
    expect(t).toContain('Traditional Strength Training, 45 min, 320 kcal')
    expect(t).toContain('52 exercise min')
    expect(t).toContain('already inside Active')
    expect(t).toMatch(/2,?310/)                                       // Burned is still 640 + 1,670
    expect(t).not.toMatch(/2,?880/)                                   // 2,310 + 250 + 320 would be the double count
    expect(t).toContain('−1,360'.replace(',', (1000).toLocaleString().charAt(1) || ','))   // Net unchanged
  })

  it('a day with workouts but no energy numbers shows the workouts and no Burned', async () => {
    m.api.getDay.mockResolvedValue(dayOf({ health: null, activity: { exercise_min: null, workouts: [WORKOUTS[1]], updatedAt: 1 } }))
    await mount(<Diary />)
    expect(text()).toContain('Traditional Strength Training, 45 min, 320 kcal')
    expect(text()).not.toContain('Burned')
  })

  it('no activity: no workouts card', async () => {
    await mount(<Diary />)
    expect(text()).not.toContain('exercise min')
    expect(text()).not.toContain('Workouts')
  })

  it('weight: with no data, a hint that leads to the setup', async () => {
    await mount(<Diary />)
    expect(text()).toContain('No weight from Apple Health yet')
    await click(byText('button', 'No weight from Apple Health yet'))
    expect(where).toBe('/nutrition/health')
  })

  it('weight: the latest reading, in the profile’s unit, with a 30-day line and the change', async () => {
    m.api.getWeight.mockResolvedValue({ latest: { date: '2026-10-12', kg: 80 }, readings: [{ date: '2026-09-20', kg: 82 }, { date: '2026-10-01', kg: 81 }, { date: '2026-10-12', kg: 80 }], count: 3 })
    await mount(<Diary />)
    expect(text()).toContain('80 kg')
    expect(text()).toContain('−2 kg in 30 days')
    expect(host.querySelector('svg[aria-label="Weight, last 30 days"] path').getAttribute('d')).toMatch(/^M/)
    expect(m.api.getWeight).toHaveBeenCalledWith(today)
    act(() => root.unmount()); root = createRoot(host); m.unit = 'lb'
    await mount(<Diary />)
    expect(text()).toContain('176.4 lb')
    expect(text()).toMatch(/−4\.4 lb in 30 days/)
  })

  it('weight: one reading is a value without a line; a failing weight call hides the card and never breaks the diary', async () => {
    m.api.getWeight.mockResolvedValue({ latest: { date: '2026-10-12', kg: 80 }, readings: [{ date: '2026-10-12', kg: 80 }], count: 1 })
    await mount(<Diary />)
    expect(text()).toContain('A line appears with two readings')
    act(() => root.unmount()); root = createRoot(host)
    m.api.getWeight.mockRejectedValue(new Error('HTTP 500'))
    await mount(<Diary />)
    expect(text()).toContain('Oats')
    expect(text()).not.toContain('No weight from Apple Health')
  })

  it('the Health screen shows the exact Health Auto Export address, the metrics to turn on, and the premium note', async () => {
    m.api.getConfig.mockResolvedValue({ ai: { limit: 30, used: 0, remaining: 30, available: true }, health: { set: true, createdAt: 1, lastUsedAt: null, hint: '…cdef', eatBack: { enabled: false, percent: 50 } } })
    await mount(<Health />)
    const t = text()
    expect(t).toContain(location.origin + '/api/nutrition/health/hae')
    for (const metric of ['Active Energy', 'Resting Energy', 'Steps', 'Workouts', 'Exercise Minutes', 'Weight']) expect(t, metric).toContain(metric)
    expect(t).toContain('Automations → + → REST API')
    expect(t).toContain('premium feature')
    expect(t).toContain('$6.99')
    expect(t).toContain('Manual Export')
    await click([...host.querySelectorAll('button')].filter(b => b.textContent === 'Copy')[0])
    expect(m.copy).toHaveBeenLastCalledWith(location.origin + '/api/nutrition/health/hae')
    // The HAE section comes before the Shortcut one.
    expect(t.indexOf('Set up Health Auto Export')).toBeLessThan(t.indexOf('Or: set up the Shortcut'))
  })

  it('the debug option is admin only, off by default, and shows the shape once there is one', async () => {
    m.api.getGoals.mockResolvedValue({ goals: null })
    m.api.getConfig.mockResolvedValue({ ai: {}, coach: { available: false } })
    await mount(<Goals />)
    expect(text()).not.toContain('Health Auto Export debug')
    expect(m.api.getHealthDebug).not.toHaveBeenCalled()
    act(() => root.unmount()); root = createRoot(host)
    m.user = { id: 'u1', name: 'Me', admin: true }
    m.api.getAdmin.mockResolvedValue({ enabled: true, aiDailyCap: 30, aiCapMax: 500, aiCapDefault: 30, usdaKeySet: false })
    m.api.getHealthDebug.mockResolvedValue({ enabled: false, capture: null, ttlMinutes: 60 })
    await mount(<Goals />)
    expect(text()).toContain('Health Auto Export debug')
    expect(host.querySelectorAll('[role="switch"]')).toBeTruthy()
    const sw = [...host.querySelectorAll('[role="switch"]')].at(-1)
    expect(sw.getAttribute('aria-checked')).toBe('false')
    m.api.putAdmin.mockResolvedValue({})
    m.api.getHealthDebug.mockResolvedValue({ enabled: true, capture: { at: Date.UTC(2026, 9, 13), shape: { metrics: [{ name: 'weight_body_mass', points: 1 }] }, outcome: { ok: true } }, ttlMinutes: 60 })
    await click(sw)
    expect(m.api.putAdmin).toHaveBeenCalledWith({ healthDebug: true })
    expect(text()).toContain('weight_body_mass')
    expect(text()).toContain('never the token')
  })
})
