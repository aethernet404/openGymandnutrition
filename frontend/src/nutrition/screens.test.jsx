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
  sheets: [],
  downscale: vi.fn(),
  toast: vi.fn(),
  confirm: vi.fn(),
  api: {
    getDay: vi.fn(), getConfig: vi.fn(), addEntries: vi.fn(), updateEntry: vi.fn(), deleteEntry: vi.fn(),
    listFoods: vi.fn(), createFood: vi.fn(), updateFood: vi.fn(), deleteFood: vi.fn(), getGoals: vi.fn(), putGoals: vi.fn(),
    getAdmin: vi.fn(), putAdmin: vi.fn(), getRange: vi.fn(), searchFoods: vi.fn(), lookupBarcode: vi.fn(), testUsda: vi.fn(), analyze: vi.fn(), setCoachShare: vi.fn()
  }
}))

vi.mock('../store/useStore.js', () => {
  const snap = () => ({ user: m.user, S: {} })
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
vi.mock('./image.js', () => ({ downscaleToJpeg: (...a) => m.downscale(...a) }))

const { default: Diary } = await import('./Diary.jsx')
const { default: NutritionHomeCard } = await import('./HomeCard.jsx')
const { default: Nutrition } = await import('./Nutrition.jsx')
const { default: Goals } = await import('./Goals.jsx')
const { default: Foods } = await import('./Foods.jsx')
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
  ...over
})

beforeEach(() => {
  host = document.createElement('div'); document.body.appendChild(host)
  root = createRoot(host)
  m.sheets.length = 0
  shown = []
  m.user = { id: 'u1', name: 'Me', admin: false }
  for (const f of Object.values(m.api)) f.mockReset()
  m.toast.mockReset(); m.confirm.mockReset(); m.downscale.mockReset()
  globalThis.URL.revokeObjectURL = globalThis.URL.revokeObjectURL || (() => {})
  m.api.getDay.mockResolvedValue(dayOf())
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

const NUTELLA = { source: 'off', ext: '3017620422003', name: 'Nutella', brand: 'Ferrero', bases: [
  { label: '15 g', grams: 15, per: { calories: 81, protein_g: 0.9, carbs_g: 8.6, fat_g: 4.6 } },
  { label: '100 g', grams: 100, per: { calories: 539, protein_g: 6.3, carbs_g: 57.5, fat_g: 30.9 } }
] }
const wait = ms => act(async () => { await new Promise(r => setTimeout(r, ms)) })
const found = (results = [NUTELLA], sources = { off: { ok: true, count: results.length }, usda: { ok: false, skipped: 'no-key' } }) => ({ q: 'nutella', results, sources })

describe('search, portions and barcodes', () => {
  async function openSearch() {
    openAddSheet({ date: '2026-10-12', meal: 'snack', onSaved: vi.fn() })
    return showSheet()
  }
  const typeSearch = async (s, v) => { await setValue(s.el.querySelector('input[placeholder="Search foods"]'), v); await wait(520) }

  it('opens on Search, searches after a pause, and says USDA is off when no key is set', async () => {
    m.api.searchFoods.mockResolvedValue(found())
    const s = await openSearch()
    expect(s.el.textContent).toContain('Search Open Food Facts and USDA')
    await typeSearch(s, 'nutella')
    expect(m.api.searchFoods).toHaveBeenCalledTimes(1)
    expect(m.api.searchFoods).toHaveBeenCalledWith('nutella')
    expect(s.el.textContent).toContain('Nutella')
    expect(s.el.textContent).toContain('Ferrero · 15 g')
    expect(s.el.textContent).toContain('an admin has not added a key')
  })

  it('does not search for a single letter, and a fast typist makes one request', async () => {
    m.api.searchFoods.mockResolvedValue(found())
    const s = await openSearch()
    await setValue(s.el.querySelector('input[placeholder="Search foods"]'), 'n')
    await wait(520)
    expect(m.api.searchFoods).not.toHaveBeenCalled()
    await setValue(s.el.querySelector('input[placeholder="Search foods"]'), 'nu')
    await setValue(s.el.querySelector('input[placeholder="Search foods"]'), 'nut')
    await setValue(s.el.querySelector('input[placeholder="Search foods"]'), 'nutella')
    await wait(520)
    expect(m.api.searchFoods).toHaveBeenCalledTimes(1)
  })

  it('shows where to fix a missing USDA key to an admin', async () => {
    m.user = { id: 'a', admin: true }
    m.api.searchFoods.mockResolvedValue(found())
    const s = await openSearch()
    await typeSearch(s, 'nutella')
    expect(s.el.textContent).toContain('Goals → Admin')
  })

  it('a source that is down is named, the other results still show, and Try again searches again', async () => {
    m.api.searchFoods.mockResolvedValue(found([NUTELLA], { off: { ok: false, kind: 'timeout', error: 'Open Food Facts did not answer in time' }, usda: { ok: true, count: 1 } }))
    const s = await openSearch()
    await typeSearch(s, 'nutella')
    expect(s.el.textContent).toContain('Open Food Facts did not answer in time')
    expect(s.el.textContent).toContain('Nutella')
    await click(byText('button', 'Try again'))
    expect(m.api.searchFoods).toHaveBeenCalledTimes(2)
  })

  it('a failed search shows the reason instead of an empty list; a 429 is worded kindly', async () => {
    m.api.searchFoods.mockRejectedValue(Object.assign(new Error('HTTP 429'), { status: 429 }))
    const s = await openSearch()
    await typeSearch(s, 'nutella')
    expect(s.el.textContent).toContain('Too many lookups')
    expect(s.el.textContent).not.toContain('Nothing found')
  })

  it('pick a hit, choose the 100 g portion, set grams, and the entry carries the snapshot and qty', async () => {
    m.api.searchFoods.mockResolvedValue(found())
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
    const pot = { source: 'usda', ext: '9', name: 'Yogurt', brand: '', bases: [{ label: '1 pot', grams: null, per: { calories: 90, protein_g: 5, carbs_g: 12, fat_g: 2 } }] }
    m.api.searchFoods.mockResolvedValue(found([pot]))
    const s = await openSearch()
    await typeSearch(s, 'yogurt')
    await click(byText('.nut-pick', 'Yogurt'))
    expect(s.el.querySelector('.nut-datefield')).toBeNull()
    expect(s.el.textContent).toContain('One serving: 1 pot')
  })

  it('without a camera scanner the barcode button offers typing; a bad number is refused before any request', async () => {
    const s = await openSearch()
    await click(s.el.querySelector('[aria-label="Scan a barcode"]'))
    expect(s.el.textContent).toContain("can't scan barcodes with the camera")
    await setValue(s.el.querySelector('input[placeholder="Barcode number"]'), '12ab')
    await click(byText('button', 'Look up'))
    expect(m.toast).toHaveBeenCalledWith('A barcode is 8 to 14 digits.')
    expect(m.api.lookupBarcode).not.toHaveBeenCalled()
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
